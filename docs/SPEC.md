# Spec: Autograder API v0.1

**Status:** Implemented · **Owner:** Sandro · **Last updated:** 2026-10-28

## 1. Problem

Instructors grade short coding exercises by hand or with ad-hoc scripts. Students wait
for feedback, grading is inconsistent, and nobody can tell which part of an exercise
most students get wrong.

## 2. Goals

1. A student gets per-test feedback on a submission within 2 seconds (p95, exercises up
   to 20 tests).
2. No submission, however broken or malicious, can crash the API or block other students.
3. An instructor can see, per assignment, how students are doing and which tests fail most.

### Non-goals (v0.1)

- Languages other than JavaScript.
- Authentication and roles (assumed to sit in an API gateway in front of this service).
- A UI. The API is designed to be consumed by an LMS or a dashboard.

## 3. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | An instructor creates an assignment with a title, a function name, 1–100 test cases, and a per-test time limit (10–5000 ms, default 1000). |
| FR-2 | `functionName` must be a valid JS identifier. Test names are unique within an assignment. Unknown fields are rejected with `400`. |
| FR-3 | A test case may be `hidden`. Hidden test input and expected output never appear in any API response. |
| FR-4 | A submission is graded synchronously. The response lists every test with status `passed`, `failed`, `error` or `timeout`, and an overall score of 0–100. |
| FR-5 | Visible tests show `expected` and `actual` on failure, and the error message on `error`. |
| FR-6 | Syntax errors and a missing function produce `compile_error` with a message and score 0. |
| FR-7 | Code over 20 KB is rejected with `413`. |
| FR-8 | When all grading slots are busy, the API responds `503` with `Retry-After`. |
| FR-9 | Every submission and its per-test results are stored. History can be filtered by student. |
| FR-10 | Stats per assignment: submissions, students, average of each student's best score, share of students with a full pass, average attempts to first full pass, failure rate per test. |

## 4. Safety requirements

| ID | Requirement |
|---|---|
| SR-1 | Student code cannot access `process`, `require`, `import`, `fetch`, or the file system. |
| SR-2 | `eval` and `new Function` are disabled. |
| SR-3 | A synchronous infinite loop in one test times out that test only; the remaining tests still run. |
| SR-4 | Every submission has a wall-clock limit after which its worker is terminated. |
| SR-5 | Every worker has a heap limit (default 64 MB). |
| SR-6 | A test cannot affect the input of another test. |

## 5. Acceptance examples

```gherkin
Scenario: Hidden test is not leaked
  Given an assignment with a hidden test "fifteen"
  When a student fetches the assignment or submits wrong code
  Then the "fifteen" entry contains only name, hidden and status

Scenario: Infinite loop in one test
  Given a solution that loops forever only for empty input
  When it is graded
  Then test statuses are [passed, timeout, failed] and the API stays responsive

Scenario: Stats
  Given ana scores 66.7 then 100, giorgi scores 100, nino has a syntax error
  Then averageBestScore = 66.7, fullPassRate = 0.667, averageAttemptsToFullPass = 1.5
```

Each scenario is an automated test in `test/`.

## 6. Open questions

- Should the score count only the best attempt or apply a penalty per attempt?
  Needs a product decision; the data model supports both.
- Async student code (Promises) isn't graded in v0.1. Is it needed for the first courses?
