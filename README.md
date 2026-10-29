# Autograder API

[![CI](https://github.com/spirtskhalava/autograder-api/actions/workflows/ci.yml/badge.svg)](https://github.com/spirtskhalava/autograder-api/actions/workflows/ci.yml)

A REST API for autograded programming exercises. Instructors define an assignment as a
function name plus test cases; students submit JavaScript; the API runs it in a sandboxed
worker thread, returns per-test feedback, and keeps results in SQLite so instructors can
see which tests students struggle with.

**Stack:** TypeScript, Node.js 22, Fastify 5, `node:sqlite`, `worker_threads` + `vm`,
Vitest, Docker, GitHub Actions.

## What it handles

- **Partial credit** with per-test results, deep equality for objects and arrays.
- **Hidden tests.** They're graded, but their input and expected output never reach
  students, either in the assignment view or in submission feedback.
- **Hostile or broken code.** Syntax errors, missing functions, thrown exceptions,
  infinite loops (per test *and* top level), memory blow-ups, `eval`/`new Function`,
  and access to `process`/`require`/`fetch` are all handled and reported. None of them
  crash the API.
- **Back-pressure.** A fixed number of grading slots; when they're full the API answers
  `503` with `Retry-After` instead of queueing without limit.
- **Instructor stats** in SQL: average best score per student, full-pass rate, average
  attempts until a full pass, and failure rate per test.

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # 26 tests, ~4 s
```

With Docker:

```bash
docker compose up --build
```

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/assignments` | Create an assignment |
| `GET` | `/assignments` · `/assignments/:id` | Read assignments (hidden tests redacted) |
| `POST` | `/assignments/:id/submissions` | Submit code, get the graded result |
| `GET` | `/assignments/:id/submissions?studentId=` | Submission history, newest first |
| `GET` | `/assignments/:id/stats` | Aggregates for an instructor dashboard |
| `GET` | `/health` | Liveness |

```bash
curl -X POST localhost:3000/assignments -H 'content-type: application/json' \
  --data @examples/fizzbuzz-assignment.json

curl -X POST localhost:3000/assignments/1/submissions -H 'content-type: application/json' \
  -d '{"studentId":"ana","code":"function fizz(n){ return n % 3 === 0 ? \"Fizz\" : String(n) }"}'
```

```json
{
  "status": "graded", "passed": 2, "total": 5, "score": 40,
  "results": [
    { "name": "returns number as string", "hidden": false, "status": "passed", "expected": "1", "actual": "1" },
    { "name": "multiple of 3", "hidden": false, "status": "passed", "expected": "Fizz", "actual": "Fizz" },
    { "name": "multiple of 5", "hidden": false, "status": "failed", "expected": "Buzz", "actual": "5" },
    { "name": "multiple of 15", "hidden": true, "status": "failed" },
    { "name": "large input", "hidden": true, "status": "failed" }
  ]
}
```

More requests in [`examples/requests.http`](examples/requests.http).

Submission `status` is one of `graded`, `compile_error`, `timeout` or `crashed`.
Test `status` is one of `passed`, `failed`, `error` or `timeout`.

## Project layout

```
src/
  app.ts              Fastify app: routes, JSON-schema validation, concurrency limit
  grader/grader.ts    Spawns a worker per submission, enforces wall-clock + heap limits
  grader/worker.js    Runs student code in a vm context, executes test cases
  db/database.ts      SQLite schema
  db/repository.ts    Queries, including the stats aggregation
test/                 Grader unit tests and API tests (Fastify inject, in-memory DB)
docs/                 Spec and design decisions
```

## Design

- [`docs/SPEC.md`](docs/SPEC.md): requirements and acceptance criteria.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): trade-offs, including the sandbox's limits
  and what I'd change before running it with untrusted users at scale.
