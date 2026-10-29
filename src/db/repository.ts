import type { DatabaseSync } from "node:sqlite";
import type { Assignment, GradeResult, Submission, TestCase, TestResult } from "../types.js";

type Row = Record<string, unknown>;

export interface AssignmentStats {
  assignmentId: number;
  submissions: number;
  students: number;
  /** Average of each student's best score. */
  averageBestScore: number;
  /** Share of students whose best attempt passed every test (0–1). */
  fullPassRate: number;
  averageAttemptsToFullPass: number | null;
  tests: { name: string; hidden: boolean; failureRate: number }[];
}

function toAssignment(r: Row): Assignment {
  return {
    id: Number(r.id),
    title: String(r.title),
    functionName: String(r.function_name),
    tests: JSON.parse(String(r.tests_json)) as TestCase[],
    timeLimitMs: Number(r.time_limit_ms),
    createdAt: String(r.created_at),
  };
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  createAssignment(a: Omit<Assignment, "id" | "createdAt">): Assignment {
    const row = this.db
      .prepare(
        `INSERT INTO assignments (title, function_name, tests_json, time_limit_ms)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(a.title, a.functionName, JSON.stringify(a.tests), a.timeLimitMs) as Row;
    return toAssignment(row);
  }

  getAssignment(id: number): Assignment | undefined {
    const row = this.db.prepare(`SELECT * FROM assignments WHERE id = ?`).get(id) as Row | undefined;
    return row ? toAssignment(row) : undefined;
  }

  listAssignments(): Assignment[] {
    return (this.db.prepare(`SELECT * FROM assignments ORDER BY id`).all() as Row[]).map(toAssignment);
  }

  /** Stores the submission and its per-test rows in one transaction. */
  saveSubmission(assignmentId: number, studentId: string, code: string, g: GradeResult): Submission {
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          `INSERT INTO submissions
             (assignment_id, student_id, code, status, passed, total, score, error, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
        )
        .get(assignmentId, studentId, code, g.status, g.passed, g.total, g.score, g.error ?? null, g.durationMs) as Row;

      const insertTest = this.db.prepare(
        `INSERT INTO test_results (submission_id, test_name, status, hidden, detail_json) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const t of g.results) {
        const { name, status, hidden, ...detail } = t;
        insertTest.run(Number(row.id), name, status, hidden ? 1 : 0, JSON.stringify(detail));
      }
      this.db.exec("COMMIT");
      return { ...g, id: Number(row.id), assignmentId, studentId, createdAt: String(row.created_at) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listSubmissions(assignmentId: number, studentId?: string): Submission[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM submissions
         WHERE assignment_id = ? AND (? IS NULL OR student_id = ?)
         ORDER BY id DESC`,
      )
      .all(assignmentId, studentId ?? null, studentId ?? null) as Row[];

    const testsStmt = this.db.prepare(
      `SELECT test_name, status, hidden, detail_json FROM test_results WHERE submission_id = ? ORDER BY rowid`,
    );
    return rows.map((r) => {
      const results = (testsStmt.all(Number(r.id)) as Row[]).map(
        (t): TestResult => ({
          name: String(t.test_name),
          status: t.status as TestResult["status"],
          hidden: Boolean(t.hidden),
          ...(JSON.parse(String(t.detail_json ?? "{}")) as object),
        }),
      );
      return {
        id: Number(r.id),
        assignmentId: Number(r.assignment_id),
        studentId: String(r.student_id),
        status: r.status as Submission["status"],
        passed: Number(r.passed),
        total: Number(r.total),
        score: Number(r.score),
        ...(r.error ? { error: String(r.error) } : {}),
        durationMs: Number(r.duration_ms),
        createdAt: String(r.created_at),
        results,
      };
    });
  }

  stats(assignmentId: number): AssignmentStats {
    const summary = this.db
      .prepare(
        `WITH best AS (
           SELECT student_id, MAX(score) AS best_score, MAX(passed = total AND total > 0) AS full_pass
           FROM submissions WHERE assignment_id = ? GROUP BY student_id
         ),
         first_full_pass AS (
           -- attempt number of each student's first fully-passing submission
           SELECT student_id, MIN(attempt) AS attempts FROM (
             SELECT student_id, passed, total,
                    ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY id) AS attempt
             FROM submissions WHERE assignment_id = ?
           ) WHERE passed = total AND total > 0 GROUP BY student_id
         )
         SELECT
           (SELECT COUNT(*) FROM submissions WHERE assignment_id = ?) AS submissions,
           (SELECT COUNT(*) FROM best)                                AS students,
           (SELECT COALESCE(AVG(best_score), 0) FROM best)            AS avg_best,
           (SELECT COALESCE(AVG(full_pass), 0) FROM best)             AS full_pass_rate,
           (SELECT AVG(attempts) FROM first_full_pass)                AS avg_attempts`,
      )
      .get(assignmentId, assignmentId, assignmentId) as Row;

    const tests = this.db
      .prepare(
        `SELECT tr.test_name AS name, MAX(tr.hidden) AS hidden,
                AVG(CASE WHEN tr.status = 'passed' THEN 0.0 ELSE 1.0 END) AS failure_rate
         FROM test_results tr JOIN submissions s ON s.id = tr.submission_id
         WHERE s.assignment_id = ?
         GROUP BY tr.test_name
         ORDER BY failure_rate DESC, name`,
      )
      .all(assignmentId) as Row[];

    const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      assignmentId,
      submissions: Number(summary.submissions),
      students: Number(summary.students),
      averageBestScore: round(Number(summary.avg_best), 1),
      fullPassRate: round(Number(summary.full_pass_rate)),
      averageAttemptsToFullPass: summary.avg_attempts == null ? null : round(Number(summary.avg_attempts), 2),
      tests: tests.map((t) => ({
        name: String(t.name),
        hidden: Boolean(t.hidden),
        failureRate: round(Number(t.failure_rate)),
      })),
    };
  }
}
