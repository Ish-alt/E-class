"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_NAME = "classroom_session";
const SESSION_DAYS = 14;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const accountIdPattern = /^[A-Z]{2}-\d{2}-[A-Z]{2}$/;
const dataDirectory = process.env.DATA_DIRECTORY || path.join(__dirname, "data");
const postgresConnectionString = process.env.DATABASE_URL;
const storageUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/+$/, "") : "";
const storageServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "classroom-files";
let database;
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const colors = ["lilac", "mint", "peach", "sky"];
const fileTypes = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: function (_request, file, callback) {
    if (!getFileExtension(file.originalname) || !fileTypes[getFileExtension(file.originalname)]) {
      callback(httpError(400, "Choose a PDF, Office document, text, spreadsheet, or image file."));
      return;
    }
    callback(null, true);
  },
});
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

app.post("/api/auth/logout", async function (request, response, next) {
  try {
    const token = parseCookies(request.headers.cookie || "")[COOKIE_NAME];
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    }
    clearSessionCookie(response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", async function (request, response) {
  const user = await findSessionUser(request);
  if (!user) clearSessionCookie(response);
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
               COALESCE(cfg.submission_mode, 'either') AS submissionMode,
               COALESCE(cfg.accepted_types, '[]') AS acceptedTypes,
               s.id AS submissionId, s.content AS submissionContent,
               s.submitted_at AS submittedAt, s.grade, s.feedback,
               f.id AS submissionFileId, f.original_name AS submissionFileName
        FROM assignments a
        LEFT JOIN assignment_submission_settings cfg ON cfg.assignment_id = a.id
        LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
        LEFT JOIN class_files f ON f.submission_id = s.id
        WHERE a.classroom_id = ?
        ORDER BY a.due_date ASC, a.created_at DESC
      `).all(request.user.id, classroom.id);
      assignments.push(...rows.map((row) => ({
        ...row,
        acceptedTypes: JSON.parse(row.acceptedTypes),
        submission: row.submissionId ? {
          id: row.submissionId,
          content: row.submissionContent,
          submittedAt: row.submittedAt,
          grade: row.grade,
          feedback: row.feedback,
          file: row.submissionFileId ? { id: row.submissionFileId, name: row.submissionFileName } : null,
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
               f.id AS fileId, f.original_name AS fileName,
               a.title AS assignmentTitle, a.points, a.classroom_id AS classroomId
        FROM submissions s JOIN users u ON u.id = s.student_id
        LEFT JOIN class_files f ON f.submission_id = s.id
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

app.get("/api/classrooms/:id/details", requireUser, async function (request, response, next) {
  try {
    const classroom = await getAuthorizedClassroom(request.params.id, request.user);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const isTeacher = classroom.teacher_id === request.user.id;
    const students = await database.prepare(`
      SELECT u.id, u.name, ${isTeacher ? "u.email," : ""} e.joined_at AS joinedAt
      FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.classroom_id = ?
      ORDER BY LOWER(u.name)
    `).all(classroom.id);
    const assignments = await database.prepare(`
      SELECT a.id, a.title, a.instructions, a.due_date AS dueDate, a.points, a.created_at AS createdAt,
             COALESCE(cfg.submission_mode, 'either') AS submissionMode,
             COALESCE(cfg.accepted_types, '[]') AS acceptedTypes,
             (SELECT COUNT(*) FROM submissions all_s WHERE all_s.assignment_id = a.id) AS submissionCount,
             s.id AS submissionId, s.content AS submissionContent, s.submitted_at AS submittedAt,
             s.grade, s.feedback, f.id AS fileId, f.original_name AS fileName
      FROM assignments a
      LEFT JOIN assignment_submission_settings cfg ON cfg.assignment_id = a.id
      LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
      LEFT JOIN class_files f ON f.submission_id = s.id
      WHERE a.classroom_id = ?
      ORDER BY a.created_at DESC
    `).all(request.user.id, classroom.id);
    const resources = await database.prepare(`
      SELECT r.id, r.kind, r.title, r.description, r.due_date AS dueDate, r.points,
             r.content, r.created_at AS createdAt,
             qr.id AS responseId, qr.answers AS responseAnswers, qr.grade AS responseGrade,
             qr.feedback AS responseFeedback, qr.submitted_at AS responseSubmittedAt,
             (SELECT COUNT(*) FROM quiz_responses all_qr WHERE all_qr.resource_id = r.id) AS responseCount
      FROM class_resources r
      LEFT JOIN quiz_responses qr ON qr.resource_id = r.id AND qr.student_id = ?
      WHERE r.classroom_id = ?
      ORDER BY r.created_at DESC
    `).all(request.user.id, classroom.id);
    const resourceItems = [];
    for (const resource of resources) {
      const item = {
        id: resource.id,
        kind: resource.kind,
        title: resource.title,
        description: resource.description,
        dueDate: resource.dueDate,
        points: resource.points,
        createdAt: resource.createdAt,
        responseCount: Number(resource.responseCount),
      };
      if (resource.kind === "material") {
        item.file = await database.prepare(`
          SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes
          FROM class_files WHERE resource_id = ?
        `).get(resource.id);
      } else {
        item.questions = JSON.parse(resource.content).map(function (question) {
          if (isTeacher) return question;
          const { answer: _answer, ...publicQuestion } = question;
          return publicQuestion;
        });
        item.response = resource.responseId ? {
          id: resource.responseId,
          answers: isTeacher ? JSON.parse(resource.responseAnswers) : undefined,
          grade: resource.responseGrade,
          feedback: resource.responseFeedback,
          submittedAt: resource.responseSubmittedAt,
        } : null;
      }
      resourceItems.push(item);
    }
    const rawGroups = await database.prepare(`
      SELECT g.id, g.name, g.leader_id AS leaderId, leader.name AS leaderName, g.created_at AS createdAt
      FROM class_groups g LEFT JOIN users leader ON leader.id = g.leader_id
      WHERE g.classroom_id = ? ORDER BY g.created_at, g.name
    `).all(classroom.id);
    const groups = [];
    for (const group of rawGroups) {
      const members = await database.prepare(`
        SELECT u.id, u.name${isTeacher ? ", u.email" : ""}
        FROM class_group_members gm JOIN users u ON u.id = gm.student_id
        WHERE gm.group_id = ? ORDER BY LOWER(u.name)
      `).all(group.id);
      groups.push({ ...group, members });
    }
    const settings = await database.prepare(`
      SELECT group_size AS groupSize, student_groups_enabled AS studentGroupsEnabled
      FROM classroom_group_settings WHERE classroom_id = ?
    `).get(classroom.id);
    const groupLeaders = await database.prepare(`
      SELECT student_id AS studentId FROM classroom_group_leaders WHERE classroom_id = ?
    `).all(classroom.id);
    response.json({
      classroom: serializeClassroom(classroom, students.length, isTeacher),
      isTeacher,
      students,
      assignments: assignments.map(function (item) {
        return {
          id: item.id,
          title: item.title,
          instructions: item.instructions,
          dueDate: item.dueDate,
          points: item.points,
          createdAt: item.createdAt,
          submissionMode: item.submissionMode,
          acceptedTypes: JSON.parse(item.acceptedTypes),
          submissionCount: Number(item.submissionCount),
          submission: item.submissionId ? {
            id: item.submissionId,
            content: item.submissionContent,
            submittedAt: item.submittedAt,
            grade: item.grade,
            feedback: item.feedback,
            file: item.fileId ? { id: item.fileId, name: item.fileName } : null,
          } : null,
        };
      }),
      resources: resourceItems,
      groups,
      groupSettings: {
        groupSize: settings ? Number(settings.groupSize) : 4,
        studentGroupsEnabled: settings ? Boolean(settings.studentGroupsEnabled) : false,
        leaderIds: groupLeaders.map(function (leader) { return leader.studentId; }),
        isGroupLeader: groupLeaders.some(function (leader) { return leader.studentId === request.user.id; }),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/classrooms/:id/groups/settings", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const groupSize = Number(request.body.groupSize);
    const studentGroupsEnabled = request.body.studentGroupsEnabled;
    const leaderIds = request.body.leaderIds;
    if (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > 20) {
      throw httpError(400, "Group size must be a whole number from 2 to 20.");
    }
    if (typeof studentGroupsEnabled !== "boolean" || !Array.isArray(leaderIds)) {
      throw httpError(400, "Choose whether students can form groups and assign their leaders.");
    }
    const uniqueLeaderIds = [...new Set(leaderIds)];
    if (uniqueLeaderIds.some(function (id) { return typeof id !== "string"; })) {
      throw httpError(400, "Choose valid student leaders.");
    }
    if (studentGroupsEnabled && uniqueLeaderIds.length === 0) {
      throw httpError(400, "Assign at least one student leader before enabling student-created groups.");
    }
    for (const leaderId of uniqueLeaderIds) {
      if (!await database.prepare("SELECT 1 FROM enrollments WHERE classroom_id = ? AND student_id = ?")
        .get(classroom.id, leaderId)) throw httpError(400, "A selected group leader is not enrolled in this class.");
    }
    await database.transaction(async function (transaction) {
      await transaction.prepare(`
        INSERT INTO classroom_group_settings (classroom_id, group_size, student_groups_enabled)
        VALUES (?, ?, ?)
        ON CONFLICT (classroom_id) DO UPDATE SET
          group_size = excluded.group_size, student_groups_enabled = excluded.student_groups_enabled
      `).run(classroom.id, groupSize, studentGroupsEnabled ? 1 : 0);
      await transaction.prepare("DELETE FROM classroom_group_leaders WHERE classroom_id = ?").run(classroom.id);
      for (const leaderId of uniqueLeaderIds) {
        await transaction.prepare("INSERT INTO classroom_group_leaders (classroom_id, student_id) VALUES (?, ?)")
          .run(classroom.id, leaderId);
      }
    });
    response.json({ groupSize, studentGroupsEnabled, leaderIds: uniqueLeaderIds });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/groups/random", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const groupSize = Number(request.body.groupSize);
    if (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > 20) {
      throw httpError(400, "Group size must be a whole number from 2 to 20.");
    }
    const students = await database.prepare("SELECT student_id AS id FROM enrollments WHERE classroom_id = ?")
      .all(classroom.id);
    if (students.length < 2) throw httpError(400, "At least two students are needed to create groups.");
    shuffle(students);
    const groupCount = Math.ceil(students.length / groupSize);
    const buckets = Array.from({ length: groupCount }, function () { return []; });
    students.forEach(function (student, index) { buckets[index % groupCount].push(student.id); });
    const groups = buckets.map(function (studentIds, index) {
      return { name: "Group " + (index + 1), studentIds, leaderId: null };
    });
    const createdGroups = await saveClassGroups(classroom.id, request.user.id, groups);
    response.status(201).json({ groups: createdGroups });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/groups/manual", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const students = await database.prepare("SELECT student_id AS id FROM enrollments WHERE classroom_id = ?")
      .all(classroom.id);
    const groups = request.body.groups;
    if (!Array.isArray(groups) || groups.length < 1 || students.length < 2) {
      throw httpError(400, "Add at least one group and two students.");
    }
    const assigned = new Set();
    const validatedGroups = groups.map(function (group, index) {
      if (!group || !Array.isArray(group.studentIds)) throw httpError(400, "Each group needs a student list.");
      const name = cleanText(group.name, 60) || "Group " + (index + 1);
      const studentIds = [...new Set(group.studentIds)];
      if (studentIds.length < 2) throw httpError(400, "Each group must have at least two students.");
      for (const studentId of studentIds) {
        if (assigned.has(studentId) || !students.some(function (student) { return student.id === studentId; })) {
          throw httpError(400, "Assign each enrolled student to exactly one group.");
        }
        assigned.add(studentId);
      }
      const leaderId = group.leaderId || null;
      if (leaderId && !studentIds.includes(leaderId)) throw httpError(400, "A group leader must belong to that group.");
      return { name, studentIds, leaderId };
    });
    if (assigned.size !== students.length) throw httpError(400, "Assign every enrolled student to a group.");
    const createdGroups = await saveClassGroups(classroom.id, request.user.id, validatedGroups);
    response.status(201).json({ groups: createdGroups });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/groups", requireUser, requireRole("student"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ?")
      .get(request.params.id);
    if (!classroom || !await database.prepare("SELECT 1 FROM enrollments WHERE classroom_id = ? AND student_id = ?")
      .get(classroom.id, request.user.id)) throw httpError(404, "Classroom not found.");
    const settings = await database.prepare(`
      SELECT group_size AS groupSize, student_groups_enabled AS studentGroupsEnabled
      FROM classroom_group_settings WHERE classroom_id = ?
    `).get(classroom.id);
    if (!settings || !settings.studentGroupsEnabled) throw httpError(403, "The teacher has not enabled student-created groups.");
    if (!await database.prepare("SELECT 1 FROM classroom_group_leaders WHERE classroom_id = ? AND student_id = ?")
      .get(classroom.id, request.user.id)) throw httpError(403, "Only a teacher-assigned group leader can create a group.");
    if (await database.prepare("SELECT 1 FROM class_group_members WHERE classroom_id = ? AND student_id = ?")
      .get(classroom.id, request.user.id)) throw httpError(409, "You are already in a group.");
    const name = cleanText(request.body.name, 60);
    const memberIds = Array.isArray(request.body.memberIds) ? [...new Set(request.body.memberIds)] : [];
    const studentIds = [...new Set([request.user.id, ...memberIds])];
    if (name.length < 2) throw httpError(400, "Enter a group name.");
    if (studentIds.length < 2 || studentIds.length > Number(settings.groupSize)) {
      throw httpError(400, "Choose between 2 and " + settings.groupSize + " students for the group.");
    }
    for (const studentId of studentIds) {
      if (!await database.prepare("SELECT 1 FROM enrollments WHERE classroom_id = ? AND student_id = ?")
        .get(classroom.id, studentId)) throw httpError(400, "Every group member must be enrolled in this class.");
      if (await database.prepare("SELECT 1 FROM class_group_members WHERE classroom_id = ? AND student_id = ?")
        .get(classroom.id, studentId)) throw httpError(409, "A selected student is already in a group.");
    }
    const group = { id: crypto.randomUUID(), classroomId: classroom.id, name, leaderId: request.user.id };
    await database.transaction(async function (transaction) {
      await transaction.prepare(`
        INSERT INTO class_groups (id, classroom_id, name, created_by, leader_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(group.id, group.classroomId, group.name, request.user.id, group.leaderId, new Date().toISOString());
      for (const studentId of studentIds) {
        await transaction.prepare(`
          INSERT INTO class_group_members (group_id, classroom_id, student_id, joined_at) VALUES (?, ?, ?, ?)
        `).run(group.id, classroom.id, studentId, new Date().toISOString());
      }
    });
    response.status(201).json({ group });
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
    const submissionMode = request.body.submissionMode || "either";
    if (!["text", "file", "either"].includes(submissionMode)) throw httpError(400, "Choose text, file, or either submission format.");
    const acceptedTypes = normalizeFileTypes(request.body.acceptedTypes);
    if (submissionMode !== "text" && !acceptedTypes.length) {
      throw httpError(400, "Select at least one accepted file type.");
    }
    const assignment = {
      id: crypto.randomUUID(),
      classroomId: classroom.id,
      title,
      instructions,
      dueDate,
      points,
      createdAt: new Date().toISOString(),
    };
    await database.transaction(async function (transaction) {
      await transaction.prepare(`
        INSERT INTO assignments (id, classroom_id, title, instructions, due_date, points, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(assignment.id, assignment.classroomId, assignment.title, assignment.instructions, assignment.dueDate, assignment.points, assignment.createdAt);
      await transaction.prepare(`
        INSERT INTO assignment_submission_settings (assignment_id, submission_mode, accepted_types)
        VALUES (?, ?, ?)
      `).run(assignment.id, submissionMode, JSON.stringify(acceptedTypes));
    });
    response.status(201).json({ assignment });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/materials", requireUser, requireRole("teacher"), upload.single("file"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    if (!request.file) throw httpError(400, "Choose a file to share with the class.");
    const title = cleanText(request.body.title, 100);
    const description = cleanText(request.body.description, 2000);
    if (title.length < 2) throw httpError(400, "Enter a title for this material.");
    const file = await uploadToStorage(request.file, "materials/" + classroom.id + "/" + crypto.randomUUID());
    const resource = {
      id: crypto.randomUUID(),
      classroomId: classroom.id,
      title,
      description,
      createdAt: new Date().toISOString(),
    };
    try {
      await database.transaction(async function (transaction) {
        await transaction.prepare(`
          INSERT INTO class_resources (id, classroom_id, kind, title, description, created_by, created_at)
          VALUES (?, ?, 'material', ?, ?, ?, ?)
        `).run(resource.id, resource.classroomId, resource.title, resource.description, request.user.id, resource.createdAt);
        await insertClassFile(transaction, {
          id: crypto.randomUUID(),
          classroomId: classroom.id,
          resourceId: resource.id,
          uploaderId: request.user.id,
          file,
          createdAt: resource.createdAt,
        });
      });
    } catch (error) {
      await removeFromStorage([file.storagePath]);
      throw error;
    }
    response.status(201).json({ resource: { ...resource, kind: "material", fileName: file.originalName } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/classrooms/:id/quizzes", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const classroom = await database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
      .get(request.params.id, request.user.id);
    if (!classroom) throw httpError(404, "Classroom not found.");
    const title = cleanText(request.body.title, 100);
    const description = cleanText(request.body.description, 2000);
    const dueDate = request.body.dueDate;
    const rawQuestions = request.body.questions;
    if (title.length < 2) throw httpError(400, "Enter a quiz title.");
    if (!isValidDate(dueDate)) throw httpError(400, "Choose a valid quiz due date.");
    if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 50) {
      throw httpError(400, "A quiz needs between 1 and 50 questions.");
    }
    const questions = rawQuestions.map(validateQuizQuestion);
    const points = questions.reduce(function (total, question) { return total + question.points; }, 0);
    if (points > 1000) throw httpError(400, "The quiz can be worth no more than 1000 points.");
    const resource = {
      id: crypto.randomUUID(),
      classroomId: classroom.id,
      title,
      description,
      dueDate,
      points,
      createdAt: new Date().toISOString(),
    };
    await database.prepare(`
      INSERT INTO class_resources (id, classroom_id, kind, title, description, due_date, points, content, created_by, created_at)
      VALUES (?, ?, 'quiz', ?, ?, ?, ?, ?, ?, ?)
    `).run(resource.id, resource.classroomId, resource.title, resource.description, resource.dueDate,
      resource.points, JSON.stringify(questions), request.user.id, resource.createdAt);
    response.status(201).json({ resource: { ...resource, kind: "quiz", questions } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/resources/:id/quiz-responses", requireUser, requireRole("student"), async function (request, response, next) {
  try {
    const resource = await database.prepare(`
      SELECT r.* FROM class_resources r
      JOIN enrollments e ON e.classroom_id = r.classroom_id
      WHERE r.id = ? AND r.kind = 'quiz' AND e.student_id = ?
    `).get(request.params.id, request.user.id);
    if (!resource) throw httpError(404, "Quiz not found in one of your classes.");
    if (resource.due_date < new Date().toISOString().slice(0, 10)) throw httpError(400, "This quiz is past due.");
    const questions = JSON.parse(resource.content);
    const answers = request.body.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw httpError(400, "Submit an answer for each quiz question.");
    const shortQuestions = questions.filter(function (question) { return question.type === "short_answer"; });
    let autoGrade = 0;
    const normalizedAnswers = {};
    for (const question of questions) {
      const answer = answers[question.id];
      if (question.type === "short_answer") {
        normalizedAnswers[question.id] = cleanText(answer, 2000);
        if (!normalizedAnswers[question.id]) throw httpError(400, "Answer every short-answer question.");
      } else if (question.type === "true_false") {
        const normalized = String(answer);
        if (normalized !== "true" && normalized !== "false") throw httpError(400, "Answer every true/false question.");
        normalizedAnswers[question.id] = normalized;
        if (normalized === question.answer) autoGrade += question.points;
      } else {
        const optionId = String(answer);
        if (!question.options.some(function (option) { return option.id === optionId; })) {
          throw httpError(400, "Choose an answer for every multiple-choice question.");
        }
        normalizedAnswers[question.id] = optionId;
        if (optionId === question.answer) autoGrade += question.points;
      }
    }
    const existing = await database.prepare("SELECT id, grade FROM quiz_responses WHERE resource_id = ? AND student_id = ?")
      .get(resource.id, request.user.id);
    if (existing && existing.grade !== null) throw httpError(409, "This quiz has already been graded.");
    const submittedAt = new Date().toISOString();
    const responseId = existing ? existing.id : crypto.randomUUID();
    await database.prepare(`
      INSERT INTO quiz_responses (id, resource_id, student_id, answers, auto_grade, grade, feedback, submitted_at, graded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (resource_id, student_id) DO UPDATE SET
        answers = excluded.answers, auto_grade = excluded.auto_grade, grade = excluded.grade,
        feedback = excluded.feedback, submitted_at = excluded.submitted_at, graded_at = excluded.graded_at
    `).run(responseId, resource.id, request.user.id, JSON.stringify(normalizedAnswers), autoGrade,
      shortQuestions.length ? null : autoGrade, shortQuestions.length ? "" : "Automatically graded.", submittedAt,
      shortQuestions.length ? null : submittedAt);
    response.status(existing ? 200 : 201).json({
      response: {
        id: responseId,
        grade: shortQuestions.length ? null : autoGrade,
        autoGrade,
        points: Number(resource.points),
        submittedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/resources/:id/quiz-responses", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const resource = await database.prepare(`
      SELECT r.id, r.title, r.points, r.content, c.teacher_id AS teacherId
      FROM class_resources r JOIN classrooms c ON c.id = r.classroom_id
      WHERE r.id = ? AND r.kind = 'quiz'
    `).get(request.params.id);
    if (!resource || resource.teacherId !== request.user.id) throw httpError(404, "Quiz not found.");
    const responses = await database.prepare(`
      SELECT qr.id, qr.student_id AS studentId, u.name AS studentName, qr.answers,
             qr.auto_grade AS autoGrade, qr.grade, qr.feedback, qr.submitted_at AS submittedAt,
             qr.graded_at AS gradedAt
      FROM quiz_responses qr JOIN users u ON u.id = qr.student_id
      WHERE qr.resource_id = ? ORDER BY qr.submitted_at
    `).all(resource.id);
    response.json({
      questions: JSON.parse(resource.content),
      points: Number(resource.points),
      responses: responses.map(function (item) { return { ...item, answers: JSON.parse(item.answers) }; }),
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/quiz-responses/:id/grade", requireUser, requireRole("teacher"), async function (request, response, next) {
  try {
    const result = await database.prepare(`
      SELECT qr.id, qr.answers, qr.auto_grade AS autoGrade, qr.grade, qr.resource_id AS resourceId,
             c.teacher_id AS teacherId, r.content
      FROM quiz_responses qr JOIN class_resources r ON r.id = qr.resource_id
      JOIN classrooms c ON c.id = r.classroom_id
      WHERE qr.id = ? AND r.kind = 'quiz'
    `).get(request.params.id);
    if (!result || result.teacherId !== request.user.id) throw httpError(404, "Quiz response not found.");
    if (result.grade !== null) throw httpError(409, "This quiz response has already been graded.");
    const questions = JSON.parse(result.content);
    const shortQuestions = questions.filter(function (question) { return question.type === "short_answer"; });
    if (!shortQuestions.length) throw httpError(400, "This quiz has no short-answer questions to grade.");
    const grades = request.body.grades;
    if (!grades || typeof grades !== "object" || Array.isArray(grades)) throw httpError(400, "Enter a score for every short-answer question.");
    let grade = Number(result.autoGrade);
    for (const question of shortQuestions) {
      const questionGrade = Number(grades[question.id]);
      if (!Number.isFinite(questionGrade) || questionGrade < 0 || questionGrade > question.points) {
        throw httpError(400, "Each short-answer score must be between 0 and its point value.");
      }
      grade += questionGrade;
    }
    const feedback = cleanText(request.body.feedback, 1000);
    const gradedAt = new Date().toISOString();
    await database.prepare("UPDATE quiz_responses SET grade = ?, feedback = ?, graded_at = ? WHERE id = ?")
      .run(grade, feedback, gradedAt, result.id);
    response.json({ response: { id: result.id, grade, feedback, gradedAt } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:id", requireUser, async function (request, response, next) {
  try {
    const file = await database.prepare(`
      SELECT f.*, c.teacher_id AS teacherId,
             s.student_id AS submittingStudentId
      FROM class_files f JOIN classrooms c ON c.id = f.classroom_id
      LEFT JOIN submissions s ON s.id = f.submission_id
      WHERE f.id = ?
    `).get(request.params.id);
    if (!file) throw httpError(404, "File not found.");
    const isTeacher = file.teacherId === request.user.id;
    const isEnrolled = Boolean(await database.prepare("SELECT 1 FROM enrollments WHERE classroom_id = ? AND student_id = ?")
      .get(file.classroom_id, request.user.id));
    if (file.submission_id) {
      if (!isTeacher && file.submittingStudentId !== request.user.id) throw httpError(404, "File not found.");
    } else if (!isTeacher && !isEnrolled) {
      throw httpError(404, "File not found.");
    }
    const content = await downloadFromStorage(file.storage_path);
    response.set("Content-Type", file.mime_type);
    response.set("Content-Length", String(content.length));
    response.set("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(file.original_name));
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Cache-Control", "private, no-store");
    response.send(content);
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
      SELECT s.id, s.grade, a.id AS assignmentId, a.due_date AS dueDate, c.id AS classroomId
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      JOIN classrooms c ON c.id = a.classroom_id
      JOIN enrollments e ON e.classroom_id = c.id
      WHERE s.id = ? AND e.student_id = ?
    `).get(request.params.id, request.user.id);
    if (!submission) throw httpError(404, "Submission not found.");
    if (submission.grade !== null) throw httpError(409, "A graded submission cannot be changed.");
    if (submission.dueDate < new Date().toISOString().slice(0, 10)) throw httpError(400, "This assignment is past due.");
    const setting = await database.prepare("SELECT submission_mode AS submissionMode FROM assignment_submission_settings WHERE assignment_id = ?")
      .get(submission.assignmentId);
    if (setting && setting.submissionMode === "file") throw httpError(400, "This assignment requires a file. Use the assignment turn-in form to upload it.");
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

app.post("/api/assignments/:id/submissions", requireUser, requireRole("student"), upload.single("file"), async function (request, response, next) {
  try {
    const assignment = await database.prepare(`
      SELECT a.* FROM assignments a
      JOIN enrollments e ON e.classroom_id = a.classroom_id
      WHERE a.id = ? AND e.student_id = ?
    `).get(request.params.id, request.user.id);
    if (!assignment) throw httpError(404, "Assignment not found in one of your classes.");
    if (assignment.due_date < new Date().toISOString().slice(0, 10)) throw httpError(400, "This assignment is past due.");
    const setting = await database.prepare(`
      SELECT submission_mode AS submissionMode, accepted_types AS acceptedTypes
      FROM assignment_submission_settings WHERE assignment_id = ?
    `).get(assignment.id);
    const submissionMode = setting ? setting.submissionMode : "either";
    const acceptedTypes = setting ? JSON.parse(setting.acceptedTypes) : Object.keys(fileTypes);
    const content = cleanText(request.body.content, 5000);
    const existing = await database.prepare("SELECT id, grade FROM submissions WHERE assignment_id = ? AND student_id = ?")
      .get(assignment.id, request.user.id);
    if (existing && existing.grade !== null) throw httpError(409, "This submission has already been graded.");
    if (request.file) validateAcceptedFile(request.file, acceptedTypes);
    if (submissionMode === "text" && request.file) throw httpError(400, "This assignment only accepts text submissions.");
    const hasExistingFile = existing && await database.prepare("SELECT 1 FROM class_files WHERE submission_id = ?")
      .get(existing.id);
    if (submissionMode === "file" && !request.file && !hasExistingFile) {
      throw httpError(400, "Attach a file in one of the formats required by your teacher.");
    }
    if (submissionMode === "text" && content.length < 2) {
      throw httpError(400, "Your submission must contain at least 2 characters.");
    }
    if (submissionMode === "either" && !content && !request.file && !hasExistingFile) {
      throw httpError(400, "Add written work or attach a file.");
    }
    const submittedAt = new Date().toISOString();
    const submissionId = existing ? existing.id : crypto.randomUUID();
    let uploadedFile = null;
    let oldFile = null;
    if (request.file) {
      if (existing) {
        oldFile = await database.prepare("SELECT storage_path AS storagePath FROM class_files WHERE submission_id = ?")
          .get(existing.id);
      }
      uploadedFile = await uploadToStorage(request.file, "submissions/" + assignment.id + "/" + submissionId);
    }
    try {
      await database.transaction(async function (transaction) {
        if (existing) {
          await transaction.prepare("UPDATE submissions SET content = ?, submitted_at = ? WHERE id = ?")
            .run(content, submittedAt, submissionId);
        } else {
          await transaction.prepare(`
            INSERT INTO submissions (id, assignment_id, student_id, content, submitted_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(submissionId, assignment.id, request.user.id, content, submittedAt);
        }
        if (uploadedFile) {
          await transaction.prepare("DELETE FROM class_files WHERE submission_id = ?").run(submissionId);
          await insertClassFile(transaction, {
            id: crypto.randomUUID(),
            classroomId: assignment.classroom_id,
            submissionId,
            uploaderId: request.user.id,
            file: uploadedFile,
            createdAt: submittedAt,
          });
        }
      });
    } catch (error) {
      if (uploadedFile) await removeFromStorage([uploadedFile.storagePath]);
      throw error;
    }
    if (oldFile && uploadedFile) await removeFromStorage([oldFile.storagePath]);
    response.status(existing ? 200 : 201).json({
      submission: { id: submissionId, content, submittedAt, grade: null, feedback: "" },
    });
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
  if (error instanceof multer.MulterError) {
    response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ error: error.code === "LIMIT_FILE_SIZE" ? "Files must be no larger than 20 MB." : "Choose one supported file." });
    return;
  }
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
  if (Boolean(storageUrl) !== Boolean(storageServiceKey)) {
    throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable private file storage.");
  }
  if (storageUrl && !/^https:\/\/[^/]+$/i.test(storageUrl)) {
    throw new Error("SUPABASE_URL must be the HTTPS URL for your Supabase project.");
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
  if (!storageUrl) console.warn("Supabase Storage is not configured; class file uploads are disabled.");
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

async function getAuthorizedClassroom(classroomId, user) {
  return database.prepare(`
    SELECT c.*, t.name AS teacher_name
    FROM classrooms c JOIN users t ON t.id = c.teacher_id
    WHERE c.id = ? AND (
      c.teacher_id = ? OR EXISTS (
        SELECT 1 FROM enrollments e WHERE e.classroom_id = c.id AND e.student_id = ?
      )
    )
  `).get(classroomId, user.id, user.id);
}

async function saveClassGroups(classroomId, teacherId, groups) {
  const createdAt = new Date().toISOString();
  const createdGroups = groups.map(function (group) {
    return { id: crypto.randomUUID(), name: group.name, leaderId: group.leaderId || null, members: group.studentIds };
  });
  await database.transaction(async function (transaction) {
    await transaction.prepare("DELETE FROM class_groups WHERE classroom_id = ?").run(classroomId);
    for (const group of createdGroups) {
      await transaction.prepare(`
        INSERT INTO class_groups (id, classroom_id, name, created_by, leader_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(group.id, classroomId, group.name, teacherId, group.leaderId, createdAt);
      for (const studentId of group.members) {
        await transaction.prepare(`
          INSERT INTO class_group_members (group_id, classroom_id, student_id, joined_at) VALUES (?, ?, ?, ?)
        `).run(group.id, classroomId, studentId, createdAt);
      }
    }
  });
  return createdGroups;
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}

function getFileExtension(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const separator = baseName.lastIndexOf(".");
  return separator < 0 ? "" : baseName.slice(separator + 1).toLowerCase();
}

function normalizeFileTypes(types) {
  if (!Array.isArray(types)) return Object.keys(fileTypes);
  return [...new Set(types.map(function (type) { return String(type).toLowerCase().replace(/^\./, ""); }))]
    .filter(function (type) { return Object.prototype.hasOwnProperty.call(fileTypes, type); });
}

function validateAcceptedFile(file, acceptedTypes) {
  const extension = getFileExtension(file.originalname);
  if (!Object.prototype.hasOwnProperty.call(fileTypes, extension) || !acceptedTypes.includes(extension)) {
    throw httpError(400, "That file type is not accepted for this assignment.");
  }
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw httpError(400, "Files must be no larger than 20 MB.");
}

function validateQuizQuestion(question) {
  if (!question || typeof question !== "object") throw httpError(400, "Each question must be valid.");
  const prompt = cleanText(question.prompt, 1000);
  const points = Number(question.points);
  if (prompt.length < 2) throw httpError(400, "Every quiz question needs a prompt.");
  if (!Number.isInteger(points) || points < 1 || points > 100) {
    throw httpError(400, "Each question must be worth 1 to 100 whole points.");
  }
  const id = crypto.randomUUID();
  if (question.type === "multiple_choice") {
    if (!Array.isArray(question.options)) throw httpError(400, "Add answer choices to each multiple-choice question.");
    const optionTexts = question.options.map(function (option) { return cleanText(option, 200); });
    if (optionTexts.length < 2 || optionTexts.length > 6 || optionTexts.some(function (option) { return !option; })) {
      throw httpError(400, "Multiple-choice questions need 2 to 6 non-empty options.");
    }
    if (new Set(optionTexts.map(function (option) { return option.toLowerCase(); })).size !== optionTexts.length) {
      throw httpError(400, "Multiple-choice options must be unique.");
    }
    const answerText = cleanText(question.answer, 200);
    const answerIndex = optionTexts.findIndex(function (option) { return option === answerText; });
    if (answerIndex < 0) throw httpError(400, "Select a correct answer from the multiple-choice options.");
    const options = optionTexts.map(function (text) { return { id: crypto.randomUUID(), text }; });
    return { id, type: question.type, prompt, points, options, answer: options[answerIndex].id };
  }
  if (question.type === "true_false") {
    if (question.answer !== "true" && question.answer !== "false") {
      throw httpError(400, "Choose the correct true/false answer.");
    }
    return { id, type: question.type, prompt, points, answer: question.answer };
  }
  if (question.type === "short_answer") {
    return { id, type: question.type, prompt, points };
  }
  throw httpError(400, "Choose multiple choice, true/false, or short answer for every question.");
}

function cleanFileName(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/").split("/").pop();
  const cleaned = normalized.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 150);
  return cleaned || "classroom-file";
}

function requireStorageConfigured() {
  if (!storageUrl || !storageServiceKey) {
    throw httpError(503, "File uploads are not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment.");
  }
  return { storageUrl, storageServiceKey };
}

async function storageRequest(pathname, options) {
  const config = requireStorageConfigured();
  let result;
  try {
    result = await fetch(config.storageUrl + "/storage/v1/" + pathname, {
      ...options,
      headers: {
        apikey: config.storageServiceKey,
        Authorization: "Bearer " + config.storageServiceKey,
        ...(options && options.headers),
      },
    });
  } catch {
    throw httpError(502, "Could not reach Supabase Storage. Check the Storage URL and network settings.");
  }
  if (!result.ok) {
    const status = result.status;
    await result.arrayBuffer();
    if (status === 404) throw httpError(502, "The private Supabase Storage bucket '" + storageBucket + "' was not found. Create it before uploading files.");
    throw httpError(502, "Supabase Storage rejected the file request (HTTP " + status + "). Check the bucket permissions and file size limit.");
  }
  return result;
}

async function uploadToStorage(file, directory) {
  requireStorageConfigured();
  const extension = getFileExtension(file.originalname);
  const id = crypto.randomUUID();
  const storagePath = directory + "/" + id + "." + extension;
  await storageRequest("object/" + encodeURIComponent(storageBucket) + "/" +
    storagePath.split("/").map(encodeURIComponent).join("/"), {
    method: "POST",
    headers: {
      "Content-Type": fileTypes[extension],
      "x-upsert": "false",
    },
    body: file.buffer,
  });
  return {
    originalName: cleanFileName(file.originalname),
    storagePath,
    mimeType: fileTypes[extension],
    sizeBytes: file.size,
  };
}

async function downloadFromStorage(storagePath) {
  const result = await storageRequest("object/" + encodeURIComponent(storageBucket) + "/" +
    storagePath.split("/").map(encodeURIComponent).join("/"), { method: "GET" });
  return Buffer.from(await result.arrayBuffer());
}

async function removeFromStorage(storagePaths) {
  if (!storagePaths.length) return;
  await storageRequest("object/" + encodeURIComponent(storageBucket), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: storagePaths }),
  });
}

async function insertClassFile(transaction, fileRecord) {
  await transaction.prepare(`
    INSERT INTO class_files (
      id, classroom_id, resource_id, submission_id, uploader_id, original_name,
      storage_path, mime_type, size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileRecord.id,
    fileRecord.classroomId,
    fileRecord.resourceId || null,
    fileRecord.submissionId || null,
    fileRecord.uploaderId,
    fileRecord.file.originalName,
    fileRecord.file.storagePath,
    fileRecord.file.mimeType,
    fileRecord.file.sizeBytes,
    fileRecord.createdAt,
  );
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
