export interface TestCase {
  name: string;
  /** Arguments passed to the student's function, in order. */
  input: unknown[];
  expected: unknown;
  /** Hidden tests are graded but their input/expected are never shown to students. */
  hidden?: boolean;
}

export interface Assignment {
  id: number;
  title: string;
  functionName: string;
  tests: TestCase[];
  timeLimitMs: number;
  createdAt: string;
}

export type TestStatus = "passed" | "failed" | "error" | "timeout";

export interface TestResult {
  name: string;
  status: TestStatus;
  hidden: boolean;
  /** Only present for visible tests. */
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export type SubmissionStatus = "graded" | "compile_error" | "timeout" | "crashed";

export interface GradeResult {
  status: SubmissionStatus;
  passed: number;
  total: number;
  /** 0–100, rounded to one decimal. */
  score: number;
  results: TestResult[];
  error?: string;
  durationMs: number;
}

export interface Submission extends GradeResult {
  id: number;
  assignmentId: number;
  studentId: string;
  createdAt: string;
}
