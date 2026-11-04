(function () {
  "use strict";

  const state = {
    user: null,
    view: "home",
    classrooms: [],
    assignments: [],
    submissions: [],
    joinRequests: [],
    classFilter: "all",
    workFilter: "all",
    authMode: "",
  };
  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  const pageContent = document.getElementById("page-content");
  const modalRoot = document.getElementById("modal-root");
  const toastRegion = document.getElementById("toast-region");
  let confirmationResolver = null;

  document.getElementById("current-year").textContent = new Date().getFullYear();

  document.addEventListener("click", function (event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "show-auth") {
      state.authMode = target.dataset.mode || "register";
      renderLanding();
    } else if (action === "show-landing") {
      state.authMode = "";
      renderLanding();
    } else if (action === "switch-auth") {
      state.authMode = target.dataset.mode;
      renderLanding();
    } else if (action === "set-view") {
      state.view = target.dataset.view;
      state.classFilter = "all";
      state.workFilter = "all";
      renderDashboard();
    } else if (action === "open-class") {
      state.view = "assignments";
      state.classFilter = target.dataset.classId;
      state.workFilter = "all";
      renderDashboard();
    } else if (action === "open-settings") {
      state.view = "settings";
      renderDashboard();
    } else if (action === "copy-account-id") {
      copyAccountId(target.dataset.accountId);
    } else if (action === "approve-join" || action === "decline-join" || action === "remove-student" ||
      action === "delete-class" || action === "leave-class") {
      handleMembershipAction(target);
    } else if (action === "open-create-class") {
      openCreateClassModal();
    } else if (action === "open-join-class") {
      openJoinClassModal();
    } else if (action === "open-create-assignment") {
      openCreateAssignmentModal(target.dataset.classId || "");
    } else if (action === "open-submit") {
      openSubmissionModal(target.dataset.assignmentId);
    } else if (action === "open-feedback") {
      openFeedbackModal(target.dataset.assignmentId);
    } else if (action === "set-filter") {
      state.workFilter = target.dataset.filter;
      renderDashboard();
    } else if (action === "copy-code") {
      navigator.clipboard.writeText(target.dataset.code).then(function () {
        showToast("Class code copied to your clipboard.");
      }).catch(function () {
        showToast("Copy failed. Select and copy the class code instead.", "error");
      });
    }
  });

  document.addEventListener("change", function (event) {
    if (event.target.matches("#assignment-class-filter")) {
      state.classFilter = event.target.value;
      renderDashboard();
    }
  });

  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (form.matches("[data-auth-form]")) {
      event.preventDefault();
      handleAuth(form);
    } else if (form.matches("[data-profile-form]")) {
      event.preventDefault();
      handleProfileUpdate(form);
    } else if (form.matches("[data-modal-form]")) {
      event.preventDefault();
      handleModalForm(form);
    } else if (form.matches("[data-grade-form]")) {
      event.preventDefault();
      handleGrade(form);
    }
  });

  modalRoot.addEventListener("click", function (event) {
    const target = event.target.closest("[data-confirm-action], [data-close-modal]");
    if (!target) return;
    if (target.matches("[data-confirm-action]")) {
      finishConfirmation(true);
    } else {
      closeModal();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && modalRoot.firstElementChild) closeModal();
  });

  document.getElementById("logout-button").addEventListener("click", async function () {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      showToast("Could not sign out. Please try again.", "error");
      return;
    }
    state.user = null;
    state.classrooms = [];
    state.assignments = [];
    state.submissions = [];
    state.view = "home";
    state.authMode = "";
    renderLanding();
  });

  initialize();

  async function initialize() {
    try {
      const result = await api("/api/auth/me");
      state.user = result.user;
      if (!state.user) {
        renderLanding();
        return;
      }
      await loadDashboard();
      showWorkspace();
    } catch (error) {
      if (error.status !== 401) showToast(error.message, "error");
      state.user = null;
      renderLanding();
    }
  }

  async function api(url, options) {
    const requestOptions = Object.assign({ credentials: "same-origin" }, options || {});
    if (requestOptions.body && typeof requestOptions.body !== "string") {
      requestOptions.headers = Object.assign({}, requestOptions.headers, { "Content-Type": "application/json" });
      requestOptions.body = JSON.stringify(requestOptions.body);
    }
    const response = await fetch(url, requestOptions);
    if (response.status === 204) return null;
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const error = new Error(payload.error || "Something went wrong. Please try again.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadDashboard() {
    const result = await api("/api/dashboard");
    state.user = result.user;
    state.classrooms = result.classrooms;
    state.assignments = result.assignments;
    state.submissions = result.submissions || [];
    state.joinRequests = result.joinRequests || [];
  }

  async function refreshDashboard() {
    try {
      await loadDashboard();
      showWorkspace();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function showWorkspace() {
    authScreen.hidden = true;
    appShell.hidden = false;
    renderDashboard();
  }

  function renderLanding() {
    appShell.hidden = true;
    authScreen.hidden = false;
    if (state.authMode) {
      authScreen.innerHTML = renderAuthForm();
    } else {
      authScreen.innerHTML = renderLandingPage();
    }
  }

  function renderLandingPage() {
    return '<div class="landing-page"><nav class="landing-nav"><a class="brand" href="#" data-action="show-landing" aria-label="Classroom home">' +
      brandMark() + '<span>classroom<span class="brand-period">.</span></span></a><div class="landing-nav-actions">' +
      '<button class="text-button" type="button" data-action="show-auth" data-mode="login">Sign in</button>' +
      '<button class="primary-button" type="button" data-action="show-auth" data-mode="register">Get started <span aria-hidden="true">→</span></button></div></nav>' +
      '<main><section class="landing-hero"><div class="hero-copy"><div class="hero-kicker"><span class="hero-kicker-dot"></span> A calmer way to learn together</div>' +
      '<h1>Bring your classroom<br />to <span>life.</span></h1><p>One welcoming place for teachers to share work and students to learn, grow, and get feedback.</p>' +
      '<div class="hero-actions"><button class="primary-button hero-cta" type="button" data-action="show-auth" data-mode="register">Create your free account <span aria-hidden="true">→</span></button>' +
      '<button class="secondary-button hero-signin" type="button" data-action="show-auth" data-mode="login">I already have an account</button></div>' +
      '<div class="hero-proof"><div class="proof-avatars"><span>J</span><span>M</span><span>A</span><span>+</span></div><span>Made for teachers and learners</span></div></div>' +
      '<div class="hero-art" aria-label="Illustration of a classroom"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>' +
      '<div class="art-sun">✦</div><div class="art-board"><div class="board-top"><span></span><span></span><span></span></div><div class="board-title">Today is a good day<br />to learn something new.</div>' +
      '<div class="board-line"></div><div class="board-scribble">✳</div><div class="board-bottom"><span>♡</span><span>✿</span><span>↗</span></div></div>' +
      '<div class="art-note note-left"><span class="note-icon">✎</span><span><strong>Thoughtful feedback</strong><small>Every step counts</small></span></div>' +
      '<div class="art-note note-right"><span class="note-check">✓</span><span><strong>Assignment turned in</strong><small>Just now · Biology 101</small></span></div>' +
      '<div class="art-flower flower-one">✿</div><div class="art-flower flower-two">✽</div></div></section>' +
      '<section class="landing-features"><div><span class="feature-icon feature-purple">▦</span><h2>Your classes, together</h2><p>Teachers create a class. Students join with a simple class code.</p></div>' +
      '<div><span class="feature-icon feature-green">↗</span><h2>Work that gets seen</h2><p>Turn in assignments and know your teacher has received them.</p></div>' +
      '<div><span class="feature-icon feature-orange">♡</span><h2>Feedback that helps</h2><p>See your grade and your teacher’s notes, all in one place.</p></div></section></main>' +
      '<footer class="landing-footer"><span>Made for curious minds <span class="footer-heart">♥</span></span><span>Classroom ' + new Date().getFullYear() + '</span></footer></div>';
  }

  function renderAuthForm() {
    const isRegister = state.authMode === "register";
    return '<div class="auth-layout"><aside class="auth-side"><a class="brand auth-brand" href="#" data-action="show-landing">' + brandMark() +
      '<span>classroom<span class="brand-period">.</span></span></a><div class="auth-side-copy"><span class="auth-side-spark">✦</span>' +
      '<h2>A little progress<br />every day.</h2><p>Your classroom is ready when you are.</p></div><div class="auth-side-bottom">Learn together. Grow together.</div></aside>' +
      '<main class="auth-main"><button class="auth-back" type="button" data-action="show-landing">← <span>Back to home</span></button>' +
      '<section class="auth-card"><div class="auth-card-mark">' + brandMark() + '</div><p class="eyebrow">' + (isRegister ? "GET STARTED" : "WELCOME BACK") +
      '</p><h1>' + (isRegister ? "Create your account" : "Welcome back") + '</h1><p class="auth-subtitle">' +
      (isRegister ? "Choose your role to get started with your classroom." : "Sign in to pick up where you left off.") + '</p>' +
      '<form data-auth-form data-mode="' + (isRegister ? "register" : "login") + '">' +
      (isRegister ? '<div class="form-field"><label for="auth-name">Your name</label><input id="auth-name" name="name" type="text" autocomplete="name" minlength="2" maxlength="80" required placeholder="e.g. Jamie Lee" /></div>' : "") +
      (isRegister ? '<div class="form-field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com" /></div>' :
        '<div class="form-field"><label for="auth-account-id">Classroom ID</label><input id="auth-account-id" name="accountId" type="text" autocomplete="username" maxlength="8" required placeholder="e.g. AA-45-BC" /></div>') +
      '<div class="form-field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="' + (isRegister ? "new-password" : "current-password") +
      '" minlength="' + (isRegister ? "10" : "1") + '" maxlength="200" required placeholder="' + (isRegister ? "At least 10 characters" : "Enter your password") + '" /></div>' +
      (isRegister ? '<fieldset class="role-options"><legend>I’m joining as a...</legend><label class="role-option"><input type="radio" name="role" value="teacher" checked /><span class="role-option-icon">✎</span><span><strong>Teacher</strong><small>Create classes and assignments</small></span><span class="radio-dot"></span></label>' +
      '<label class="role-option"><input type="radio" name="role" value="student" /><span class="role-option-icon">▤</span><span><strong>Student</strong><small>Join a class and turn in work</small></span><span class="radio-dot"></span></label></fieldset>' : "") +
      '<button class="primary-button auth-submit" type="submit">' + (isRegister ? "Create account" : "Sign in") + ' <span aria-hidden="true">→</span></button></form>' +
      '<p class="auth-switch">' + (isRegister ? 'Already have an account? <button type="button" data-action="switch-auth" data-mode="login">Sign in</button>' :
      'New to Classroom? <button type="button" data-action="switch-auth" data-mode="register">Create an account</button>') + '</p></section>' +
      '<p class="auth-legal">By continuing, you agree to use Classroom respectfully.</p></main></div>';
  }

  async function handleAuth(form) {
    const submit = form.querySelector('[type="submit"]');
    const isRegister = form.dataset.mode === "register";
    submit.disabled = true;
    try {
      const formData = new FormData(form);
      const body = {
        password: formData.get("password"),
      };
      if (isRegister) {
        body.name = formData.get("name");
        body.email = formData.get("email");
        body.role = formData.get("role");
      } else {
        body.accountId = formData.get("accountId");
      }
      const result = await api("/api/auth/" + form.dataset.mode, { method: "POST", body });
      state.user = result.user;
      await loadDashboard();
      state.view = "home";
      showWorkspace();
      if (isRegister) {
        openAccountIdModal(state.user.id);
      } else {
        showToast("Welcome back, " + state.user.name + ".");
      }
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  }

  function renderDashboard() {
    if (!state.user) {
      renderLanding();
      return;
    }
    updateChrome();
    if (state.view === "settings") {
      pageContent.innerHTML = renderSettings();
    } else if (state.view === "classes") {
      pageContent.innerHTML = renderClasses();
    } else if (state.view === "assignments") {
      pageContent.innerHTML = renderAssignments();
    } else if (state.user.role === "teacher") {
      pageContent.innerHTML = renderTeacherHome();
    } else {
      pageContent.innerHTML = renderStudentHome();
    }
  }

  function updateChrome() {
    const user = state.user;
    const initials = getInitials(user.name);
    document.getElementById("sidebar-name").textContent = user.name;
    document.getElementById("sidebar-role").textContent = user.role === "teacher" ? "Teacher account" : "Student account";
    document.getElementById("sidebar-avatar").textContent = initials;
    document.getElementById("top-avatar").textContent = initials;
    document.getElementById("sidebar-avatar").className = "avatar " + (user.role === "teacher" ? "avatar-green" : "avatar-plum");
    document.getElementById("top-avatar").className = "avatar top-avatar " + (user.role === "teacher" ? "avatar-green" : "avatar-plum");
    const pending = user.role === "teacher"
      ? state.submissions.filter(function (submission) { return submission.grade === null; }).length
      : state.assignments.filter(function (assignment) { return !assignment.submission; }).length;
    document.getElementById("nav-count").textContent = String(pending);
    document.getElementById("course-nav").innerHTML = state.classrooms.map(function (classroom) {
      return '<button class="course-link" type="button" data-action="open-class" data-class-id="' + escapeHtml(classroom.id) + '">' +
        '<span class="course-dot" style="background:var(--' + escapeHtml(classroom.color) + '-color)"></span><span>' +
        escapeHtml(classroom.name) + '</span></button>';
    }).join("");
    const title = state.view === "home" ? "Home" : state.view === "classes" ? "My classes" :
      state.view === "settings" ? "Settings" : "Assignments";
    document.getElementById("breadcrumb-current").textContent = title;
    document.querySelectorAll(".nav-link").forEach(function (button) {
      button.classList.toggle("active", button.dataset.view === state.view ||
        (!button.dataset.view && button.dataset.action === "open-settings" && state.view === "settings"));
    });
  }

  function renderStudentHome() {
    const gradedAssignments = sortAssignments(state.assignments).filter(function (assignment) {
      return assignment.submission && assignment.submission.grade !== null;
    }).sort(function (a, b) {
      return new Date(b.submission.submittedAt) - new Date(a.submission.submittedAt);
    });
    const assignments = sortAssignments(state.assignments).filter(function (assignment) {
      return !assignment.submission || assignment.submission.grade === null;
    });
    const toDo = assignments.filter(function (assignment) { return !assignment.submission; }).length;
    const turnedIn = assignments.filter(function (assignment) { return assignment.submission && assignment.submission.grade === null; }).length;
    const graded = state.assignments.filter(function (assignment) { return assignment.submission && assignment.submission.grade !== null; }).length;
    const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
    const nextAction = state.classrooms.length
      ? '<button class="primary-button" type="button" data-action="open-join-class"><span>Join a class</span><span aria-hidden="true">＋</span></button>'
      : '<button class="primary-button" type="button" data-action="open-join-class"><span>Join your first class</span><span aria-hidden="true">→</span></button>';
    return '<div class="welcome-row"><div><p class="eyebrow">YOUR LEARNING SPACE</p><h1>' + greeting + ', ' + escapeHtml(firstName(state.user.name)) + ' <span aria-hidden="true">✦</span></h1>' +
      '<p class="page-subtitle">A little progress each day adds up to big results.</p></div>' + nextAction + '</div><div class="stats-grid">' +
      statCard("▤", "purple", "To do", toDo) + statCard("↗", "green", "Turned in", turnedIn) + statCard("✓", "orange", "Graded", graded) +
      '</div>' + renderStudentGradeOverview(gradedAssignments) + '<div class="content-grid"><section><div class="section-heading"><div><h2>Coming up</h2><p>Your next assignments, all in one place</p></div>' +
      '<button class="text-button" type="button" data-action="set-view" data-view="classes">My classes <span aria-hidden="true">→</span></button></div>' +
      '<div class="assignment-list">' + (assignments.length
        ? assignments.slice(0, 5).map(renderStudentAssignment).join("")
        : emptyState(state.classrooms.length ? "All caught up!" : "Join a class to get started", state.classrooms.length ? "You have no assignments waiting right now." : "Ask your teacher for a class code, then join your first classroom.")) +
      '</div></section>' + renderUpcomingPanel() + '</div>';
  }

  function renderTeacherHome() {
    const pending = state.submissions.filter(function (submission) { return submission.grade === null; });
    return '<div class="welcome-row"><div><p class="eyebrow">TEACHER WORKSPACE</p><h1>Welcome back, ' + escapeHtml(firstName(state.user.name)) + ' <span aria-hidden="true">✦</span></h1>' +
      '<p class="page-subtitle">Your classroom is ready for another day of learning.</p></div><button class="primary-button" type="button" data-action="open-create-class"><span class="button-plus">＋</span><span>Create a class</span></button></div>' +
      '<div class="stats-grid">' + statCard("▦", "purple", "My classes", state.classrooms.length) +
      statCard("↙", "orange", "To review", pending.length) + statCard("▤", "green", "Assignments", state.assignments.length) + '</div>' +
      '<div class="section-heading"><div><h2>Your classrooms</h2><p>Share a join code so students can join.</p></div>' +
      '<button class="text-button" type="button" data-action="set-view" data-view="classes">View all <span aria-hidden="true">→</span></button></div>' +
      (state.classrooms.length ? '<div class="class-grid">' + state.classrooms.slice(0, 3).map(renderTeacherClassCard).join("") + '</div>' : emptyState("Create your first class", "Start a classroom, then share its join code with your students.")) +
      '<div class="section-heading teacher-inbox-heading"><div><h2>Needs your attention</h2><p>Submissions waiting for your feedback</p></div>' +
      '<button class="text-button" type="button" data-action="set-view" data-view="assignments">Assignment inbox <span aria-hidden="true">→</span></button></div>' +
      '<div class="inbox-list">' + (pending.length ? pending.slice(0, 3).map(renderTeacherSubmission).join("") : emptyState("Inbox is clear", "Student submissions will appear here.")) + '</div>';
  }

  function renderClasses() {
    const teacher = state.user.role === "teacher";
    const actions = teacher
      ? '<button class="primary-button" type="button" data-action="open-create-class"><span class="button-plus">＋</span><span>Create a class</span></button>'
      : '<button class="primary-button" type="button" data-action="open-join-class"><span>Join a class</span><span aria-hidden="true">＋</span></button>';
    const requests = teacher ? renderPendingClassRequests() : renderStudentJoinRequests();
    return '<div class="welcome-row"><div><p class="eyebrow">' + (teacher ? "TEACHER WORKSPACE" : "YOUR LEARNING SPACE") +
      '</p><h1>My classes</h1><p class="page-subtitle">' + (teacher ? "Manage your classrooms and invite students to join." : "Your classes, assignments, and teachers in one place.") +
      '</p></div>' + actions + '</div>' + requests + (state.classrooms.length
      ? '<div class="class-grid">' + state.classrooms.map(teacher ? renderTeacherClassCard : renderStudentClassCard).join("") + '</div>'
      : emptyState(teacher ? "No classes yet" : "You have not joined a class yet", teacher
        ? "Create your first classroom and share its join code with students."
        : "Ask your teacher for a class code and join to see assignments."));
  }

  function renderAssignments() {
    if (state.user.role === "teacher") return renderTeacherAssignments();
    let assignments = sortAssignments(state.assignments);
    if (state.classFilter !== "all") assignments = assignments.filter(function (item) { return item.classroomId === state.classFilter; });
    const visible = assignments.filter(function (item) {
      const status = item.submission ? (item.submission.grade === null ? "submitted" : "graded") : "todo";
      return state.workFilter === "all" || state.workFilter === status;
    });
    const className = state.classFilter === "all" ? "All your classes" : (getClassroom(state.classFilter) || {}).name || "All classes";
    return '<div class="welcome-row"><div><p class="eyebrow">STUDENT WORKSPACE</p><h1>Assignments</h1><p class="page-subtitle">' +
      escapeHtml(className) + ' · Keep track of what is due and what you have turned in.</p></div></div>' +
      filterTabs([["all", "All work"], ["todo", "To do"], ["submitted", "Turned in"], ["graded", "Graded"]]) +
      '<div class="assignment-list">' + (visible.length ? visible.map(renderStudentAssignment).join("") : emptyState("Nothing here yet", "Assignments matching this filter will show up here.")) + '</div>';
  }

  function renderTeacherAssignments() {
    let assignments = state.assignments;
    if (state.classFilter !== "all") assignments = assignments.filter(function (item) { return item.classroomId === state.classFilter; });
    const assignmentIds = new Set(assignments.map(function (item) { return item.id; }));
    let submissions = state.submissions.filter(function (item) { return assignmentIds.has(item.assignmentId); });
    if (state.workFilter === "submitted") submissions = submissions.filter(function (item) { return item.grade === null; });
    if (state.workFilter === "graded") submissions = submissions.filter(function (item) { return item.grade !== null; });
    const classOptions = '<option value="all"' + selected(state.classFilter, "all") + '>All classes</option>' +
      state.classrooms.map(function (classroom) {
        return '<option value="' + escapeHtml(classroom.id) + '"' + selected(state.classFilter, classroom.id) + '>' + escapeHtml(classroom.name) + '</option>';
      }).join("");
    return '<div class="welcome-row"><div><p class="eyebrow">TEACHER WORKSPACE</p><h1>Assignment inbox</h1><p class="page-subtitle">Review student work and share helpful feedback.</p></div></div>' +
      '<div class="section-heading"><div><h2>Student submissions</h2><p>' + submissions.length + (submissions.length === 1 ? " submission" : " submissions") + ' in your inbox</p></div>' +
      '<div class="inbox-toolbar"><select class="select-control" id="assignment-class-filter" aria-label="Filter by class">' + classOptions + '</select></div></div>' +
      filterTabs([["all", "All submissions"], ["submitted", "Needs grading"], ["graded", "Graded"]]) +
      '<div class="inbox-list">' + (submissions.length ? submissions.map(renderTeacherSubmission).join("") : emptyState("No submissions to show", "Student work for your classes will appear here.")) + '</div>';
  }

  function renderTeacherClassCard(classroom) {
    const assignmentCount = state.assignments.filter(function (item) { return item.classroomId === classroom.id; }).length;
    const pendingCount = state.submissions.filter(function (item) {
      return item.classroomId === classroom.id && item.grade === null;
    }).length;
    return '<article class="class-card"><div class="class-banner ' + safeColor(classroom.color) + '"><small>' + escapeHtml(classroom.subject) +
      '</small><strong>' + escapeHtml(classroom.name) + '</strong></div><div class="class-card-body"><div class="class-teacher">' +
      escapeHtml(String(classroom.studentCount)) + (classroom.studentCount === 1 ? " student" : " students") + ' · ' + assignmentCount +
      (assignmentCount === 1 ? " assignment" : " assignments") + '</div><div class="class-join-code"><span>CLASS CODE</span><strong>' + escapeHtml(classroom.joinCode) +
      '</strong><button class="small-action" type="button" data-action="copy-code" data-code="' + escapeHtml(classroom.joinCode) + '">Copy</button></div>' +
      renderStudentRoster(classroom) + '<div class="class-card-bottom"><span>' + pendingCount + ' to review</span><button class="small-action" type="button" data-action="open-create-assignment" data-class-id="' +
      escapeHtml(classroom.id) + '">＋ Assignment</button><button class="small-action destructive-action" type="button" data-action="delete-class" data-class-id="' +
      escapeHtml(classroom.id) + '" data-class-name="' + escapeHtml(classroom.name) + '">Delete class</button></div></div></article>';
  }

  function renderStudentGradeOverview(assignments) {
    const earned = assignments.reduce(function (total, assignment) {
      return total + assignment.submission.grade;
    }, 0);
    const available = assignments.reduce(function (total, assignment) {
      return total + assignment.points;
    }, 0);
    const percentage = available ? Math.round((earned / available) * 100) : 0;
    const gradeRows = assignments.slice(0, 3).map(function (assignment) {
      const classroom = getClassroom(assignment.classroomId) || { name: "Class" };
      const score = Math.max(0, Math.min(100, Math.round((assignment.submission.grade / assignment.points) * 100)));
      return '<button class="grade-row" type="button" data-action="open-feedback" data-assignment-id="' +
        escapeHtml(assignment.id) + '"><span class="grade-row-main"><span class="grade-row-title">' +
        escapeHtml(assignment.title) + '</span><span class="grade-row-class">' + escapeHtml(classroom.name) +
        '</span><span class="grade-progress"><span style="width:' + score + '%"></span></span></span>' +
        '<span class="grade-row-score">' + escapeHtml(String(assignment.submission.grade)) + '<small>/' +
        assignment.points + '</small></span></button>';
    }).join("");
    const visual = assignments.length
      ? '<div class="grade-ring" style="--grade-angle:' + percentage * 3.6 + 'deg"><div class="grade-ring-center"><strong>' +
        percentage + '%</strong><span>average</span></div></div>'
      : '<div class="grade-ring grade-ring-empty"><div class="grade-ring-center"><strong>—</strong><span>average</span></div></div>';
    return '<section class="grades-overview" aria-labelledby="grades-title"><div class="grades-heading"><div><p class="eyebrow">YOUR PROGRESS</p>' +
      '<h2 id="grades-title">Your grades</h2></div><span class="grades-count">' + assignments.length + (assignments.length === 1 ? " graded assignment" : " graded assignments") +
      '</span></div><div class="grades-panel">' + visual + '<div class="grade-points"><span>Points earned</span><strong>' +
      (assignments.length ? escapeHtml(String(earned)) + '<small> / ' + available + '</small>' : "Not graded yet") +
      '</strong><span class="grade-encouragement">' + (assignments.length ? "Keep up the great work!" : "Your scores will show here after your teacher grades your work.") +
      '</span></div><div class="recent-grades">' + (gradeRows || '<div class="grades-empty">Turn in your assignments to start building your grade history.</div>') +
      '</div></div></section>';
  }

  function renderStudentRoster(classroom) {
    const students = classroom.students || [];
    return '<section class="student-roster" aria-label="Enrolled students"><div class="roster-heading"><strong>Enrolled students</strong>' +
      '<span>' + students.length + '</span></div>' + (students.length
        ? '<ul class="roster-list">' + students.map(function (student) {
          return '<li class="roster-student"><span class="avatar avatar-blue">' + escapeHtml(getInitials(student.name)) +
            '</span><span class="roster-student-copy"><strong>' + escapeHtml(student.name) + '</strong><small>' +
            escapeHtml(student.email) + '</small></span><span class="roster-joined">Joined ' + formatDate(student.joinedAt.slice(0, 10)) +
            '</span><button class="small-action roster-remove" type="button" data-action="remove-student" data-class-id="' +
            escapeHtml(classroom.id) + '" data-student-id="' + escapeHtml(student.id) + '" data-student-name="' +
            escapeHtml(student.name) + '">Remove</button></li>';
        }).join("") + '</ul>'
        : '<p class="roster-empty">No students have joined yet. Share the class code above.</p>') + '</section>';
  }

  function renderStudentClassCard(classroom) {
    const count = state.assignments.filter(function (item) { return item.classroomId === classroom.id; }).length;
    return '<article class="class-card"><div class="class-banner ' + safeColor(classroom.color) + '"><small>' + escapeHtml(classroom.subject) +
      '</small><strong>' + escapeHtml(classroom.name) + '</strong></div><div class="class-card-body"><div class="class-teacher">with ' +
      escapeHtml(classroom.teacherName || "your teacher") + '</div><div class="class-card-bottom"><span>' + count + (count === 1 ? " assignment" : " assignments") +
      '</span><button class="small-action" type="button" data-action="open-class" data-class-id="' + escapeHtml(classroom.id) + '">View work →</button>' +
      '<button class="small-action destructive-action" type="button" data-action="leave-class" data-class-id="' + escapeHtml(classroom.id) +
      '" data-class-name="' + escapeHtml(classroom.name) + '">Leave class</button></div></div></article>';
  }

  function renderStudentAssignment(assignment) {
    const classroom = getClassroom(assignment.classroomId) || { name: "Class", color: "lilac" };
    const submission = assignment.submission;
    const status = !submission ? "todo" : submission.grade === null ? "submitted" : "graded";
    const label = { todo: "To do", submitted: "Turned in", graded: "Graded" }[status];
    const action = status === "todo" ? "open-submit" : "open-feedback";
    const actionLabel = status === "todo" ? "Turn in" : status === "submitted" ? "View submission" : "See feedback";
    const secondary = status === "todo" ? "Due " + formatDate(assignment.dueDate)
      : submission.grade !== null ? submission.grade + "/" + assignment.points + " points" : "Submitted";
    return '<article class="assignment-card"><div class="assignment-main"><div class="subject-icon ' + safeColor(classroom.color) + '">' + classIcon(classroom.subject) + '</div>' +
      '<div class="assignment-copy"><h3>' + escapeHtml(assignment.title) + '</h3><p>' + escapeHtml(classroom.name) + '</p><div class="assignment-meta"><span>' +
      escapeHtml(secondary) + '</span><span class="meta-dot"></span><span>' + assignment.points + ' points</span></div></div></div>' +
      '<div class="assignment-actions"><span class="status-pill status-' + status + '">' + label + '</span><button class="small-action" type="button" data-action="' +
      action + '" data-assignment-id="' + escapeHtml(assignment.id) + '">' + actionLabel + ' →</button></div></article>';
  }

  function renderTeacherSubmission(submission) {
    const classroom = getClassroom(submission.classroomId) || { name: "Class" };
    const assignment = state.assignments.find(function (item) { return item.id === submission.assignmentId; });
    if (!assignment) return "";
    const date = new Date(submission.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return '<article class="submission-card"><div class="submission-top"><div class="student-identity"><div class="avatar avatar-blue">' +
      escapeHtml(getInitials(submission.studentName)) + '</div><div class="student-identity-copy"><strong>' + escapeHtml(submission.studentName) +
      '</strong><span>' + escapeHtml(classroom.name) + ' · ' + escapeHtml(assignment.title) + '</span></div></div><span class="submitted-time">' + date +
      '</span></div><div class="student-work">' + escapeHtml(submission.content) + '</div>' +
      (submission.grade !== null ? '<div class="graded-feedback"><span class="grade-score">' + submission.grade + '/' + assignment.points + ' pts</span><span>' +
        escapeHtml(submission.feedback || "Graded — no written feedback.") + '</span></div>' :
        '<form class="grading-row" data-grade-form data-submission-id="' + escapeHtml(submission.id) + '"><div class="grade-field"><label for="grade-' +
        escapeHtml(submission.id) + '">Grade / ' + assignment.points + '</label><input id="grade-' + escapeHtml(submission.id) +
        '" name="grade" type="number" min="0" max="' + assignment.points + '" step="0.5" placeholder="e.g. 18" required /></div>' +
        '<div class="feedback-field"><label for="feedback-' + escapeHtml(submission.id) + '">Feedback</label><input id="feedback-' +
        escapeHtml(submission.id) + '" name="feedback" type="text" maxlength="1000" placeholder="Share a helpful note..." /></div>' +
        '<button class="primary-button" type="submit">Return grade</button></form>') + '</article>';
  }

  function renderUpcomingPanel() {
    const upcoming = sortAssignments(state.assignments).filter(function (assignment) {
      return state.user.role === "teacher" || !assignment.submission;
    }).slice(0, 3);
    return '<aside class="side-panel"><div class="panel-heading"><h2>' + (state.user.role === "teacher" ? "Upcoming deadlines" : "Coming up soon") +
      '</h2><p>A quick look at what is next</p></div><div class="upcoming-list">' + (upcoming.length ? upcoming.map(function (assignment) {
      const date = dateLabel(assignment.dueDate);
      const classroom = getClassroom(assignment.classroomId) || { name: "Class" };
      return '<div class="upcoming-item"><div class="date-tile"><span>' + date.month + '</span><strong>' + date.day + '</strong></div>' +
        '<div class="upcoming-copy"><strong>' + escapeHtml(assignment.title) + '</strong><span>' + escapeHtml(classroom.name) + ' · ' +
        relativeDate(assignment.dueDate) + '</span></div></div>';
    }).join("") : '<div class="upcoming-copy" style="padding:14px 0"><strong>You are all caught up!</strong><span>No upcoming deadlines.</span></div>') +
      '</div></aside>';
  }

  function openCreateClassModal() {
    openModal("Create a class", "Set up a classroom and invite your students.", '<form class="modal-form" data-modal-form="create-class">' +
      '<div class="form-field"><label for="class-name">Class name</label><input id="class-name" name="name" required minlength="2" maxlength="100" placeholder="e.g. Biology 101" /></div>' +
      '<div class="form-field"><label for="class-subject">Subject</label><input id="class-subject" name="subject" required minlength="2" maxlength="80" placeholder="e.g. Science" /></div>' +
      modalFooter("Create class") + '</form>');
  }

  function openJoinClassModal() {
    openModal("Request to join a class", "Enter the class code. The class teacher must approve your request.", '<form class="modal-form" data-modal-form="join-class">' +
      '<div class="form-field"><label for="join-code">Class code</label><input id="join-code" name="joinCode" required minlength="6" maxlength="6" pattern="[A-Za-z0-9]{6}" autocomplete="off" placeholder="e.g. 7K2M9Q" class="join-code-input" /></div>' +
      modalFooter("Join class") + '</form>');
  }

  function renderPendingClassRequests() {
    const requests = state.classrooms.flatMap(function (classroom) {
      return (classroom.joinRequests || []).map(function (request) {
        return { classroom: classroom, request: request };
      });
    });
    if (!requests.length) return "";
    return '<section class="join-requests-section"><div class="section-heading"><div><h2>Requests to join</h2><p>Approve students before they can see classwork.</p></div>' +
      '<span class="status-pill status-submitted">' + requests.length + ' waiting</span></div><div class="join-request-list">' +
      requests.map(function (item) {
        return '<article class="join-request-card"><span class="avatar avatar-orange">' + escapeHtml(getInitials(item.request.studentName)) +
          '</span><div class="join-request-copy"><strong>' + escapeHtml(item.request.studentName) + '</strong><span>' +
          escapeHtml(item.request.studentEmail) + ' · ' + escapeHtml(item.classroom.name) + '</span></div>' +
          '<div class="join-request-actions"><button class="primary-button" type="button" data-action="approve-join" data-class-id="' +
          escapeHtml(item.classroom.id) + '" data-request-id="' + escapeHtml(item.request.id) + '">Approve</button>' +
          '<button class="secondary-button" type="button" data-action="decline-join" data-class-id="' + escapeHtml(item.classroom.id) +
          '" data-request-id="' + escapeHtml(item.request.id) + '">Decline</button></div></article>';
      }).join("") + '</div></section>';
  }

  function renderStudentJoinRequests() {
    if (!state.joinRequests.length) return "";
    return '<section class="join-requests-section"><div class="section-heading"><div><h2>Waiting for approval</h2>' +
      '<p>Your teachers need to approve these class requests.</p></div></div><div class="join-request-list">' +
      state.joinRequests.map(function (request) {
        return '<article class="join-request-card"><span class="avatar avatar-orange">…</span><div class="join-request-copy"><strong>' +
          escapeHtml(request.classroomName) + '</strong><span>' + escapeHtml(request.subject) + ' · Teacher ' +
          escapeHtml(request.teacherName) + '</span></div><span class="status-pill status-todo">Pending</span></article>';
      }).join("") + '</div></section>';
  }

  function renderSettings() {
    return '<div class="welcome-row"><div><p class="eyebrow">YOUR ACCOUNT</p><h1>Profile & settings</h1>' +
      '<p class="page-subtitle">Manage your personal information and account password.</p></div></div>' +
      '<section class="settings-card"><div class="settings-card-heading"><div class="avatar ' +
      (state.user.role === "teacher" ? "avatar-green" : "avatar-plum") + '">' + escapeHtml(getInitials(state.user.name)) +
      '</div><div><h2>' + escapeHtml(state.user.name) + '</h2><p>' + (state.user.role === "teacher" ? "Teacher account" : "Student account") + '</p></div></div>' +
      '<div class="account-id-card"><div><span>Your Classroom ID</span><strong>' + escapeHtml(state.user.id) +
      '</strong><small>Use this ID and your password to sign in.</small></div><button class="secondary-button" type="button" data-action="copy-account-id" data-account-id="' +
      escapeHtml(state.user.id) + '">Copy ID</button></div>' +
      '<form class="settings-form" data-profile-form><div class="form-field"><label for="profile-name">Full name</label><input id="profile-name" name="name" value="' +
      escapeHtml(state.user.name) + '" minlength="2" maxlength="80" required /></div><div class="form-field"><label for="profile-email">Contact email</label>' +
      '<input id="profile-email" name="email" type="email" value="' + escapeHtml(state.user.email) + '" maxlength="254" required /></div>' +
      '<div class="settings-password-section"><h3>Change password</h3><p>Leave the new password blank to keep your current password.</p>' +
      '<div class="form-field"><label for="profile-current-password">Current password <span class="required-note">required to save changes</span></label>' +
      '<input id="profile-current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="200" required /></div>' +
      '<div class="form-field"><label for="profile-new-password">New password</label><input id="profile-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="200" placeholder="At least 10 characters" />' +
      '<span class="field-hint">Only fill this in if you want to change your password.</span></div></div>' +
      '<div class="settings-form-footer"><button class="primary-button" type="submit">Save changes</button></div></form></section>';
  }

  function openCreateAssignmentModal(classId) {
    if (!state.classrooms.length) {
      showToast("Create a class before adding an assignment.", "error");
      return;
    }
    const options = state.classrooms.map(function (classroom) {
      return '<option value="' + escapeHtml(classroom.id) + '"' + selected(classId || state.classrooms[0].id, classroom.id) + '>' +
        escapeHtml(classroom.name) + '</option>';
    }).join("");
    openModal("Create an assignment", "Share a new piece of work with your class.", '<form class="modal-form" data-modal-form="create-assignment">' +
      '<div class="form-field"><label for="assignment-title">Assignment title</label><input id="assignment-title" name="title" required maxlength="100" placeholder="e.g. Chapter 4 reflection" /></div>' +
      '<div class="form-field"><label for="assignment-instructions">Instructions</label><textarea id="assignment-instructions" name="instructions" required maxlength="2000" placeholder="Tell students what they need to do..."></textarea></div>' +
      '<div class="form-row"><div class="form-field"><label for="assignment-class">Class</label><select id="assignment-class" name="classroomId">' + options + '</select></div>' +
      '<div class="form-field"><label for="assignment-due">Due date</label><input id="assignment-due" name="dueDate" type="date" min="' + new Date().toISOString().slice(0, 10) + '" required /></div></div>' +
      '<div class="form-field"><label for="assignment-points">Points</label><input id="assignment-points" name="points" type="number" min="1" max="1000" value="20" required /></div>' +
      modalFooter("Create assignment") + '</form>');
  }

  function openSubmissionModal(assignmentId) {
    const assignment = state.assignments.find(function (item) { return item.id === assignmentId; });
    if (!assignment) return;
    const classroom = getClassroom(assignment.classroomId) || { name: "Class" };
    const existing = assignment.submission;
    const disabled = existing && existing.grade !== null;
    openModal(disabled ? "Your submission" : existing ? "Update your work" : "Turn in your work",
      escapeHtml(assignment.title) + " · " + escapeHtml(classroom.name),
      '<form class="modal-form" data-modal-form="submission" data-assignment-id="' + escapeHtml(assignment.id) + '">' +
      '<div class="instructions-box"><div class="instructions-heading">ASSIGNMENT INSTRUCTIONS</div><p>' + escapeHtml(assignment.instructions) +
      '</p><span>Due ' + formatDate(assignment.dueDate) + ' · ' + assignment.points + ' points</span></div>' +
      '<div class="form-field"><label for="submission-content">Your work</label><textarea id="submission-content" name="content" required minlength="2" maxlength="5000" ' +
      (disabled ? "disabled" : "") + ' placeholder="Write your answer or paste your work here...">' + escapeHtml(existing ? existing.content : "") +
      '</textarea><span class="field-hint">' + (disabled ? "Your teacher has graded this work." : "You can update your submission until it is graded.") + '</span></div>' +
      (disabled ? '<div class="graded-feedback"><span class="grade-score">' + existing.grade + '/' + assignment.points + ' pts</span><span>' +
        escapeHtml(existing.feedback || "Your work has been graded.") + '</span></div>' : modalFooter(existing ? "Update submission" : "Turn in assignment")) + '</form>');
  }

  function openFeedbackModal(assignmentId) {
    const assignment = state.assignments.find(function (item) { return item.id === assignmentId; });
    if (!assignment || !assignment.submission) return;
    const classroom = getClassroom(assignment.classroomId) || { name: "Class" };
    const submission = assignment.submission;
    openModal(submission.grade === null ? "Your submission" : "Grade & feedback",
      escapeHtml(assignment.title) + " · " + escapeHtml(classroom.name),
      '<div class="modal-form"><div class="form-field"><label>Your work</label><div class="student-work">' + escapeHtml(submission.content) +
      '</div>' + (submission.grade === null ? '<div class="field-hint">Your teacher has received your work. Check back here for your grade.</div>' :
        '<div class="graded-feedback"><span class="grade-score">' + submission.grade + '/' + assignment.points + ' pts</span><span>' +
        escapeHtml(submission.feedback || "Your work has been graded.") + '</span></div>') +
      '</div><footer class="modal-footer"><button class="primary-button" type="button" data-close-modal>Done</button></footer></div>');
  }

  function openModal(title, subtitle, content) {
    modalRoot.innerHTML = '<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<header class="modal-header"><div><h2 id="modal-title">' + title + '</h2><p>' + subtitle + '</p></div>' +
      '<button class="modal-close" type="button" data-close-modal aria-label="Close">×</button></header>' + content + '</section></div>';
    const focusTarget = modalRoot.querySelector("input:not([disabled]), textarea:not([disabled]), select:not([disabled])");
    if (focusTarget) focusTarget.focus();
  }

  function modalFooter(label) {
    return '<footer class="modal-footer"><button class="secondary-button" type="button" data-close-modal>Cancel</button>' +
      '<button class="primary-button" type="submit">' + escapeHtml(label) + '</button></footer>';
  }

  function closeModal() {
    modalRoot.innerHTML = "";
    if (confirmationResolver) {
      const resolve = confirmationResolver;
      confirmationResolver = null;
      resolve(false);
    }
  }

  function openAccountIdModal(accountId) {
    openModal("Your Classroom ID", "Save this ID. You’ll use it whenever you sign in.", '<div class="account-id-content">' +
      '<div class="account-id-display"><span>Your ID</span><strong>' + escapeHtml(accountId) + '</strong></div>' +
      '<button class="secondary-button account-id-copy" type="button" data-action="copy-account-id" data-account-id="' +
      escapeHtml(accountId) + '">Copy ID</button><footer class="modal-footer"><button class="primary-button" type="button" data-close-modal>Continue to Classroom</button></footer></div>');
    modalRoot.querySelector("button[data-close-modal]").focus();
  }

  function copyAccountId(accountId) {
    navigator.clipboard.writeText(accountId).then(function () {
      showToast("Classroom ID copied to your clipboard.");
    }).catch(function () {
      showToast("Copy failed. Select and copy the Classroom ID instead.", "error");
    });
  }

  function finishConfirmation(confirmed) {
    const resolve = confirmationResolver;
    confirmationResolver = null;
    closeModal();
    if (resolve) resolve(confirmed);
  }

  function confirmAction(title, message, confirmLabel) {
    return new Promise(function (resolve) {
      confirmationResolver = resolve;
      openModal(title, "Please confirm this action.", '<div class="confirmation-content"><p>' +
        escapeHtml(message) + '</p><footer class="modal-footer"><button class="secondary-button" type="button" data-close-modal>Cancel</button>' +
        '<button class="primary-button danger-button" type="button" data-confirm-action>' + escapeHtml(confirmLabel) +
        '</button></footer></div>');
      modalRoot.querySelector("[data-confirm-action]").focus();
    });
  }

  async function handleModalForm(form) {
    const type = form.dataset.modalForm;
    const formData = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (type === "create-class") {
        await api("/api/classrooms", {
          method: "POST",
          body: { name: formData.get("name"), subject: formData.get("subject") },
        });
        await loadDashboard();
        closeModal();
        state.view = "classes";
        showWorkspace();
        showToast("Your class is ready. Share its class code with students.");
      } else if (type === "join-class") {
        await api("/api/classrooms/join", {
          method: "POST",
          body: { joinCode: formData.get("joinCode") },
        });
        await loadDashboard();
        closeModal();
        state.view = "classes";
        showWorkspace();
        showToast("Request sent. You can join after the teacher approves it.");
      } else if (type === "create-assignment") {
        const classroomId = formData.get("classroomId");
        await api("/api/classrooms/" + encodeURIComponent(classroomId) + "/assignments", {
          method: "POST",
          body: {
            title: formData.get("title"),
            instructions: formData.get("instructions"),
            dueDate: formData.get("dueDate"),
            points: Number(formData.get("points")),
          },
        });
        await loadDashboard();
        closeModal();
        state.view = "assignments";
        state.classFilter = classroomId;
        showWorkspace();
        showToast("Assignment shared with your class.");
      } else if (type === "submission") {
        const assignmentId = form.dataset.assignmentId;
        await api("/api/assignments/" + encodeURIComponent(assignmentId) + "/submissions", {
          method: "POST",
          body: { content: formData.get("content") },
        });
        await loadDashboard();
        closeModal();
        showWorkspace();
        showToast("Assignment turned in. Your teacher can now review it.");
      }
    } catch (error) {
      showToast(error.message, "error");
      submit.disabled = false;
    }
  }

  async function handleGrade(form) {
    const formData = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api("/api/submissions/" + encodeURIComponent(form.dataset.submissionId) + "/grade", {
        method: "PUT",
        body: { grade: Number(formData.get("grade")), feedback: formData.get("feedback") },
      });
      await loadDashboard();
      renderDashboard();
      showToast("Grade returned to the student.");
    } catch (error) {
      showToast(error.message, "error");
      submit.disabled = false;
    }
  }

  async function handleProfileUpdate(form) {
    const formData = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const result = await api("/api/auth/profile", {
        method: "PUT",
        body: {
          name: formData.get("name"),
          email: formData.get("email"),
          currentPassword: formData.get("currentPassword"),
          newPassword: formData.get("newPassword"),
        },
      });
      state.user = result.user;
      await loadDashboard();
      state.view = "settings";
      showWorkspace();
      showToast("Your profile has been updated.");
    } catch (error) {
      showToast(error.message, "error");
      submit.disabled = false;
    }
  }

  async function handleMembershipAction(button) {
    const action = button.dataset.action;
    const classId = button.dataset.classId;
    const className = button.dataset.className || "this class";
    const confirmations = {
      "delete-class": {
        title: "Delete class?",
        message: 'Delete "' + className + '" and permanently remove its assignments and submissions?',
        confirmLabel: "Delete class",
      },
      "leave-class": {
        title: "Leave class?",
        message: 'Leave "' + className + '"? You will no longer see its assignments or grades.',
        confirmLabel: "Leave class",
      },
      "remove-student": {
        title: "Remove student?",
        message: "Remove " + button.dataset.studentName + " from this class?",
        confirmLabel: "Remove student",
      },
    };
    const confirmation = confirmations[action];
    if (confirmation && !await confirmAction(confirmation.title, confirmation.message, confirmation.confirmLabel)) return;

    button.disabled = true;
    try {
      if (action === "approve-join" || action === "decline-join") {
        await api("/api/classrooms/" + encodeURIComponent(classId) + "/join-requests/" +
          encodeURIComponent(button.dataset.requestId), {
          method: "PUT",
          body: { decision: action === "approve-join" ? "approve" : "decline" },
        });
      } else if (action === "remove-student") {
        await api("/api/classrooms/" + encodeURIComponent(classId) + "/students/" +
          encodeURIComponent(button.dataset.studentId), { method: "DELETE" });
      } else {
        await api("/api/classrooms/" + encodeURIComponent(classId), { method: "DELETE" });
      }
      await loadDashboard();
      showWorkspace();
      const messages = {
        "approve-join": "Student approved and added to your class.",
        "decline-join": "Join request declined.",
        "remove-student": "Student removed from your class.",
        "delete-class": "Class and its work have been deleted.",
        "leave-class": "You left the class.",
      };
      showToast(messages[action]);
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  }

  function filterTabs(tabs) {
    return '<div class="filter-tabs">' + tabs.map(function (tab) {
      return '<button type="button" class="filter-tab' + (state.workFilter === tab[0] ? " active" : "") +
        '" data-action="set-filter" data-filter="' + tab[0] + '">' + tab[1] + '</button>';
    }).join("") + '</div>';
  }

  function getClassroom(id) {
    return state.classrooms.find(function (classroom) { return classroom.id === id; });
  }

  function statCard(icon, color, label, value) {
    return '<div class="stat-card"><div class="stat-icon ' + color + '" aria-hidden="true">' + icon +
      '</div><div class="stat-copy"><span>' + escapeHtml(label) + '</span><strong>' + value + '</strong></div></div>';
  }

  function emptyState(title, message) {
    return '<div class="empty-state"><div class="empty-state-icon" aria-hidden="true">✦</div><h3>' + escapeHtml(title) + '</h3><p>' +
      escapeHtml(message) + '</p></div>';
  }

  function sortAssignments(assignments) {
    return assignments.slice().sort(function (a, b) { return new Date(a.dueDate) - new Date(b.dueDate); });
  }

  function formatDate(value) {
    return new Date(value + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function relativeDate(value) {
    const target = new Date(value + "T12:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const difference = Math.round((target - today) / 86400000);
    if (difference < 0) return "Past due";
    if (difference === 0) return "Due today";
    if (difference === 1) return "Due tomorrow";
    return "Due " + target.toLocaleDateString("en-US", { weekday: "short" });
  }

  function dateLabel(value) {
    const date = new Date(value + "T12:00:00");
    return { month: date.toLocaleDateString("en-US", { month: "short" }), day: date.getDate() };
  }

  function classIcon(subject) {
    const text = String(subject).toLowerCase();
    if (/science|biology|chemistry|physics/.test(text)) return "✿";
    if (/english|literature|language|writing/.test(text)) return "✎";
    if (/math|algebra|geometry/.test(text)) return "∑";
    return "▤";
  }

  function safeColor(value) {
    return ["lilac", "mint", "peach", "sky"].includes(value) ? value : "lilac";
  }

  function selected(current, value) {
    return current === value ? " selected" : "";
  }

  function getInitials(name) {
    return String(name).trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join("");
  }

  function firstName(name) {
    return String(name).trim().split(/\s+/)[0] || "there";
  }

  function brandMark() {
    return '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M5 8.5 16 3l11 5.5v15L16 29 5 23.5v-15Z" fill="currentColor"/><path d="M11 12.5c2.8-1.6 6.2-1.6 9 0v8c-2.8-1.6-6.2-1.6-9 0v-8Z" fill="#fff"/><path d="M15.5 12v9" stroke="#fff" stroke-width="1.5"/></svg></span>';
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " toast-error" : " toast-success");
    toast.textContent = message;
    toastRegion.appendChild(toast);
    window.setTimeout(function () { toast.remove(); }, 4000);
  }
})();
