"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { after, before, test } = require("node:test");

const legacySessionToken = "a".repeat(64);
let server;
let baseUrl;
let temporaryDirectory;
let teacherCookie;
let studentCookie;
let teacherAccountId;
let studentAccountId;
let classId;
let assignmentId;
let submissionId;
let joinRequestId;

before(async function () {
  const port = await reservePort();
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-api-test-"));
  seedLegacyDatabase();
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIRECTORY: temporaryDirectory,
      NODE_ENV: "test",
      DATABASE_URL: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = "http://127.0.0.1:" + port;
  await waitForServer();
});

after(async function () {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("serves the landing page without exposing project files", async function () {
  const landing = await fetch(baseUrl + "/");
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Bring your classroom|id="auth-screen"/);
  assert.equal((await fetch(baseUrl + "/server.js")).status, 404);
  assert.equal((await fetch(baseUrl + "/package.json")).status, 404);
  const anonymousUser = await request("/api/auth/me");
  assert.equal(anonymousUser.response.status, 200);
  assert.equal(anonymousUser.body.user, null);
});

test("migrates existing account IDs and preserves linked records and sessions", async function () {
  const legacyCookie = "classroom_session=" + legacySessionToken;
  const me = await request("/api/auth/me", { cookie: legacyCookie });
  assert.equal(me.response.status, 200);
  assert.match(me.body.user.id, /^[A-Z]{2}-\d{2}-[A-Z]{2}$/);
  assert.notEqual(me.body.user.id, "legacy-user-id");

  const dashboard = await request("/api/dashboard", { cookie: legacyCookie });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.classrooms[0].id, "legacy-class");
  assert.match(dashboard.body.classrooms[0].students[0].id, /^[A-Z]{2}-\d{2}-[A-Z]{2}$/);
  assert.equal(dashboard.body.classrooms[0].joinRequests[0].studentId, dashboard.body.classrooms[0].students[0].id);
  assert.equal(dashboard.body.submissions[0].studentId, dashboard.body.classrooms[0].students[0].id);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { accountId: me.body.user.id.toLowerCase(), password: "LegacyPass123" },
  });
  assert.equal(login.response.status, 200);
});

test("registers separate teacher and student accounts", async function () {
  const teacher = await register("Teacher One", "teacher@example.test", "TeacherPass123", "teacher");
  teacherCookie = teacher.cookie;
  teacherAccountId = teacher.body.user.id;
  assert.equal(teacher.response.status, 201);
  assert.equal(teacher.body.user.role, "teacher");
  assert.match(teacherAccountId, /^[A-Z]{2}-\d{2}-[A-Z]{2}$/);

  const student = await register("Student One", "student@example.test", "StudentPass123", "student");
  studentCookie = student.cookie;
  studentAccountId = student.body.user.id;
  assert.equal(student.response.status, 201);
  assert.equal(student.body.user.role, "student");
  assert.match(studentAccountId, /^[A-Z]{2}-\d{2}-[A-Z]{2}$/);
  assert.notEqual(teacherAccountId, studentAccountId);

  const duplicate = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Another Teacher", email: "TEACHER@example.test", password: "TeacherPass456", role: "teacher" },
  });
  assert.equal(duplicate.response.status, 409);

  const weakPassword = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Weak Pass", email: "weak@example.test", password: "short", role: "student" },
  });
  assert.equal(weakPassword.response.status, 400);
});

test("teacher-created classes can be joined using a private code", async function () {
  const created = await request("/api/classrooms", {
    method: "POST",
    cookie: teacherCookie,
    body: { name: "Biology 101", subject: "Science" },
  });
  assert.equal(created.response.status, 201);
  classId = created.body.classroom.id;
  const joinCode = created.body.classroom.joinCode;
  assert.match(joinCode, /^[A-Z0-9]{6}$/);

  const studentDashboardBefore = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal(studentDashboardBefore.body.classrooms.length, 0);

  const joined = await request("/api/classrooms/join", {
    method: "POST",
    cookie: studentCookie,
    body: { joinCode: joinCode.toLowerCase() },
  });
  assert.equal(joined.response.status, 202);
  assert.equal(joined.body.status, "pending");

  const studentDashboard = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal(studentDashboard.body.classrooms.length, 0);
  assert.equal(studentDashboard.body.joinRequests.length, 1);
  joinRequestId = studentDashboard.body.joinRequests[0].id;

  const teacherDashboard = await request("/api/dashboard", { cookie: teacherCookie });
  assert.equal(teacherDashboard.body.classrooms[0].students.length, 0);
  assert.equal(teacherDashboard.body.classrooms[0].joinRequests[0].studentName, "Student One");

  const approval = await request("/api/classrooms/" + classId + "/join-requests/" + joinRequestId, {
    method: "PUT",
    cookie: teacherCookie,
    body: { decision: "approve" },
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.status, "approved");

  const approvedStudentDashboard = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal(approvedStudentDashboard.body.classrooms.length, 1);
  assert.equal(approvedStudentDashboard.body.classrooms[0].name, "Biology 101");
  assert.equal("joinCode" in approvedStudentDashboard.body.classrooms[0], false);
  assert.equal("students" in approvedStudentDashboard.body.classrooms[0], false);

  const approvedTeacherDashboard = await request("/api/dashboard", { cookie: teacherCookie });
  assert.equal(approvedTeacherDashboard.body.classrooms[0].students.length, 1);
  assert.equal(approvedTeacherDashboard.body.classrooms[0].students[0].name, "Student One");
  assert.equal(approvedTeacherDashboard.body.classrooms[0].students[0].email, "student@example.test");
  assert.ok(approvedTeacherDashboard.body.classrooms[0].students[0].joinedAt);

  const duplicateJoin = await request("/api/classrooms/join", {
    method: "POST",
    cookie: studentCookie,
    body: { joinCode },
  });
  assert.equal(duplicateJoin.response.status, 409);
});

test("students submit work and only the owning teacher can grade it", async function () {
  const dueDate = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
  const created = await request("/api/classrooms/" + classId + "/assignments", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      title: "Cell report",
      instructions: "Explain the cell parts.",
      dueDate,
      points: 20,
    },
  });
  assert.equal(created.response.status, 201);
  assignmentId = created.body.assignment.id;

  const deniedAssignment = await request("/api/classrooms/" + classId + "/assignments", {
    method: "POST",
    cookie: studentCookie,
    body: { title: "Not allowed", instructions: "No.", dueDate, points: 10 },
  });
  assert.equal(deniedAssignment.response.status, 403);

  const submitted = await request("/api/assignments/" + assignmentId + "/submissions", {
    method: "POST",
    cookie: studentCookie,
    body: { content: "The nucleus contains the cell's DNA." },
  });
  assert.equal(submitted.response.status, 201);
  submissionId = submitted.body.submission.id;

  const received = await request("/api/classrooms/" + classId + "/submissions", { cookie: teacherCookie });
  assert.equal(received.body.submissions.length, 1);
  assert.equal(received.body.submissions[0].studentName, "Student One");

  const duplicateSubmission = await request("/api/assignments/" + assignmentId + "/submissions", {
    method: "POST",
    cookie: studentCookie,
    body: { content: "Another version." },
  });
  assert.equal(duplicateSubmission.response.status, 200);
  assert.equal(duplicateSubmission.body.submission.id, submissionId);

  const graded = await request("/api/submissions/" + submissionId + "/grade", {
    method: "PUT",
    cookie: teacherCookie,
    body: { grade: 18, feedback: "Clear explanation." },
  });
  assert.equal(graded.response.status, 200);

  const studentDashboard = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal(studentDashboard.body.assignments[0].submission.grade, 18);
  assert.equal(studentDashboard.body.assignments[0].submission.feedback, "Clear explanation.");

  const editAfterGrade = await request("/api/assignments/" + assignmentId + "/submissions", {
    method: "POST",
    cookie: studentCookie,
    body: { content: "Trying to replace graded work." },
  });
  assert.equal(editAfterGrade.response.status, 409);

  const otherTeacher = await register("Teacher Two", "teacher2@example.test", "TeacherPass789", "teacher");
  const stolenGrade = await request("/api/submissions/" + submissionId + "/grade", {
    method: "PUT",
    cookie: otherTeacher.cookie,
    body: { grade: 20, feedback: "" },
  });
  assert.equal(stolenGrade.response.status, 404);
});

test("class detail provides roster and quiz answers are private and grade correctly", async function () {
  const studentDetail = await request("/api/classrooms/" + classId + "/details", { cookie: studentCookie });
  assert.equal(studentDetail.response.status, 200);
  assert.equal(studentDetail.body.students.length, 1);
  assert.equal("email" in studentDetail.body.students[0], false);
  assert.equal(studentDetail.body.assignments.length, 1);

  const teacherDetail = await request("/api/classrooms/" + classId + "/details", { cookie: teacherCookie });
  assert.equal(teacherDetail.body.students[0].email, "student@example.test");

  const dueDate = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
  const created = await request("/api/classrooms/" + classId + "/quizzes", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      title: "Cell knowledge check",
      description: "Answer every question.",
      dueDate,
      questions: [
        { type: "multiple_choice", prompt: "Which organelle stores DNA?", options: ["Nucleus", "Ribosome"], answer: "Nucleus", points: 2 },
        { type: "true_false", prompt: "Cells have membranes.", answer: "true", points: 3 },
        { type: "short_answer", prompt: "Name one cell part.", points: 5 },
      ],
    },
  });
  assert.equal(created.response.status, 201);
  const quiz = created.body.resource;

  const studentQuizDetail = await request("/api/classrooms/" + classId + "/details", { cookie: studentCookie });
  const publicQuiz = studentQuizDetail.body.resources.find((resource) => resource.id === quiz.id);
  assert.equal(publicQuiz.questions.some((question) => "answer" in question), false);

  const submitted = await request("/api/resources/" + quiz.id + "/quiz-responses", {
    method: "POST",
    cookie: studentCookie,
    body: {
      answers: {
        [quiz.questions[0].id]: quiz.questions[0].answer,
        [quiz.questions[1].id]: "true",
        [quiz.questions[2].id]: "The nucleus.",
      },
    },
  });
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.body.response.autoGrade, 5);
  assert.equal(submitted.body.response.grade, null);

  const reviews = await request("/api/resources/" + quiz.id + "/quiz-responses", { cookie: teacherCookie });
  assert.equal(reviews.body.responses[0].answers[quiz.questions[2].id], "The nucleus.");
  assert.equal(reviews.body.responses[0].autoGrade, 5);
  const graded = await request("/api/quiz-responses/" + submitted.body.response.id + "/grade", {
    method: "PUT",
    cookie: teacherCookie,
    body: { grades: { [quiz.questions[2].id]: 4 }, feedback: "Good answer." },
  });
  assert.equal(graded.response.status, 200);
  assert.equal(graded.body.response.grade, 9);

  const objectiveQuiz = await request("/api/classrooms/" + classId + "/quizzes", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      title: "True or false",
      dueDate,
      questions: [{ type: "true_false", prompt: "The sun is a star.", answer: "true", points: 7 }],
    },
  });
  const objectiveQuestion = objectiveQuiz.body.resource.questions[0];
  const objectiveResponse = await request("/api/resources/" + objectiveQuiz.body.resource.id + "/quiz-responses", {
    method: "POST",
    cookie: studentCookie,
    body: { answers: { [objectiveQuestion.id]: "false" } },
  });
  assert.equal(objectiveResponse.response.status, 201);
  assert.equal(objectiveResponse.body.response.grade, 0);

  const maximumQuiz = await request("/api/classrooms/" + classId + "/quizzes", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      title: "Long quiz",
      dueDate,
      questions: Array.from({ length: 50 }, function (_unused, index) {
        const options = Array.from({ length: 6 }, function (_option, optionIndex) {
          return "Choice " + optionIndex + " " + "x".repeat(180);
        });
        return {
          type: "multiple_choice",
          prompt: "Question " + index + " " + "x".repeat(1000),
          points: 1,
          options,
          answer: options[0],
        };
      }),
    },
  });
  assert.equal(maximumQuiz.response.status, 201);
  assert.equal(maximumQuiz.body.resource.questions.length, 50);

  const fileAssignment = await request("/api/classrooms/" + classId + "/assignments", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      title: "Upload a report",
      instructions: "Upload your PDF.",
      dueDate,
      points: 10,
      submissionMode: "file",
      acceptedTypes: ["pdf"],
    },
  });
  assert.equal(fileAssignment.response.status, 201);
  const missingFile = await request("/api/assignments/" + fileAssignment.body.assignment.id + "/submissions", {
    method: "POST",
    cookie: studentCookie,
    body: { content: "" },
  });
  assert.equal(missingFile.response.status, 400);
});

test("sessions expire on sign out and protected endpoints require authentication", async function () {
  const dashboard = await request("/api/dashboard");
  assert.equal(dashboard.response.status, 401);

  const loggedIn = await request("/api/auth/login", {
    method: "POST",
    body: { accountId: studentAccountId, password: "StudentPass123" },
  });
  assert.equal(loggedIn.response.status, 200);
  const emailLogin = await request("/api/auth/login", {
    method: "POST",
    body: { accountId: "student@example.test", password: "StudentPass123" },
  });
  assert.equal(emailLogin.response.status, 401);
  loggedIn.cookie = loggedIn.response.headers.get("set-cookie").split(";")[0];
  const logout = await request("/api/auth/logout", { method: "POST", cookie: loggedIn.cookie });
  assert.equal(logout.response.status, 204);
  const expired = await request("/api/dashboard", { cookie: loggedIn.cookie });
  assert.equal(expired.response.status, 401);

  const staleLogout = await request("/api/auth/logout", {
    method: "POST",
    cookie: "classroom_session=" + "b".repeat(64),
  });
  assert.equal(staleLogout.response.status, 204);
  assert.match(staleLogout.response.headers.get("set-cookie"), /Max-Age=0/);

  const staleSession = await request("/api/auth/me", {
    cookie: "classroom_session=" + "b".repeat(64),
  });
  assert.equal(staleSession.response.status, 200);
  assert.equal(staleSession.body.user, null);
  assert.match(staleSession.response.headers.get("set-cookie"), /Max-Age=0/);
});

test("teachers control class requests, enrollment, and class deletion", async function () {
  const otherStudent = await register("Student Two", "student2@example.test", "StudentPass456", "student");
  const classroom = await request("/api/dashboard", { cookie: teacherCookie });
  const joinCode = classroom.body.classrooms[0].joinCode;

  const requested = await request("/api/classrooms/join", {
    method: "POST",
    cookie: otherStudent.cookie,
    body: { joinCode },
  });
  assert.equal(requested.response.status, 202);

  const pendingRequests = await request("/api/classrooms/" + classId + "/join-requests", { cookie: teacherCookie });
  assert.equal(pendingRequests.body.requests.length, 1);
  const rejected = await request("/api/classrooms/" + classId + "/join-requests/" + pendingRequests.body.requests[0].id, {
    method: "PUT",
    cookie: teacherCookie,
    body: { decision: "decline" },
  });
  assert.equal(rejected.body.status, "declined");
  assert.equal((await request("/api/dashboard", { cookie: otherStudent.cookie })).body.classrooms.length, 0);

  const reRequested = await request("/api/classrooms/join", {
    method: "POST",
    cookie: otherStudent.cookie,
    body: { joinCode },
  });
  assert.equal(reRequested.response.status, 202);
  const reRequest = (await request("/api/classrooms/" + classId + "/join-requests", { cookie: teacherCookie })).body.requests[0];
  const approved = await request("/api/classrooms/" + classId + "/join-requests/" + reRequest.id, {
    method: "PUT",
    cookie: teacherCookie,
    body: { decision: "approve" },
  });
  assert.equal(approved.body.status, "approved");

  const groupSettings = await request("/api/classrooms/" + classId + "/groups/settings", {
    method: "PUT",
    cookie: teacherCookie,
    body: { groupSize: 2, studentGroupsEnabled: true, leaderIds: [studentAccountId] },
  });
  assert.equal(groupSettings.response.status, 200);
  const studentGroup = await request("/api/classrooms/" + classId + "/groups", {
    method: "POST",
    cookie: studentCookie,
    body: { name: "Study team", memberIds: [otherStudent.body.user.id] },
  });
  assert.equal(studentGroup.response.status, 201);
  assert.equal(studentGroup.body.group.leaderId, studentAccountId);
  const unassignedLeader = await request("/api/classrooms/" + classId + "/groups", {
    method: "POST",
    cookie: otherStudent.cookie,
    body: { name: "Unauthorized group", memberIds: [studentAccountId] },
  });
  assert.equal(unassignedLeader.response.status, 403);

  const randomGroups = await request("/api/classrooms/" + classId + "/groups/random", {
    method: "POST",
    cookie: teacherCookie,
    body: { groupSize: 2 },
  });
  assert.equal(randomGroups.response.status, 201);
  assert.deepEqual(randomGroups.body.groups.map((group) => group.members.length), [2]);
  const manualGroups = await request("/api/classrooms/" + classId + "/groups/manual", {
    method: "POST",
    cookie: teacherCookie,
    body: {
      groups: [{
        name: "Assigned group",
        studentIds: [studentAccountId, otherStudent.body.user.id],
      }],
    },
  });
  assert.equal(manualGroups.response.status, 201);
  assert.equal(manualGroups.body.groups[0].name, "Assigned group");

  const removal = await request("/api/classrooms/" + classId + "/students/" + otherStudent.body.user.id, {
    method: "DELETE",
    cookie: teacherCookie,
  });
  assert.equal(removal.response.status, 204);
  assert.equal((await request("/api/dashboard", { cookie: otherStudent.cookie })).body.classrooms.length, 0);

  const leave = await request("/api/classrooms/" + classId, {
    method: "DELETE",
    cookie: studentCookie,
  });
  assert.equal(leave.response.status, 204);
  const leftDashboard = await request("/api/dashboard", { cookie: studentCookie });
  assert.equal(leftDashboard.body.classrooms.length, 0);
  assert.equal(leftDashboard.body.assignments.length, 0);

  const anotherTeacher = await register("Other Owner", "owner@example.test", "OwnerPass123", "teacher");
  const deniedDelete = await request("/api/classrooms/" + classId, {
    method: "DELETE",
    cookie: anotherTeacher.cookie,
  });
  assert.equal(deniedDelete.response.status, 404);

  const createdClass = await request("/api/classrooms", {
    method: "POST",
    cookie: teacherCookie,
    body: { name: "To Delete", subject: "Practice" },
  });
  const deletedClass = await request("/api/classrooms/" + createdClass.body.classroom.id, {
    method: "DELETE",
    cookie: teacherCookie,
  });
  assert.equal(deletedClass.response.status, 204);
});

test("users can securely update their account profile and password", async function () {
  const wrongPassword = await request("/api/auth/profile", {
    method: "PUT",
    cookie: teacherCookie,
    body: {
      name: "Updated Teacher",
      email: "updated.teacher@example.test",
      currentPassword: "wrong-password",
      newPassword: "",
    },
  });
  assert.equal(wrongPassword.response.status, 401);

  const updated = await request("/api/auth/profile", {
    method: "PUT",
    cookie: teacherCookie,
    body: {
      name: "Updated Teacher",
      email: "updated.teacher@example.test",
      currentPassword: "TeacherPass123",
      newPassword: "UpdatedPass123",
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.user.name, "Updated Teacher");
  assert.equal(updated.body.user.email, "updated.teacher@example.test");
  assert.equal(updated.body.user.id, teacherAccountId);

  const loginAfterEmailChange = await request("/api/auth/login", {
    method: "POST",
    body: { accountId: teacherAccountId, password: "TeacherPass123" },
  });
  assert.equal(loginAfterEmailChange.response.status, 401);
  const loginAfterPasswordChange = await request("/api/auth/login", {
    method: "POST",
    body: { accountId: teacherAccountId, password: "UpdatedPass123" },
  });
  assert.equal(loginAfterPasswordChange.response.status, 200);
  assert.equal(loginAfterPasswordChange.body.user.role, "teacher");

  const duplicateEmail = await request("/api/auth/profile", {
    method: "PUT",
    cookie: studentCookie,
    body: {
      name: "Student One",
      email: "updated.teacher@example.test",
      currentPassword: "StudentPass123",
      newPassword: "",
    },
  });
  assert.equal(duplicateEmail.response.status, 409);
});

function seedLegacyDatabase() {
  const database = new DatabaseSync(path.join(temporaryDirectory, "classroom.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE classrooms (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE enrollments (
      classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (classroom_id, student_id)
    );
    CREATE TABLE class_join_requests (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE (classroom_id, student_id)
    );
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      due_date TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points BETWEEN 1 AND 1000),
      created_at TEXT NOT NULL
    );
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      grade REAL,
      feedback TEXT NOT NULL DEFAULT '',
      graded_at TEXT,
      UNIQUE (assignment_id, student_id)
    );
  `);
  const legacyId = "legacy-user-id";
  const legacyStudentId = "legacy-student-id";
  const salt = Buffer.alloc(16, 1);
  const passwordHash = crypto.scryptSync("LegacyPass123", salt, 64);
  const insertUser = database.prepare(`
    INSERT INTO users (id, name, email, role, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(legacyId, "Legacy Teacher", "legacy@example.test", "teacher", salt.toString("hex"),
    passwordHash.toString("hex"), new Date().toISOString());
  insertUser.run(legacyStudentId, "Legacy Student", "legacy.student@example.test", "student", salt.toString("hex"),
    passwordHash.toString("hex"), new Date().toISOString());
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(crypto.createHash("sha256").update(legacySessionToken).digest("hex"), legacyId,
      new Date(Date.now() + 60 * 60 * 1000).toISOString());
  database.prepare(`
    INSERT INTO classrooms (id, teacher_id, name, subject, join_code, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-class", legacyId, "Legacy Class", "History", "LEGACY", "lilac", new Date().toISOString());
  database.prepare("INSERT INTO enrollments (classroom_id, student_id, joined_at) VALUES (?, ?, ?)")
    .run("legacy-class", legacyStudentId, new Date().toISOString());
  database.prepare(`
    INSERT INTO class_join_requests (id, classroom_id, student_id, status, requested_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("legacy-request", "legacy-class", legacyStudentId, "pending", new Date().toISOString());
  database.prepare(`
    INSERT INTO assignments (id, classroom_id, title, instructions, due_date, points, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-assignment", "legacy-class", "Legacy Assignment", "", "2099-01-01", 10, new Date().toISOString());
  database.prepare(`
    INSERT INTO submissions (id, assignment_id, student_id, content, submitted_at, grade, feedback)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-submission", "legacy-assignment", legacyStudentId, "Legacy work",
    new Date().toISOString(), 8, "Good work.");
  database.close();
}

async function register(name, email, password, role) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: { name, email, password, role },
  });
  result.cookie = result.response.headers.get("set-cookie").split(";")[0];
  return result;
}

async function request(url, options) {
  const config = Object.assign({}, options || {});
  const headers = Object.assign({}, config.headers, { Origin: baseUrl });
  if (config.cookie) headers.Cookie = config.cookie;
  if (config.body) {
    headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(baseUrl + url, {
    method: config.method || "GET",
    headers,
    body: config.body,
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function reservePort() {
  const socket = net.createServer();
  await new Promise(function (resolve, reject) {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise(function (resolve) { socket.close(resolve); });
  return address.port;
}

async function waitForServer() {
  const timeout = Date.now() + 10000;
  while (Date.now() < timeout) {
    if (server.exitCode !== null) throw new Error("Classroom server exited during startup.");
    try {
      const response = await fetch(baseUrl + "/api/health");
      if (response.ok) return;
    } catch {
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
  }
  throw new Error("Classroom server did not start in time.");
}
