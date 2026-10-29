import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  function_name  TEXT    NOT NULL,
  tests_json     TEXT    NOT NULL,
  time_limit_ms  INTEGER NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     TEXT    NOT NULL,
  code           TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  passed         INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  score          REAL    NOT NULL,
  error          TEXT,
  duration_ms    INTEGER NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per test per submission: makes "which test fails most?" a plain SQL query.
CREATE TABLE IF NOT EXISTS test_results (
  submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  test_name      TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  hidden         INTEGER NOT NULL,
  detail_json    TEXT,
  PRIMARY KEY (submission_id, test_name)
);

CREATE INDEX IF NOT EXISTS idx_submissions_assignment_student
  ON submissions (assignment_id, student_id);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
