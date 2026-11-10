CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
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
