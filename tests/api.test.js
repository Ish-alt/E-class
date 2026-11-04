"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

let server;
let baseUrl;
let temporaryDirectory;
let teacherCookie;
let studentCookie;
let classId;
let assignmentId;
let submissionId;
let joinRequestId;

before(async function () {
  const port = await reservePort();
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-api-test-"));
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIRECTORY: temporaryDirectory,
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

test("registers separate teacher and student accounts", async function () {
  const teacher = await register("Teacher One", "teacher@example.test", "TeacherPass123", "teacher");
  teacherCookie = teacher.cookie;
  assert.equal(teacher.response.status, 201);
  assert.equal(teacher.body.user.role, "teacher");

  const student = await register("Student One", "student@example.test", "StudentPass123", "student");
  studentCookie = student.cookie;
  assert.equal(student.response.status, 201);
  assert.equal(student.body.user.role, "student");

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

test("sessions expire on sign out and protected endpoints require authentication", async function () {
  const dashboard = await request("/api/dashboard");
  assert.equal(dashboard.response.status, 401);

  const loggedIn = await request("/api/auth/login", {
    method: "POST",
    body: { email: "student@example.test", password: "StudentPass123" },
  });
  assert.equal(loggedIn.response.status, 200);
  loggedIn.cookie = loggedIn.response.headers.get("set-cookie").split(";")[0];
  const logout = await request("/api/auth/logout", { method: "POST", cookie: loggedIn.cookie });
  assert.equal(logout.response.status, 204);
  const expired = await request("/api/dashboard", { cookie: loggedIn.cookie });
  assert.equal(expired.response.status, 401);
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

  const oldLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "teacher@example.test", password: "TeacherPass123" },
  });
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "updated.teacher@example.test", password: "UpdatedPass123" },
  });
  assert.equal(newLogin.response.status, 200);
  assert.equal(newLogin.body.user.role, "teacher");

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
