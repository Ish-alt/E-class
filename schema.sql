CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  password_hint TEXT,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS classrooms (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollments (
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (classroom_id, student_id)
);
CREATE TABLE IF NOT EXISTS class_join_requests (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (classroom_id, student_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  due_date TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  content TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  grade DOUBLE PRECISION,
  feedback TEXT NOT NULL DEFAULT '',
  graded_at TEXT,
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS assignments_classroom ON assignments(classroom_id);
CREATE INDEX IF NOT EXISTS submissions_assignment ON submissions(assignment_id);

CREATE TABLE IF NOT EXISTS assignment_submission_settings (
  assignment_id TEXT PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
  submission_mode TEXT NOT NULL DEFAULT 'either' CHECK (submission_mode IN ('text', 'file', 'either')),
  accepted_types TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS classroom_group_settings (
  classroom_id TEXT PRIMARY KEY REFERENCES classrooms(id) ON DELETE CASCADE,
  group_size INTEGER NOT NULL DEFAULT 4 CHECK (group_size BETWEEN 4 AND 12),
  student_groups_enabled INTEGER NOT NULL DEFAULT 0 CHECK (student_groups_enabled IN (0, 1)),
  min_group_size INTEGER NOT NULL DEFAULT 4 CHECK (min_group_size BETWEEN 4 AND 12),
  max_group_size INTEGER NOT NULL DEFAULT 12 CHECK (max_group_size BETWEEN 4 AND 12),
  group_count INTEGER,
  group_mode TEXT NOT NULL DEFAULT 'random' CHECK (group_mode IN ('random', 'student-led'))
);
CREATE TABLE IF NOT EXISTS classroom_group_leaders (
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (classroom_id, student_id),
  FOREIGN KEY (classroom_id, student_id) REFERENCES enrollments(classroom_id, student_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS class_groups (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  leader_id TEXT REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (id, classroom_id)
);
CREATE TABLE IF NOT EXISTS class_group_members (
  group_id TEXT NOT NULL,
  classroom_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, student_id),
  UNIQUE (classroom_id, student_id),
  FOREIGN KEY (group_id, classroom_id) REFERENCES class_groups(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (classroom_id, student_id) REFERENCES enrollments(classroom_id, student_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS class_group_requests (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  leader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (classroom_id, leader_id) REFERENCES enrollments(classroom_id, student_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS class_group_requests_pending_leader
  ON class_group_requests (classroom_id, leader_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS group_member_reservations (
  classroom_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES class_group_requests(id) ON DELETE CASCADE,
  PRIMARY KEY (classroom_id, student_id),
  UNIQUE (request_id, student_id),
  FOREIGN KEY (classroom_id, student_id) REFERENCES enrollments(classroom_id, student_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS class_resources (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'quiz')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 1000),
  content TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_responses (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES class_resources(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  answers TEXT NOT NULL,
  auto_grade DOUBLE PRECISION NOT NULL DEFAULT 0,
  grade DOUBLE PRECISION,
  feedback TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  graded_at TEXT,
  UNIQUE (resource_id, student_id)
);
CREATE TABLE IF NOT EXISTS class_files (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES class_resources(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  created_at TEXT NOT NULL,
  CHECK ((resource_id IS NOT NULL AND submission_id IS NULL) OR
         (resource_id IS NULL AND submission_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS class_groups_classroom ON class_groups(classroom_id);
CREATE INDEX IF NOT EXISTS class_resources_classroom ON class_resources(classroom_id, created_at);
CREATE INDEX IF NOT EXISTS quiz_responses_resource ON quiz_responses(resource_id);
