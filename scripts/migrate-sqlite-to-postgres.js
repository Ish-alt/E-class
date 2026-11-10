"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const tables = [
  ["users", ["id", "name", "email", "role", "password_salt", "password_hash", "created_at"]],
  ["sessions", ["token_hash", "user_id", "expires_at"]],
  ["classrooms", ["id", "teacher_id", "name", "subject", "join_code", "color", "created_at"]],
  ["enrollments", ["classroom_id", "student_id", "joined_at"]],
  ["class_join_requests", ["id", "classroom_id", "student_id", "status", "requested_at", "decided_at"]],
  ["assignments", ["id", "classroom_id", "title", "instructions", "due_date", "points", "created_at"]],
  ["submissions", ["id", "assignment_id", "student_id", "content", "submitted_at", "grade", "feedback", "graded_at"]],
];

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Set DATABASE_URL to the Supabase PostgreSQL connection string.");

  const sourcePath = process.env.SQLITE_DATABASE_PATH || path.join(__dirname, "..", "data", "classroom.sqlite");
  if (!fs.existsSync(sourcePath)) throw new Error("SQLite database not found: " + sourcePath);

  const source = new DatabaseSync(sourcePath);
  const target = new Pool({ connectionString, max: 1 });
  let client;
  let transactionOpen = false;
  let sourceTransactionOpen = false;
  try {
    client = await target.connect();
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    await client.query(schema);
    for (const [table] of tables) {
      const count = await client.query('SELECT COUNT(*)::integer AS count FROM "' + table + '"');
      if (count.rows[0].count > 0) {
        throw new Error("The Supabase " + table + " table is not empty. Refusing to merge or overwrite data.");
      }
    }

    source.exec("BEGIN");
    sourceTransactionOpen = true;
    const sourceRows = new Map(tables.map(([table, columns]) => [
      table,
      source.prepare('SELECT "' + columns.join('", "') + '" FROM "' + table + '"').all(),
    ]));
    source.exec("COMMIT");
    sourceTransactionOpen = false;

    await client.query("BEGIN");
    transactionOpen = true;
    for (const [table, columns] of tables) {
      const rows = sourceRows.get(table);
      if (!rows.length) continue;
      const columnList = columns.map((column) => '"' + column + '"').join(", ");
      const placeholders = columns.map((_column, index) => "$" + (index + 1)).join(", ");
      const insert = "INSERT INTO \"" + table + "\" (" + columnList + ") VALUES (" + placeholders + ")";
      for (const row of rows) {
        await client.query(insert, columns.map((column) => row[column]));
      }
      console.log("Imported " + rows.length + " " + table + ".");
    }
    await client.query("COMMIT");
    transactionOpen = false;
    console.log("SQLite data migration completed.");
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    if (sourceTransactionOpen) source.exec("ROLLBACK");
    throw error;
  } finally {
    source.close();
    if (client) client.release();
    await target.end();
  }
}

migrate().catch(function (error) {
  console.error("SQLite migration failed:", error.message);
  process.exitCode = 1;
});
