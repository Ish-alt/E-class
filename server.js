"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_NAME = "classroom_session";
const SESSION_DAYS = 14;
const MAX_BODY_BYTES = 24 * 1024;
const accountIdPattern = /^[A-Z]{2}-\d{2}-[A-Z]{2}$/;
const dataDirectory = process.env.DATA_DIRECTORY || path.join(__dirname, "data");
const postgresConnectionString = process.env.DATABASE_URL;
let database;
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const colors = ["lilac", "mint", "peach", "sky"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const rateBuckets = new Map();
const fixedWindowLimiter = createRateLimiter();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "script-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "upgrade-insecure-requests": isProduction ? [] : null,
    },
  },
}));
app.use(express.json({ limit: MAX_BODY_BYTES }));
app.use("/api", fixedWindowLimiter);
app.use("/api", requireSameOrigin);

app.get("/api/health", function (_request, response) {
  response.json({ status: "ok" });
});

app.post("/api/auth/register", async function (request, response, next) {
  try {
    const name = cleanText(request.body.name, 80);
    const email = cleanText(request.body.email, 254).toLowerCase();
    const password = typeof request.body.password === "string" ? request.body.password : "";
    const role = request.body.role;

    if (name.length < 2) throw httpError(400, "Enter your name (at least 2 characters).");
    if (!emailPattern.test(email)) throw httpError(400, "Enter a valid email address.");
    if (password.length < 10 || password.length > 200) throw httpError(400, "Password must be between 10 and 200 characters.");
    if (role !== "teacher" && role !== "student") throw httpError(400, "Choose teacher or student.");
    if (await database.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
      throw httpError(409, "An account with that email already exists.");
    }

    const salt = crypto.randomBytes(16);
    const passwordHash = crypto.scryptSync(password, salt, 64);
    const user = {
      id: await generateAccountId(async (id) => Boolean(await database.prepare("SELECT 1 FROM users WHERE id = ?").get(id))),
      name,
      email,
      role,
      passwordSalt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
      createdAt: new Date().toISOString(),
    };
    try {
      await database.prepare(`
        INSERT INTO users (id, name, email, role, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, user.name, user.email, user.role, user.passwordSalt, user.passwordHash, user.createdAt);
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw httpError(409, "An account with that email already exists.");
      throw error;
    }
    await createSession(response, user.id);
    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async function (request, response, next) {
  try {
    const accountId = cleanText(request.body.accountId, 8).toUpperCase();
    const password = typeof request.body.password === "string" ? request.body.password : "";
    const user = await database.prepare("SELECT * FROM users WHERE id = ?").get(accountId);
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw httpError(401, "Classroom ID or password is incorrect.");
    }
    await createSession(response, user.id);
    response.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireUser, async function (request, response) {
  await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(request.sessionHash);
  clearSessionCookie(response);
  response.status(204).end();
});

app.get("/api/auth/me", async function (request, response) {
  const user = await findSessionUser(request);
  response.json({ user: user ? publicUser(user) : null });
});

app.put("/api/auth/profile", requireUser, async function (request, response, next) {
  try {
    const name = cleanText(request.body.name, 80);
    const email = cleanText(request.body.email, 254).toLowerCase();
    const currentPassword = typeof request.body.currentPassword === "string" ? request.body.currentPassword : "";
    const newPassword = typeof request.body.newPassword === "string" ? request.body.newPassword : "";
    if (name.length < 2) throw httpError(400, "Enter your name (at least 2 characters).");
    if (!emailPattern.test(email)) throw httpError(400, "Enter a valid email address.");
    if (!verifyPassword(currentPassword, request.user.password_salt, request.user.password_hash)) {
      throw httpError(401, "Your current password is incorrect.");
    }
    if (newPassword && (newPassword.length < 10 || newPassword.length > 200)) {
      throw httpError(400, "New password must be between 10 and 200 characters.");
    }
    const emailOwner = await database.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, request.user.id);
    if (emailOwner) throw httpError(409, "That email address is already in use.");
    try {
      if (newPassword) {
        const salt = crypto.randomBytes(16);
        const passwordHash = crypto.scryptSync(newPassword, salt, 64);
        await database.prepare(`
          UPDATE users SET name = ?, email = ?, password_salt = ?, password_hash = ? WHERE id = ?
        `).run(name, email, salt.toString("hex"), passwordHash.toString("hex"), request.user.id);
      } else {
        await database.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name, email, request.user.id);
      }
    } catch (error) {
      if (isEmailUniqueViolation(error)) throw httpError(409, "That email address is already in use.");
      throw error;
    }
    const updatedUser = await database.prepare("SELECT * FROM users WHERE id = ?").get(request.user.id);
    response.json({ user: publicUser(updatedUser) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", requireUser, async function (request, response, next) {
  try {
    const classrooms = await getClassroomsForUser(request.user);
    const assignments = [];
    for (const classroom of classrooms) {
      const rows = await database.prepare(`
        SELECT a.id, a.classroom_id AS classroomId, a.title, a.instructions,
               a.due_date AS dueDate, a.points, a.created_at AS createdAt,
               s.id AS submissionId, s.content AS submissionContent,
               s.submitted_at AS submittedAt, s.grade, s.feedback
        FROM assignments a
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
        WHERE a.classroom_id = ?
        ORDER BY a.due_date ASC, a.created_at DESC
      `).all(request.user.id, classroom.id);
      assignments.push(...rows.map((row) => ({
        ...row,
        submission: row.submissionId ? {
          id: row.submissionId,
          content: row.submissionContent,
          submittedAt: row.submittedAt,
          grade: row.grade,
          feedback: row.feedback,
        } : null,
        submissionId: undefined,
        submissionContent: undefined,
        submittedAt: undefined,
        grade: undefined,
        feedback: undefined,
      })));
    }
    const submissions = request.user.role === "teacher"
      ? await database.prepare(`
        SELECT s.id, s.assignment_id AS assignmentId, s.student_id AS studentId,
               u.name AS studentName, u.email AS studentEmail,
               s.content, s.submitted_at AS submittedAt, s.grade, s.feedback,
               a.title AS assignmentTitle, a.points, a.classroom_id AS classroomId
        FROM submissions s JOIN users u ON u.id = s.student_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN classrooms c ON c.id = a.classroom_id
        WHERE c.teacher_id = ?
        ORDER BY s.submitted_at DESC
      `).all(request.user.id)
      : [];
    const joinRequests = request.user.role === "student"
      ? await database.prepare(`
        SELECT r.id, r.classroom_id AS classroomId, r.status, r.requested_at AS requestedAt,
               c.name AS classroomName, c.subject, u.name AS teacherName
        FROM class_join_requests r
        JOIN classrooms c ON c.id = r.classroom_id
        JOIN users u ON u.id = c.teacher_id
        WHERE r.student_id = ? AND r.status = 'pending'
        ORDER BY r.requested_at DESC
      `).all(request.user.id)
      : [];
    response.json({
      user: publicUser(request.user),
      classrooms,
      assignments,
      submissions,
      joinRequests,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const name = cleanText(request.body.name, 100);
    const subject = cleanText(request.body.subject, 80);
    if (name.length < 2 || subject.length < 2) throw httpError(400, "Enter a class name and subject.");
    const classroom = {
      id: crypto.randomUUID(),
      teacherId: request.user.id,
      name,
      subject,
      joinCode: await createJoinCode(),
      color: colors[Math.floor(Math.random() * colors.length)],
      createdAt: new Date().toISOString(),
    };
    await database.prepare(`
      INSERT INTO classrooms (id, teacher_id, name, subject, join_code, color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(classroom.id, classroom.teacherId, classroom.name, classroom.subject, classroom.joinCode, classroom.color, classroom.createdAt);
    response.status(201).json({ classroom: serializeClassroom(classroom, 0, true) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/join", requireUser, requireRole("student"), async function (request, response, next) {
  try {
    const joinCode = cleanText(request.body.joinCode, 12).toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(joinCode)) throw httpError(400, "Enter a valid 6-character class code.");
    const classroom = await database.prepare("SELECT * FROM classrooms WHERE join_code = ?").get(joinCode);
    if (!classroom) throw httpError(404, "We couldn't find a class with that code.");
    if (await database.prepare("SELECT 1 FROM enrollments WHERE classroom_id = ? AND student_id = ?").get(classroom.id, request.user.id)) {
      throw httpError(409, "You have already joined this class.");
    }
    const existing = await database.prepare("SELECT id, status FROM class_join_requests WHERE classroom_id = ? AND student_id = ?")
      .get(classroom.id, request.user.id);
    if (existing && existing.status === "pending") throw httpError(409, "Your request is already waiting for teacher approval.");
    if (existing) {
      await database.prepare("UPDATE class_join_requests SET status = 'pending', requested_at = ?, decided_at = NULL WHERE id = ?")
        .run(new Date().toISOString(), existing.id);
      response.status(202).json({ status: "pending", classroom: serializeClassroom(classroom, 0, false) });
      return;
    }
    await database.prepare(`
      INSERT INTO class_join_requests (id, classroom_id, student_id, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(crypto.randomUUID(), classroom.id, request.user.id, new Date().toISOString());
    response.status(202).json({ status: "pending", classroom: serializeClassroom(classroom, 0, false) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/classrooms/:id/join-requests", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const requests = await database.prepare(`
      SELECT r.id, r.student_id AS studentId, u.name AS studentName, u.email AS studentEmail,
             r.requested_at AS requestedAt
      FROM class_join_requests r JOIN users u ON u.id = r.student_id
      WHERE r.classroom_id = ? AND r.status = 'pending'
      ORDER BY r.requested_at ASC
    `).all(classroom.id);
    response.json({ requests });
  } catch (error) {
    next(error);
  }
});

app.put("/api/classrooms/:id/join-requests/:requestId", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const joinRequest = await database.prepare(`
      SELECT r.id, r.classroom_id AS classroomId, r.student_id AS studentId
      FROM class_join_requests r JOIN classrooms c ON c.id = r.classroom_id
      WHERE r.id = ? AND r.classroom_id = ? AND c.teacher_id = ? AND r.status = 'pending'
    `).get(request.params.requestId, request.params.id, request.user.id);
    if (!joinRequest) throw httpError(404, "Pending join request not found.");
    const decision = request.body.decision;
    if (decision !== "approve" && decision !== "decline") throw httpError(400, "Choose approve or decline.");
    const decidedAt = new Date().toISOString();
    await database.transaction(async function (transaction) {
      await transaction.prepare("UPDATE class_join_requests SET status = ?, decided_at = ? WHERE id = ?")
        .run(decision === "approve" ? "approved" : "declined", decidedAt, joinRequest.id);
      if (decision === "approve") {
        await transaction.prepare("INSERT INTO enrollments (classroom_id, student_id, joined_at) VALUES (?, ?, ?)")
          .run(joinRequest.classroomId, joinRequest.studentId, decidedAt);
      }
    });
    response.json({ status: decision === "approve" ? "approved" : "declined" });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/classrooms/:id/students/:studentId", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const result = await database.prepare("DELETE FROM enrollments WHERE classroom_id = ? AND student_id = ?")
      .run(classroom.id, request.params.studentId);
    if (result.changes === 0) throw httpError(404, "Student is not enrolled in this class.");
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/classrooms/:id", requireUser, async function (request, response, next) {
  try {
    if (request.user.role === "teacher") {
      const result = await database.prepare("DELETE FROM classrooms WHERE id = ? AND teacher_id = ?")
        .run(request.params.id, request.user.id);
      if (result.changes === 0) throw httpError(404, "Classroom not found.");
    } else {
      const result = await database.prepare("DELETE FROM enrollments WHERE classroom_id = ? AND student_id = ?")
        .run(request.params.id, request.user.id);
      if (result.changes === 0) throw httpError(404, "Class membership was not found.");
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/classrooms/:id/submissions", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT * FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const submissions = await database.prepare(`
      SELECT s.id, s.assignment_id AS assignmentId, s.student_id AS studentId,
             u.name AS studentName, s.content, s.submitted_at AS submittedAt,
             s.grade, s.feedback, a.title AS assignmentTitle, a.points
      FROM submissions s
      JOIN users u ON u.id = s.student_id
      JOIN assignments a ON a.id = s.assignment_id
      WHERE a.classroom_id = ?
      ORDER BY (s.grade IS NOT NULL), s.submitted_at DESC
    `).all(classroom.id);
    response.json({ submissions });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/assignments", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT * FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const title = cleanText(request.body.title, 100);
    const instructions = cleanText(request.body.instructions, 2000);
    const dueDate = request.body.dueDate;
    const points = Number(request.body.points);
    if (title.length < 2 || instructions.length < 2) throw httpError(400, "Enter an assignment title and instructions.");
    if (!isValidDate(dueDate)) throw httpError(400, "Choose a valid due date.");
    if (!Number.isInteger(points) || points < 1 || points > 1000) throw httpError(400, "Points must be a whole number from 1 to 1000.");
    const assignment = {
      id: crypto.randomUUID(),
      classroomId: classroom.id,
      title,
      instructions,
      dueDate,
      points,
      createdAt: new Date().toISOString(),
    };
    await database.prepare(`
      INSERT INTO assignments (id, classroom_id, title, instructions, due_date, points, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(assignment.id, assignment.classroomId, assignment.title, assignment.instructions, assignment.dueDate, assignment.points, assignment.createdAt);
    response.status(201).json({ assignment });
  } catch (error) {
    next(error);
  }
});

app.get("/api/classrooms/:id/assignments/:assignmentId/submissions", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const assignment = await database.prepare(`
      SELECT a.id FROM assignments a
      JOIN classrooms c ON c.id = a.classroom_id
      WHERE a.id = ? AND c.id = ? AND c.teacher_id = ?
    `).get(request.params.assignmentId, request.params.id, request.user.id);
    if (!assignment) throw httpError(404, "Assignment not found.");
    const submissions = await database.prepare(`
      SELECT s.id, s.student_id AS studentId, u.name AS studentName, u.email AS studentEmail,
             s.content, s.submitted_at AS submittedAt, s.grade, s.feedback,
             a.id AS assignmentId, a.title AS assignmentTitle, a.points
      FROM submissions s JOIN users u ON u.id = s.student_id
      JOIN assignments a ON a.id = s.assignment_id
      WHERE s.assignment_id = ?
      ORDER BY s.submitted_at DESC
    `).all(assignment.id);
    response.json({ submissions });
  } catch (error) {
    next(error);
  }
});

app.put("/api/submissions/:id", requireUser, requireRole("student"), async function (request, response, next) {
  try {
    const submission = await database.prepare(`
      SELECT s.id, s.grade, a.due_date AS dueDate, c.id AS classroomId
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      JOIN classrooms c ON c.id = a.classroom_id
      JOIN enrollments e ON e.classroom_id = c.id
      WHERE s.id = ? AND e.student_id = ?
    `).get(request.params.id, request.user.id);
    if (!submission) throw httpError(404, "Submission not found.");
    if (submission.grade !== null) throw httpError(409, "A graded submission cannot be changed.");
    if (submission.dueDate < new Date().toISOString().slice(0, 10)) throw httpError(400, "This assignment is past due.");
    const content = cleanText(request.body.content, 5000);
    if (content.length < 2) throw httpError(400, "Your submission must contain at least 2 characters.");
    const submittedAt = new Date().toISOString();
    await database.prepare("UPDATE submissions SET content = ?, submitted_at = ? WHERE id = ?")
      .run(content, submittedAt, submission.id);
    response.json({ submission: { id: submission.id, content, submittedAt, grade: null, feedback: "" } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/assignments/:id/submissions", requireUser, requireRole("student"), async function (request, response, next) {
  try {
    const assignment = await database.prepare(`
      SELECT a.* FROM assignments a
      JOIN enrollments e ON e.classroom_id = a.classroom_id
      WHERE a.id = ? AND e.student_id = ?
    `).get(request.params.id, request.user.id);
    if (!assignment) throw httpError(404, "Assignment not found in one of your classes.");
    if (assignment.due_date < new Date().toISOString().slice(0, 10)) throw httpError(400, "This assignment is past due.");
    const content = cleanText(request.body.content, 5000);
    if (content.length < 2) throw httpError(400, "Your submission must contain at least 2 characters.");
    const existing = await database.prepare("SELECT id, grade FROM submissions WHERE assignment_id = ? AND student_id = ?")
      .get(assignment.id, request.user.id);
    if (existing) {
      if (existing.grade !== null) throw httpError(409, "This submission has already been graded.");
      const submittedAt = new Date().toISOString();
      await database.prepare("UPDATE submissions SET content = ?, submitted_at = ? WHERE id = ?")
        .run(content, submittedAt, existing.id);
      response.json({ submission: { id: existing.id, content, submittedAt, grade: null, feedback: "" } });
      return;
    }
    const submission = {
      id: crypto.randomUUID(),
      assignmentId: assignment.id,
      studentId: request.user.id,
      content,
      submittedAt: new Date().toISOString(),
    };
    await database.prepare(`
      INSERT INTO submissions (id, assignment_id, student_id, content, submitted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(submission.id, submission.assignmentId, submission.studentId, submission.content, submission.submittedAt);
    response.status(201).json({ submission: { ...submission, grade: null, feedback: "" } });
  } catch (error) {
    next(error);
  }
});

app.put("/api/submissions/:id/grade", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const submission = await database.prepare(`
      SELECT s.id, a.points, c.teacher_id AS teacherId
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      JOIN classrooms c ON c.id = a.classroom_id
      WHERE s.id = ?
    `).get(request.params.id);
    if (!submission || submission.teacherId !== request.user.id) throw httpError(404, "Submission not found.");
    const grade = Number(request.body.grade);
    const feedback = cleanText(request.body.feedback, 1000);
    if (!Number.isFinite(grade) || grade < 0 || grade > submission.points) {
      throw httpError(400, "Grade must be between 0 and " + submission.points + ".");
    }
    await database.prepare("UPDATE submissions SET grade = ?, feedback = ?, graded_at = ? WHERE id = ?")
      .run(grade, feedback, new Date().toISOString(), submission.id);
    response.json({ submission: { id: submission.id, grade, feedback } });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  dotfiles: "deny",
}));

app.use(function (request, response, next) {
  if (request.path.startsWith("/api/")) {
    next(httpError(404, "API route not found."));
    return;
  }
  if (path.extname(request.path)) {
    next(httpError(404, "Page not found."));
    return;
  }
  response.sendFile(path.join(__dirname, "public", "index.html"), function (error) {
    if (error) next(error);
  });
});

app.use(function (error, _request, response, _next) {
  if (error.type === "entity.too.large") {
    response.status(413).json({ error: "Request is too large." });
    return;
  }
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, "body")) {
    response.status(400).json({ error: "Request body must be valid JSON." });
    return;
  }
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  response.status(status).json({ error: status >= 500 ? "Something went wrong. Please try again." : error.message });
});

async function startServer() {
  if (isProduction && !postgresConnectionString) {
    throw new Error("DATABASE_URL must be set in production so account data uses persistent PostgreSQL storage.");
  }
  if (postgresConnectionString) {
    database = new PostgresDatabase(postgresConnectionString);
  } else {
    fs.mkdirSync(dataDirectory, { recursive: true });
    database = new SQLiteDatabase(path.join(dataDirectory, "classroom.sqlite"));
    await database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  await database.exec(schema);
  await migrateUserIds();
  await database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  app.listen(PORT, function () {
    console.log("Classroom is running at http://localhost:" + PORT);
  });
}

class SQLiteDatabase {
  constructor(filePath) {
    const { DatabaseSync } = require("node:sqlite");
    this.connection = new DatabaseSync(filePath);
  }

  prepare(sql) {
    return {
      get: async (...params) => this.connection.prepare(sql).get(...params),
      all: async (...params) => this.connection.prepare(sql).all(...params),
      run: async (...params) => {
        const result = this.connection.prepare(sql).run(...params);
        return { changes: Number(result.changes) };
      },
    };
  }

  async exec(sql) {
    this.connection.exec(sql);
  }

  async transaction(callback) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = await callback(this);
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  async close() {
    this.connection.close();
  }
}

class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  prepare(sql) {
    return createPostgresStatement((params) => this.pool.query(toPostgresSql(sql), params));
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = {
        prepare: (sql) => createPostgresStatement((params) => client.query(toPostgresSql(sql), params)),
      };
      const result = await callback(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

function createPostgresStatement(query) {
  return {
    get: async (...params) => {
      const result = await query(params);
      return result.rows[0];
    },
    all: async (...params) => {
      const result = await query(params);
      return result.rows;
    },
    run: async (...params) => {
      const result = await query(params);
      return { changes: result.rowCount };
    },
  };
}

function toPostgresSql(sql) {
  let parameterIndex = 0;
  return sql
    .replace(/\bAS\s+([A-Za-z][A-Za-z0-9_]*)/gi, 'AS "$1"')
    .replace(/\s+COLLATE\s+NOCASE\b/gi, "")
    .replace(/\?/g, () => "$" + (++parameterIndex));
}

function requireSameOrigin(request, _response, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
  const origin = request.get("origin");
  if (!origin) return next(httpError(403, "This request must come from the classroom site."));
  try {
    if (new URL(origin).host !== request.get("host")) return next(httpError(403, "Cross-origin requests are not allowed."));
  } catch {
    return next(httpError(403, "Request origin is invalid."));
  }
  return next();
}

async function requireUser(request, _response, next) {
  const session = await findSession(request);
  if (!session) return next(httpError(401, "Please sign in to continue."));
  request.user = session.user;
  request.sessionHash = session.tokenHash;
  return next();
}

async function findSession(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = hashToken(token);
  const session = await database.prepare(`
    SELECT u.*, s.token_hash AS session_hash
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  return session ? { user: session, tokenHash: session.session_hash } : null;
}

async function findSessionUser(request) {
  const session = await findSession(request);
  return session ? session.user : null;
}

function requireRole(role) {
  return function (request, _response, next) {
    if (request.user.role !== role) return next(httpError(403, "This action is not available for your account."));
    return next();
  };
}

async function createSession(response, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expiresAt);
  response.append("Set-Cookie", [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + SESSION_DAYS * 86400,
    isProduction ? "Secure" : "",
  ].filter(Boolean).join("; "));
}

function clearSessionCookie(response) {
  response.append("Set-Cookie", COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (isProduction ? "; Secure" : ""));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function verifyPassword(password, saltHex, storedHashHex) {
  if (!password || password.length > 200) return false;
  const expected = Buffer.from(storedHashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

async function migrateUserIds() {
  const users = await database.prepare("SELECT id FROM users").all();
  const usedIds = new Set(users.map((user) => user.id));
  const replacements = [];
  for (const user of users) {
    if (accountIdPattern.test(user.id)) continue;
    const newId = await generateAccountId((id) => usedIds.has(id));
    usedIds.add(newId);
    replacements.push([user.id, newId]);
  }
  if (!replacements.length) return;

  const userIdColumns = [
    ["sessions", "user_id"],
    ["classrooms", "teacher_id"],
    ["enrollments", "student_id"],
    ["class_join_requests", "student_id"],
    ["submissions", "student_id"],
  ];
  await database.transaction(async function (transaction) {
    if (database instanceof SQLiteDatabase) await database.exec("PRAGMA defer_foreign_keys = ON");
    for (const [oldId, newId] of replacements) {
      await transaction.prepare("UPDATE users SET id = ? WHERE id = ?").run(newId, oldId);
      for (const [table, column] of userIdColumns) {
        if (database instanceof SQLiteDatabase) {
          await transaction.prepare("UPDATE " + table + " SET " + column + " = ? WHERE " + column + " = ?").run(newId, oldId);
        }
      }
    }
  });
}

async function generateAccountId(isTaken) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomLetters(letters, 2) + "-" +
      String(crypto.randomInt(100)).padStart(2, "0") + "-" + randomLetters(letters, 2);
    if (!await isTaken(id)) return id;
  }
  throw new Error("Could not generate a unique Classroom ID.");
}

function randomLetters(alphabet, length) {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[crypto.randomInt(alphabet.length)];
  }
  return result;
}

async function getClassroomsForUser(user) {
  const rows = user.role === "teacher"
    ? await database.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.classroom_id = c.id) AS student_count
      FROM classrooms c WHERE c.teacher_id = ? ORDER BY c.created_at DESC
    `).all(user.id)
    : await database.prepare(`
      SELECT c.*, u.name AS teacher_name,
             (SELECT COUNT(*) FROM enrollments e2 WHERE e2.classroom_id = c.id) AS student_count
      FROM enrollments e JOIN classrooms c ON c.id = e.classroom_id
      JOIN users u ON u.id = c.teacher_id
      WHERE e.student_id = ? ORDER BY e.joined_at DESC
    `).all(user.id);
  return Promise.all(rows.map(async (row) => {
    const classroom = serializeClassroom(row, row.student_count, user.role === "teacher");
    if (user.role === "teacher") {
      classroom.students = await database.prepare(`
        SELECT u.id, u.name, u.email, e.joined_at AS joinedAt
        FROM enrollments e
        JOIN users u ON u.id = e.student_id
        WHERE e.classroom_id = ?
        ORDER BY LOWER(u.name) ASC
      `).all(row.id);
      classroom.joinRequests = await database.prepare(`
        SELECT r.id, r.student_id AS studentId, u.name AS studentName, u.email AS studentEmail,
               r.requested_at AS requestedAt
        FROM class_join_requests r
        JOIN users u ON u.id = r.student_id
        WHERE r.classroom_id = ? AND r.status = 'pending'
        ORDER BY r.requested_at ASC
      `).all(row.id);
    }
    return classroom;
  }));
}

function serializeClassroom(classroom, studentCount, includeJoinCode) {
  const result = {
    id: classroom.id,
    name: classroom.name,
    subject: classroom.subject,
    teacherName: classroom.teacher_name || classroom.teacherName || null,
    color: classroom.color,
    studentCount: Number(studentCount) || 0,
  };
  if (includeJoinCode) result.joinCode = classroom.join_code || classroom.joinCode;
  return result;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function createJoinCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = crypto.randomBytes(6);
    const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    if (!await database.prepare("SELECT 1 FROM classrooms WHERE join_code = ?").get(code)) return code;
  }

  throw new Error("Could not allocate a unique class join code.");
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function createRateLimiter() {
  setInterval(function () {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, bucket] of rateBuckets) if (bucket.startedAt < cutoff) rateBuckets.delete(key);
  }, 5 * 60 * 1000).unref();
  return function (request, response, next) {
    const key = request.ip + ":" + request.path;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= 15 * 60 * 1000) {
      bucket = { startedAt: now, count: 0 };
      rateBuckets.set(key, bucket);
    }

    bucket.count++;
    const limit = request.path.startsWith("/api/auth/") ? 25 : 180;
    if (bucket.count > limit) {
      response.set("Retry-After", String(Math.ceil((15 * 60 * 1000 - (now - bucket.startedAt)) / 1000)));
      response.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }
    next();
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isEmailUniqueViolation(error) {
  return error.code === "23505" && error.constraint === "users_email_key" ||
    String(error.message).includes("users.email");
}

startServer().catch(function (error) {
  console.error("Could not start Classroom:", error);
  if (database) {
    database.close().catch(function (closeError) {
      console.error("Could not close the database connection:", closeError);
    });
  }
  process.exitCode = 1;
});
