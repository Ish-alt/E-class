(function () {
  "use strict";

  const state = {
    user: null,
    view: "home",
    classrooms: [],
    assignments: [],
    submissions: [],
    joinRequests: [],
    classroomDetail: null,
    classroomTab: "overview",
    classFilter: "all",
    workFilter: "all",
    authMode: "",
  };
  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  const pageContent = document.getElementById("page-content");
  const modalRoot = document.getElementById("modal-root");
  const toastRegion = document.getElementById("toast-region");
  const supportedFileTypes = [
    ["pdf", "PDF"], ["doc", "DOC"], ["docx", "DOCX"], ["ppt", "PPT"], ["pptx", "PPTX"],
    ["xls", "XLS"], ["xlsx", "XLSX"], ["txt", "TXT"], ["csv", "CSV"],
    ["png", "PNG"], ["jpg", "JPG"], ["jpeg", "JPEG"], ["webp", "WEBP"],
  ];
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
      openClassroom(target.dataset.classId);
    } else if (action === "class-tab") {
      state.classroomTab = target.dataset.tab;
      renderDashboard();
    } else if (action === "open-classwork") {
      state.view = "assignments";
      state.classFilter = target.dataset.classId;
      state.workFilter = "all";
      renderDashboard();
    } else if (action === "open-create-material") {
      openCreateMaterialModal(target.dataset.classId);
    } else if (action === "open-create-quiz") {
      openCreateQuizModal(target.dataset.classId);
    } else if (action === "open-group-settings") {
      openGroupSettingsModal();
    } else if (action === "open-manual-groups") {
      openManualGroupsModal();
    } else if (action === "create-random-groups") {
      createRandomGroups(target);
    } else if (action === "open-student-group") {
      openStudentGroupModal();
    } else if (action === "add-quiz-question") {
      addQuizQuestion();
    } else if (action === "open-quiz") {
      openQuizModal(target.dataset.resourceId);
    } else if (action === "review-quiz") {
      reviewQuiz(target.dataset.resourceId);
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
    } else if (event.target.matches(".quiz-question-type")) {
      updateQuizQuestionEditor(event.target.closest(".quiz-question-editor"));
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
    } else if (form.matches("[data-quiz-grade-form]")) {
      event.preventDefault();
      handleQuizGrade(form);
    }
  });

  modalRoot.addEventListener("click", function (event) {
    const target = event.target.closest("[data-confirm-action], [data-close-modal]");
    if (!target) return;
    if (target.matches("[data-confirm-action]")) {
      finishConfirmation(true);
    } else if (target.matches(".modal-backdrop") ? event.target === target : target.matches("[data-close-modal]")) {
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

  async function apiForm(url, formData) {
    const response = await fetch(url, { method: "POST", credentials: "same-origin", body: formData });
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

  async function openClassroom(classroomId, tab) {
    state.view = "classroom";
    state.classFilter = classroomId;
    state.classroomDetail = null;
    state.classroomTab = tab || "overview";
    renderDashboard();
    try {
      state.classroomDetail = await api("/api/classrooms/" + encodeURIComponent(classroomId) + "/details");
      renderDashboard();
    } catch (error) {
      state.view = "classes";
      renderDashboard();
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
    } else if (state.view === "classroom") {
      pageContent.innerHTML = renderClassroomDetail();
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
      state.view === "classroom" && state.classroomDetail ? state.classroomDetail.classroom.name :
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

  function renderClassroomDetail() {
    const detail = state.classroomDetail;
    if (!detail) return '<div class="class-detail-loading">' + emptyState("Loading your class", "Getting the roster and classwork...") + '</div>';
    const classroom = detail.classroom;
    const assignments = detail.assignments;
    const quizzes = detail.resources.filter(function (resource) { return resource.kind === "quiz"; });
    const materials = detail.resources.filter(function (resource) { return resource.kind === "material"; });
    const tabs = [
      ["overview", "Overview"],
      ["students", "Students (" + detail.students.length + ")"],
      ["classwork", "Classwork (" + (assignments.length + quizzes.length) + ")"],
      ["materials", "Materials (" + materials.length + ")"],
      ["groups", "Groups (" + detail.groups.length + ")"],
    ];
    const teacherActions = detail.isTeacher
      ? '<div class="class-detail-actions"><button class="primary-button" type="button" data-action="open-create-assignment" data-class-id="' +
        escapeHtml(classroom.id) + '">＋ Assignment</button><button class="secondary-button" type="button" data-action="open-create-quiz" data-class-id="' +
        escapeHtml(classroom.id) + '">＋ Quiz</button><button class="secondary-button" type="button" data-action="open-create-material" data-class-id="' +
        escapeHtml(classroom.id) + '">＋ Material</button></div>'
      : "";
    return '<div class="class-detail-header"><button class="text-button" type="button" data-action="set-view" data-view="classes">← My classes</button>' +
      '<div class="class-detail-title"><div class="class-banner ' + safeColor(classroom.color) + '"><small>' + escapeHtml(classroom.subject) +
      '</small><strong>' + escapeHtml(classroom.name) + '</strong></div><div class="class-detail-summary"><span>Teacher: ' +
      escapeHtml(classroom.teacherName || state.user.name) + '</span><span>' + detail.students.length + ' students</span>' +
      '<span>' + assignments.length + ' assignments</span><span>' + quizzes.length + ' quizzes</span></div>' +
      (detail.isTeacher ? '<div class="class-join-code"><span>CLASS CODE</span><strong>' + escapeHtml(classroom.joinCode) +
        '</strong><button class="small-action" type="button" data-action="copy-code" data-code="' + escapeHtml(classroom.joinCode) + '">Copy</button></div>' : "") +
      teacherActions + '</div></div><nav class="class-detail-tabs" aria-label="Class sections">' +
      tabs.map(function (tab) {
        return '<button type="button" class="class-detail-tab' + (state.classroomTab === tab[0] ? " active" : "") +
          '" data-action="class-tab" data-tab="' + tab[0] + '">' + tab[1] + '</button>';
      }).join("") + '</nav><section class="class-detail-content">' + renderClassroomTab(detail) + '</section>';
  }

  function renderClassroomTab(detail) {
    if (state.classroomTab === "students") {
      return '<div class="section-heading"><div><h2>Student management</h2><p>Roster for ' + escapeHtml(detail.classroom.name) + '.</p></div></div>' +
        (detail.students.length ? renderStudentRoster({ id: detail.classroom.id, students: detail.students }) :
          emptyState("No students yet", "Share the class code so students can request to join."));
    }
    if (state.classroomTab === "classwork") return renderClassworkTab(detail);
    if (state.classroomTab === "materials") return renderMaterialsTab(detail);
    if (state.classroomTab === "groups") return renderGroupsTab(detail);
    return '<div class="class-overview-grid"><article class="class-overview-card"><span class="eyebrow">ROSTER</span><strong>' +
      detail.students.length + '</strong><span>enrolled students</span><button class="text-button" type="button" data-action="class-tab" data-tab="students">Open student list →</button></article>' +
      '<article class="class-overview-card"><span class="eyebrow">CLASSWORK</span><strong>' + detail.assignments.length +
      '</strong><span>assignments posted</span><button class="text-button" type="button" data-action="class-tab" data-tab="classwork">View assignment history →</button></article>' +
      '<article class="class-overview-card"><span class="eyebrow">LEARNING</span><strong>' +
      detail.resources.filter(function (resource) { return resource.kind === "quiz"; }).length +
      '</strong><span>quizzes · ' + detail.resources.filter(function (resource) { return resource.kind === "material"; }).length +
      ' shared materials</span><button class="text-button" type="button" data-action="class-tab" data-tab="materials">Open class resources →</button></article></div>' +
      '<div class="section-heading"><div><h2>Recent class activity</h2><p>Assignments and quizzes shared with this class.</p></div>' +
      '<button class="text-button" type="button" data-action="class-tab" data-tab="classwork">View all →</button></div>' +
      renderClassworkList(detail, true);
  }

  function renderClassworkTab(detail) {
    return '<div class="section-heading"><div><h2>Assignment history</h2><p>Posted work and submission progress for this class.</p></div>' +
      (detail.isTeacher ? '<button class="primary-button" type="button" data-action="open-create-assignment" data-class-id="' +
        escapeHtml(detail.classroom.id) + '">＋ Create assignment</button>' : "") + '</div>' +
      renderClassworkList(detail, false);
  }

  function renderClassworkList(detail, compact) {
    const rows = detail.assignments.map(function (assignment) {
      const stateAssignment = state.assignments.find(function (item) { return item.id === assignment.id; });
      let action = "";
      if (detail.isTeacher) {
        action = '<button class="small-action" type="button" data-action="open-classwork" data-class-id="' +
          escapeHtml(detail.classroom.id) + '">Review submissions →</button>';
      } else if (stateAssignment) {
        const submitted = stateAssignment.submission;
        action = '<button class="small-action" type="button" data-action="' + (submitted ? "open-feedback" : "open-submit") +
          '" data-assignment-id="' + escapeHtml(assignment.id) + '">' + (submitted ? "View submission" : "Turn in") + ' →</button>';
      }
      return '<article class="resource-row"><div class="resource-row-icon">▤</div><div class="resource-row-main"><strong>' +
        escapeHtml(assignment.title) + '</strong><span>' + escapeHtml(assignment.instructions) + '</span><small>Due ' +
        formatDate(assignment.dueDate) + ' · ' + assignment.points + ' points · ' +
        (detail.isTeacher ? assignment.submissionCount + ' submissions' : assignment.submissionMode === "file" ? "File submission" : "Text or file") +
        '</small></div>' + action + '</article>';
    });
    detail.resources.filter(function (resource) { return resource.kind === "quiz"; }).forEach(function (quiz) {
      const button = detail.isTeacher
        ? '<button class="small-action" type="button" data-action="review-quiz" data-resource-id="' + escapeHtml(quiz.id) + '">Review answers →</button>'
        : '<button class="small-action" type="button" data-action="open-quiz" data-resource-id="' + escapeHtml(quiz.id) + '">' +
          (quiz.response ? quiz.response.grade === null ? "Submitted" : "See score" : "Take quiz") + ' →</button>';
      rows.push('<article class="resource-row"><div class="resource-row-icon quiz-icon">✓</div><div class="resource-row-main"><strong>' +
        escapeHtml(quiz.title) + '</strong><span>' + escapeHtml(quiz.description || "Quiz") + '</span><small>Due ' +
        formatDate(quiz.dueDate) + ' · ' + quiz.points + ' points · ' +
        (detail.isTeacher ? quiz.responseCount + ' responses' : quiz.response && quiz.response.grade !== null ? quiz.response.grade + "/" + quiz.points + " points" : "Not graded") +
        '</small></div>' + button + '</article>');
    });
    return rows.length ? '<div class="resource-list' + (compact ? " compact" : "") + '">' + rows.join("") + '</div>' :
      emptyState("No classwork yet", "Assignments and quizzes posted by the teacher will appear here.");
  }

  function renderMaterialsTab(detail) {
    const materials = detail.resources.filter(function (resource) { return resource.kind === "material"; });
    return '<div class="section-heading"><div><h2>Shared learning materials</h2><p>Files and reading shared for this class.</p></div>' +
      (detail.isTeacher ? '<button class="primary-button" type="button" data-action="open-create-material" data-class-id="' +
        escapeHtml(detail.classroom.id) + '">＋ Share material</button>' : "") + '</div>' +
      (materials.length ? '<div class="resource-list">' + materials.map(function (material) {
        return '<article class="resource-row"><div class="resource-row-icon material-icon">↧</div><div class="resource-row-main"><strong>' +
          escapeHtml(material.title) + '</strong><span>' + escapeHtml(material.description || material.file.name) +
          '</span><small>' + escapeHtml(material.file.name) + ' · ' + formatFileSize(material.file.sizeBytes) + '</small></div>' +
          '<a class="small-action" href="/api/files/' + encodeURIComponent(material.file.id) + '">Download →</a></article>';
      }).join("") + '</div>' : emptyState("No materials shared yet", "PDFs, documents, presentations, and other class files will appear here."));
  }

  function renderGroupsTab(detail) {
    const settings = detail.groupSettings;
    const membership = detail.groups.find(function (group) {
      return group.members.some(function (member) { return member.id === state.user.id; });
    });
    const controls = detail.isTeacher
      ? '<div class="group-controls"><div><strong>Group setup</strong><span>Groups of up to ' + settings.groupSize +
        ' students · student-led groups ' + (settings.studentGroupsEnabled ? "enabled" : "disabled") + '</span></div><div class="group-control-actions">' +
        '<button class="secondary-button" type="button" data-action="open-group-settings">Group settings</button>' +
        '<button class="secondary-button" type="button" data-action="open-manual-groups">Assign manually</button>' +
        '<button class="primary-button" type="button" data-action="create-random-groups">Random grouping</button></div></div>'
      : settings.studentGroupsEnabled && settings.isGroupLeader && !membership
        ? '<div class="group-controls"><div><strong>You are a group leader</strong><span>Create a group of up to ' + settings.groupSize + ' enrolled students.</span></div>' +
          '<button class="primary-button" type="button" data-action="open-student-group">Create my group</button></div>'
        : !detail.groups.length ? '<div class="group-controls"><div><strong>Group work</strong><span>Your teacher has not created groups yet.</span></div></div>' : "";
    return controls + (detail.groups.length
      ? '<div class="group-card-grid">' + detail.groups.map(function (group) {
        return '<article class="class-group-card"><div class="group-card-heading"><div><span class="eyebrow">CLASS GROUP</span><h3>' +
          escapeHtml(group.name) + '</h3></div><span class="group-member-count">' + group.members.length + ' members</span></div>' +
          (group.leaderName ? '<p class="group-leader">Leader: ' + escapeHtml(group.leaderName) + '</p>' : "") +
          '<ul>' + group.members.map(function (member) {
            return '<li><span class="avatar avatar-blue">' + escapeHtml(getInitials(member.name)) + '</span><span>' +
              escapeHtml(member.name) + (member.id === group.leaderId ? ' <small>Leader</small>' : "") + '</span></li>';
          }).join("") + '</ul></article>';
      }).join("") + '</div>'
      : emptyState("No groups yet", "Create balanced groups at random or assign students to groups yourself."));
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
      '<div class="class-card-bottom"><span>' + pendingCount + ' to review</span><button class="small-action" type="button" data-action="open-class" data-class-id="' +
      escapeHtml(classroom.id) + '">Manage class →</button><button class="small-action" type="button" data-action="open-create-assignment" data-class-id="' +
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
            '</span><span class="roster-student-copy"><strong>' + escapeHtml(student.name) + '</strong>' +
            (state.user.role === "teacher" ? '<small>' + escapeHtml(student.email) + '</small>' : "") +
            '</span>' + (student.joinedAt ? '<span class="roster-joined">Joined ' + formatDate(student.joinedAt.slice(0, 10)) + '</span>' : "") +
            (state.user.role === "teacher" ? '<button class="small-action roster-remove" type="button" data-action="remove-student" data-class-id="' +
              escapeHtml(classroom.id) + '" data-student-id="' + escapeHtml(student.id) + '" data-student-name="' +
              escapeHtml(student.name) + '">Remove</button>' : "") + '</li>';
        }).join("") + '</ul>'
        : '<p class="roster-empty">No students have joined yet. Share the class code above.</p>') + '</section>';
  }

  function renderStudentClassCard(classroom) {
    const count = state.assignments.filter(function (item) { return item.classroomId === classroom.id; }).length;
    return '<article class="class-card"><div class="class-banner ' + safeColor(classroom.color) + '"><small>' + escapeHtml(classroom.subject) +
      '</small><strong>' + escapeHtml(classroom.name) + '</strong></div><div class="class-card-body"><div class="class-teacher">with ' +
      escapeHtml(classroom.teacherName || "your teacher") + '</div><div class="class-card-bottom"><span>' + count + (count === 1 ? " assignment" : " assignments") +
      '</span><button class="small-action" type="button" data-action="open-class" data-class-id="' + escapeHtml(classroom.id) + '">Open class →</button>' +
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
      '</span></div>' + (submission.content ? '<div class="student-work">' + escapeHtml(submission.content) + '</div>' : "") +
      (submission.fileId ? '<a class="small-action submission-file-link" href="/api/files/' + encodeURIComponent(submission.fileId) + '">Download ' +
        escapeHtml(submission.fileName || "submitted file") + ' →</a>' : "") +
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
      '<div class="form-field"><label for="submission-mode">How students can submit</label><select id="submission-mode" name="submissionMode"><option value="either">Written work or file</option><option value="file">File only</option><option value="text">Written work only</option></select></div>' +
      '<fieldset class="file-type-options"><legend>Accepted file types</legend><div class="file-type-grid">' +
      supportedFileTypes.map(function (type) {
        return '<label><input type="checkbox" name="acceptedTypes" value="' + type[0] + '" checked /><span>' + type[1] + '</span></label>';
      }).join("") + '</div><span class="field-hint">Individual files may be up to 20 MB.</span></fieldset>' +
      modalFooter("Create assignment") + '</form>');
  }

  function openCreateMaterialModal(classId) {
    if (!classId) return;
    openModal("Share class material", "Add a private file that only class members can download.",
      '<form class="modal-form" data-modal-form="create-material" data-class-id="' + escapeHtml(classId) + '">' +
      '<div class="form-field"><label for="material-title">Title</label><input id="material-title" name="title" required minlength="2" maxlength="100" placeholder="e.g. Week 2 reading" /></div>' +
      '<div class="form-field"><label for="material-description">Description</label><textarea id="material-description" name="description" maxlength="2000" placeholder="Add a note for students (optional)..."></textarea></div>' +
      '<div class="form-field"><label for="material-file">File</label><input id="material-file" name="file" type="file" accept="' +
      supportedFileTypes.map(function (type) { return "." + type[0]; }).join(",") + '" required /><span class="field-hint">PDF, Office, text, spreadsheet, or image · 20 MB maximum.</span></div>' +
      modalFooter("Share material") + '</form>');
  }

  function openCreateQuizModal(classId) {
    if (!classId) return;
    openModal("Create a quiz", "Objective questions are auto-graded; you review short answers.",
      '<form class="modal-form quiz-create-form" data-modal-form="create-quiz" data-class-id="' + escapeHtml(classId) + '">' +
      '<div class="form-field"><label for="quiz-title">Quiz title</label><input id="quiz-title" name="title" required minlength="2" maxlength="100" placeholder="e.g. Cell biology review" /></div>' +
      '<div class="form-field"><label for="quiz-description">Instructions</label><textarea id="quiz-description" name="description" maxlength="2000" placeholder="Instructions for students (optional)..."></textarea></div>' +
      '<div class="form-field"><label for="quiz-due-date">Due date</label><input id="quiz-due-date" name="dueDate" type="date" min="' +
      new Date().toISOString().slice(0, 10) + '" required /></div><div id="quiz-question-list">' + quizQuestionEditor(1) + '</div>' +
      '<button class="secondary-button" type="button" data-action="add-quiz-question">＋ Add question</button>' +
      '<p class="field-hint">Each question is worth 1–100 points; the quiz total can be up to 1000 points.</p>' +
      modalFooter("Publish quiz") + '</form>');
  }

  function quizQuestionEditor(index) {
    return '<fieldset class="quiz-question-editor"><legend>Question ' + index + '</legend>' +
      '<div class="form-field"><label>Question</label><textarea name="prompt" required maxlength="1000" placeholder="Write the question..."></textarea></div>' +
      '<div class="form-row"><div class="form-field"><label>Type</label><select name="type" class="quiz-question-type">' +
      '<option value="multiple_choice">Multiple choice</option><option value="true_false">True / false</option><option value="short_answer">Short answer</option></select></div>' +
      '<div class="form-field"><label>Points</label><input name="points" type="number" min="1" max="100" value="1" required /></div></div>' +
      '<div class="form-field question-options"><label>Options (one per line)</label><textarea name="options" required placeholder="First choice&#10;Second choice"></textarea></div>' +
      '<div class="form-field question-multiple-answer"><label>Correct option (exact text)</label><input name="answer" required placeholder="Type one of the options above" /></div>' +
      '<div class="form-field question-boolean-answer" hidden><label>Correct answer</label><select name="booleanAnswer"><option value="true">True</option><option value="false">False</option></select></div>' +
      '<p class="field-hint question-short-hint" hidden>The teacher will grade this answer after students submit.</p></fieldset>';
  }

  function addQuizQuestion() {
    const list = modalRoot.querySelector("#quiz-question-list");
    if (!list) return;
    const count = list.querySelectorAll(".quiz-question-editor").length;
    if (count >= 50) {
      showToast("A quiz can have at most 50 questions.", "error");
      return;
    }
    list.insertAdjacentHTML("beforeend", quizQuestionEditor(count + 1));
  }

  function updateQuizQuestionEditor(editor) {
    if (!editor) return;
    const type = editor.querySelector(".quiz-question-type").value;
    const options = editor.querySelector(".question-options");
    const multipleAnswer = editor.querySelector(".question-multiple-answer");
    const booleanAnswer = editor.querySelector(".question-boolean-answer");
    const shortHint = editor.querySelector(".question-short-hint");
    options.hidden = type !== "multiple_choice";
    multipleAnswer.hidden = type !== "multiple_choice";
    booleanAnswer.hidden = type !== "true_false";
    shortHint.hidden = type !== "short_answer";
    options.querySelector("textarea").required = type === "multiple_choice";
    multipleAnswer.querySelector("input").required = type === "multiple_choice";
  }

  function openGroupSettingsModal() {
    const detail = state.classroomDetail;
    if (!detail || !detail.isTeacher) return;
    const leaders = new Set(detail.groupSettings.leaderIds);
    openModal("Group settings", "Set the target group size and, optionally, let assigned student leaders form groups.",
      '<form class="modal-form" data-modal-form="group-settings" data-class-id="' + escapeHtml(detail.classroom.id) + '">' +
      '<div class="form-field"><label for="group-size">Maximum students per group</label><input id="group-size" name="groupSize" type="number" min="2" max="20" value="' +
      detail.groupSettings.groupSize + '" required /></div><label class="inline-check"><input name="studentGroupsEnabled" type="checkbox" value="true" ' +
      (detail.groupSettings.studentGroupsEnabled ? "checked" : "") + ' />Allow teacher-assigned student leaders to create groups</label>' +
      '<fieldset class="leader-options"><legend>Assign group leaders</legend>' +
      (detail.students.length ? detail.students.map(function (student) {
        return '<label><input type="checkbox" name="leaderIds" value="' + escapeHtml(student.id) + '"' +
          (leaders.has(student.id) ? " checked" : "") + ' /><span>' + escapeHtml(student.name) + '</span></label>';
      }).join("") : '<p class="field-hint">Students must join the class before you can assign group leaders.</p>') + '</fieldset>' +
      modalFooter("Save group settings") + '</form>');
  }

  function openManualGroupsModal() {
    const detail = state.classroomDetail;
    if (!detail || detail.students.length < 2) {
      showToast("At least two students are needed to create groups.", "error");
      return;
    }
    const maxGroups = Math.floor(detail.students.length / 2);
    const defaultGroups = Math.min(4, maxGroups);
    const groupOptions = Array.from({ length: maxGroups }, function (_unused, index) {
      return '<option value="' + (index + 1) + '"' + selected(defaultGroups, index + 1) + '>' + (index + 1) + ' groups</option>';
    }).join("");
    const studentRows = detail.students.map(function (student) {
      const options = Array.from({ length: maxGroups }, function (_unused, index) {
        return '<option value="' + (index + 1) + '">Group ' + (index + 1) + '</option>';
      }).join("");
      return '<label class="manual-group-student"><span>' + escapeHtml(student.name) + '</span><select name="group-' +
        escapeHtml(student.id) + '">' + options + '</select></label>';
    }).join("");
    openModal("Assign groups manually", "Choose a group for each student. Every group must contain at least two students.",
      '<form class="modal-form" data-modal-form="manual-groups" data-class-id="' + escapeHtml(detail.classroom.id) + '">' +
      '<div class="form-field"><label for="manual-group-count">Number of groups</label><select id="manual-group-count" name="groupCount">' + groupOptions +
      '</select></div><div class="manual-group-list">' + studentRows + '</div>' + modalFooter("Save groups") + '</form>');
  }

  function openStudentGroupModal() {
    const detail = state.classroomDetail;
    if (!detail || !detail.groupSettings.isGroupLeader) return;
    const assigned = new Set(detail.groups.flatMap(function (group) {
      return group.members.map(function (member) { return member.id; });
    }));
    const available = detail.students.filter(function (student) {
      return student.id !== state.user.id && !assigned.has(student.id);
    });
    openModal("Create your group", "Choose classmates for a group of up to " + detail.groupSettings.groupSize + " students.",
      '<form class="modal-form" data-modal-form="student-group" data-class-id="' + escapeHtml(detail.classroom.id) + '">' +
      '<div class="form-field"><label for="student-group-name">Group name</label><input id="student-group-name" name="name" required minlength="2" maxlength="60" placeholder="e.g. Team 1" /></div>' +
      '<fieldset class="leader-options"><legend>Choose classmates</legend>' +
      (available.length ? available.map(function (student) {
        return '<label><input type="checkbox" name="memberIds" value="' + escapeHtml(student.id) + '" /><span>' +
          escapeHtml(student.name) + '</span></label>';
      }).join("") : '<p class="field-hint">No unassigned classmates are available right now.</p>') + '</fieldset>' +
      '<p class="field-hint">You will be included as the group leader. Each student can join only one group.</p>' +
      modalFooter("Create group") + '</form>');
  }

  async function createRandomGroups(button) {
    const detail = state.classroomDetail;
    if (!detail || !detail.isTeacher) return;
    if (!await confirmAction("Create random groups?", "This replaces the current groups with a balanced random assignment.", "Random grouping")) return;
    button.disabled = true;
    try {
      await api("/api/classrooms/" + encodeURIComponent(detail.classroom.id) + "/groups/random", {
        method: "POST",
        body: { groupSize: detail.groupSettings.groupSize },
      });
      await refreshClassroomDetail();
      showToast("Students have been distributed into balanced groups.");
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  }

  async function refreshClassroomDetail() {
    if (!state.classroomDetail) return;
    state.classroomDetail = await api("/api/classrooms/" +
      encodeURIComponent(state.classroomDetail.classroom.id) + "/details");
    renderDashboard();
  }

  function openSubmissionModal(assignmentId) {
    const assignment = state.assignments.find(function (item) { return item.id === assignmentId; });
    if (!assignment) return;
    const classroom = getClassroom(assignment.classroomId) || { name: "Class" };
    const existing = assignment.submission;
    const disabled = existing && existing.grade !== null;
    const submissionMode = assignment.submissionMode || "either";
    const acceptedTypes = assignment.acceptedTypes && assignment.acceptedTypes.length
      ? assignment.acceptedTypes : supportedFileTypes.map(function (type) { return type[0]; });
    openModal(disabled ? "Your submission" : existing ? "Update your work" : "Turn in your work",
      escapeHtml(assignment.title) + " · " + escapeHtml(classroom.name),
      '<form class="modal-form" data-modal-form="submission" data-assignment-id="' + escapeHtml(assignment.id) + '">' +
      '<div class="instructions-box"><div class="instructions-heading">ASSIGNMENT INSTRUCTIONS</div><p>' + escapeHtml(assignment.instructions) +
      '</p><span>Due ' + formatDate(assignment.dueDate) + ' · ' + assignment.points + ' points</span></div>' +
      (submissionMode !== "file" ? '<div class="form-field"><label for="submission-content">Your written work</label><textarea id="submission-content" name="content" ' +
      (submissionMode === "text" ? "required minlength=\"2\"" : "") + ' maxlength="5000" ' +
      (disabled ? "disabled" : "") + ' placeholder="Write your answer or paste your work here...">' + escapeHtml(existing ? existing.content : "") +
      '</textarea></div>' : "") +
      (submissionMode !== "text" ? '<div class="form-field"><label for="submission-file">Attach your file</label><input id="submission-file" name="file" type="file" accept="' +
        acceptedTypes.map(function (type) { return "." + type; }).join(",") + '"' +
        (submissionMode === "file" && !(existing && existing.file) ? " required" : "") + (disabled ? " disabled" : "") + ' />' +
        (existing && existing.file ? '<span class="field-hint">Current file: <a href="/api/files/' + encodeURIComponent(existing.file.id) + '">' +
          escapeHtml(existing.file.name) + '</a>. Choose a new file to replace it.</span>' : '<span class="field-hint">Accepted: ' +
          acceptedTypes.map(function (type) { return type.toUpperCase(); }).join(", ") + ' · 20 MB maximum.</span>') + '</div>' : "") +
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
      '</div>' + (submission.file ? '<a class="small-action" href="/api/files/' + encodeURIComponent(submission.file.id) + '">Download ' +
        escapeHtml(submission.file.name) + ' →</a>' : "") +
      (submission.grade === null ? '<div class="field-hint">Your teacher has received your work. Check back here for your grade.</div>' :
        '<div class="graded-feedback"><span class="grade-score">' + submission.grade + '/' + assignment.points + ' pts</span><span>' +
        escapeHtml(submission.feedback || "Your work has been graded.") + '</span></div>') +
      '</div><footer class="modal-footer"><button class="primary-button" type="button" data-close-modal>Done</button></footer></div>');
  }

  function openQuizModal(resourceId) {
    const quiz = state.classroomDetail && state.classroomDetail.resources.find(function (item) { return item.id === resourceId; });
    if (!quiz || quiz.kind !== "quiz") return;
    if (quiz.response) {
      const score = quiz.response.grade === null
        ? '<p class="field-hint">Your answers are submitted. Your teacher will grade the short-answer questions.</p>'
        : '<div class="graded-feedback"><span class="grade-score">' + quiz.response.grade + '/' + quiz.points + ' points</span><span>' +
          escapeHtml(quiz.response.feedback || "Quiz graded.") + '</span></div>';
      openModal(quiz.title, "Quiz results", '<div class="modal-form">' + score +
        '<footer class="modal-footer"><button class="primary-button" type="button" data-close-modal>Done</button></footer></div>');
      return;
    }
    const questions = quiz.questions.map(function (question, index) {
      let answers;
      if (question.type === "multiple_choice") {
        answers = question.options.map(function (option) {
          return '<label class="quiz-answer-option"><input type="radio" name="answer_' + escapeHtml(question.id) +
            '" value="' + escapeHtml(option.id) + '" required /><span>' + escapeHtml(option.text) + '</span></label>';
        }).join("");
      } else if (question.type === "true_false") {
        answers = ["true", "false"].map(function (answer) {
          return '<label class="quiz-answer-option"><input type="radio" name="answer_' + escapeHtml(question.id) +
            '" value="' + answer + '" required /><span>' + (answer === "true" ? "True" : "False") + '</span></label>';
        }).join("");
      } else {
        answers = '<textarea name="answer_' + escapeHtml(question.id) + '" required maxlength="2000" placeholder="Write your answer..."></textarea>';
      }
      return '<fieldset class="quiz-answer-card"><legend>' + (index + 1) + '. ' + escapeHtml(question.prompt) +
        ' <small>' + question.points + ' pts</small></legend><div class="quiz-answer-options">' + answers + '</div></fieldset>';
    }).join("");
    openModal(quiz.title, escapeHtml(quiz.description || ("Due " + formatDate(quiz.dueDate) + " · " + quiz.points + " points")),
      '<form class="modal-form" data-modal-form="quiz-response" data-resource-id="' + escapeHtml(quiz.id) + '">' +
      questions + modalFooter("Submit quiz") + '</form>');
  }

  async function reviewQuiz(resourceId) {
    try {
      const result = await api("/api/resources/" + encodeURIComponent(resourceId) + "/quiz-responses");
      const shortQuestions = result.questions.filter(function (question) { return question.type === "short_answer"; });
      const responseRows = result.responses.map(function (quizResponse) {
        const alreadyGraded = quizResponse.grade !== null;
        const answers = shortQuestions.map(function (question) {
          return '<div class="quiz-review-answer"><strong>' + escapeHtml(question.prompt) + ' (' + question.points + ' pts)</strong><p>' +
            escapeHtml(quizResponse.answers[question.id]) + '</p>' + (!alreadyGraded
              ? '<label>Score<input type="number" name="grade-' + escapeHtml(question.id) + '" min="0" max="' +
                question.points + '" step="0.5" required /></label>' : "") + '</div>';
        }).join("");
        return '<article class="quiz-review-card"><div class="quiz-review-heading"><strong>' + escapeHtml(quizResponse.studentName) +
          '</strong><span>' + (alreadyGraded ? quizResponse.grade + '/' + result.points + ' points' : 'Auto score ' +
            quizResponse.autoGrade + ' · Awaiting review') + '</span></div>' +
          (alreadyGraded ? (answers || '<p class="field-hint">All questions were automatically graded.</p>') +
            '<p class="field-hint">' + escapeHtml(quizResponse.feedback || "") + '</p>' :
            shortQuestions.length ? '<form data-quiz-grade-form data-response-id="' + escapeHtml(quizResponse.id) +
              '" data-resource-id="' + escapeHtml(resourceId) + '">' +
              answers + '<div class="form-field"><label>Feedback</label><input name="feedback" maxlength="1000" /></div>' +
              '<button class="primary-button" type="submit">Return quiz grade</button></form>' :
              '<p class="field-hint">Auto-graded: ' + quizResponse.autoGrade + '/' + result.points + ' points.</p>') + '</article>';
      }).join("");
      openModal("Review quiz responses", "Auto-graded answers are included. Score each short answer to return a final grade.",
        '<div class="quiz-review-list">' + (responseRows || '<p class="field-hint">No students have submitted this quiz yet.</p>') + '</div>');
    } catch (error) {
      showToast(error.message, "error");
    }
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
            submissionMode: formData.get("submissionMode"),
            acceptedTypes: formData.getAll("acceptedTypes"),
          },
        });
        await loadDashboard();
        closeModal();
        await openClassroom(classroomId, "classwork");
        showToast("Assignment shared with your class.");
      } else if (type === "create-material") {
        const materialForm = new FormData();
        materialForm.set("title", formData.get("title"));
        materialForm.set("description", formData.get("description"));
        materialForm.set("file", formData.get("file"));
        await apiForm("/api/classrooms/" + encodeURIComponent(form.dataset.classId) + "/materials", materialForm);
        closeModal();
        state.classroomTab = "materials";
        await refreshClassroomDetail();
        showToast("Material shared with the class.");
      } else if (type === "create-quiz") {
        const questions = [...form.querySelectorAll(".quiz-question-editor")].map(function (editor) {
          const questionType = editor.querySelector('[name="type"]').value;
          const question = {
            type: questionType,
            prompt: editor.querySelector('[name="prompt"]').value,
            points: Number(editor.querySelector('[name="points"]').value),
          };
          if (questionType === "multiple_choice") {
            question.options = editor.querySelector('[name="options"]').value.split(/\r?\n/).map(function (option) { return option.trim(); });
            question.answer = editor.querySelector('[name="answer"]').value.trim();
          } else if (questionType === "true_false") {
            question.answer = editor.querySelector('[name="booleanAnswer"]').value;
          }
          return question;
        });
        await api("/api/classrooms/" + encodeURIComponent(form.dataset.classId) + "/quizzes", {
          method: "POST",
          body: {
            title: formData.get("title"),
            description: formData.get("description"),
            dueDate: formData.get("dueDate"),
            questions,
          },
        });
        closeModal();
        state.classroomTab = "classwork";
        await refreshClassroomDetail();
        showToast("Quiz published. Objective questions will be auto-graded.");
      } else if (type === "group-settings") {
        await api("/api/classrooms/" + encodeURIComponent(form.dataset.classId) + "/groups/settings", {
          method: "PUT",
          body: {
            groupSize: Number(formData.get("groupSize")),
            studentGroupsEnabled: formData.has("studentGroupsEnabled"),
            leaderIds: formData.getAll("leaderIds"),
          },
        });
        closeModal();
        await refreshClassroomDetail();
        showToast("Group settings saved.");
      } else if (type === "manual-groups") {
        const groupCount = Number(formData.get("groupCount"));
        const groups = Array.from({ length: groupCount }, function (_unused, index) {
          return { name: "Group " + (index + 1), studentIds: [] };
        });
        state.classroomDetail.students.forEach(function (student) {
          const groupNumber = Number(formData.get("group-" + student.id));
          if (groupNumber >= 1 && groupNumber <= groupCount) groups[groupNumber - 1].studentIds.push(student.id);
        });
        await api("/api/classrooms/" + encodeURIComponent(form.dataset.classId) + "/groups/manual", {
          method: "POST",
          body: { groups },
        });
        closeModal();
        await refreshClassroomDetail();
        showToast("Student groups have been assigned.");
      } else if (type === "student-group") {
        await api("/api/classrooms/" + encodeURIComponent(form.dataset.classId) + "/groups", {
          method: "POST",
          body: { name: formData.get("name"), memberIds: formData.getAll("memberIds") },
        });
        closeModal();
        await refreshClassroomDetail();
        showToast("Your group has been created.");
      } else if (type === "quiz-response") {
        const answers = {};
        form.querySelectorAll('[name^="answer_"]').forEach(function (input) {
          if ((input.type === "radio" && input.checked) || input.type !== "radio") {
            answers[input.name.slice("answer_".length)] = input.value;
          }
        });
        await api("/api/resources/" + encodeURIComponent(form.dataset.resourceId) + "/quiz-responses", {
          method: "POST",
          body: { answers },
        });
        closeModal();
        await refreshClassroomDetail();
        showToast("Quiz submitted. Multiple-choice and true/false questions are auto-graded.");
      } else if (type === "submission") {
        const assignmentId = form.dataset.assignmentId;
        const submissionForm = new FormData();
        submissionForm.set("content", formData.get("content") || "");
        const file = formData.get("file");
        if (file && file.size) submissionForm.set("file", file);
        await apiForm("/api/assignments/" + encodeURIComponent(assignmentId) + "/submissions", submissionForm);
        await loadDashboard();
        closeModal();
        if (state.classroomDetail) await refreshClassroomDetail();
        else showWorkspace();
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

  async function handleQuizGrade(form) {
    const formData = new FormData(form);
    const grades = {};
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("grade-")) grades[key.slice("grade-".length)] = Number(value);
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api("/api/quiz-responses/" + encodeURIComponent(form.dataset.responseId) + "/grade", {
        method: "PUT",
        body: { grades, feedback: formData.get("feedback") },
      });
      closeModal();
      await loadDashboard();
      await refreshClassroomDetail();
      showToast("Quiz grade returned to the student.");
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

  function formatFileSize(value) {
    const bytes = Number(value) || 0;
    return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" :
      (bytes / (1024 * 1024)).toFixed(1) + " MB";
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
