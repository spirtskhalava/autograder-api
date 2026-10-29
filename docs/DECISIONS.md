# Design decisions

## D1. Sandbox: `worker_threads` + `vm` now, containers later

**Options considered**

| Option | Isolation | Latency per submission | Ops cost |
|---|---|---|---|
| `vm` in the main thread | Weak; a tight loop blocks the API | ~1 ms | none |
| **Worker thread + `vm` (chosen)** | Separate heap and event loop, killable | ~40 ms | none |
| `isolated-vm` | Separate V8 isolate | ~5 ms | native module, build issues |
| Container / Firecracker per run | Strong (kernel boundary) | 300 ms–1 s | orchestration, image pipeline |

**Decision.** A worker thread per submission, running the code in a `vm` context with
no Node globals, code generation disabled, per-call CPU timeouts, a heap limit, and a
wall-clock kill switch.

**Trade-off I'm living with.** Node's own docs say `vm` is not a security mechanism.
A determined attacker could escape the context (for example through prototype
chains of objects passed in). That's acceptable for v0.1 because submissions come from
enrolled, authenticated students, and the container itself runs as a non-root user,
read-only, with all capabilities dropped and memory/PID limits (`docker-compose.yml`).

**When to revisit.** Before opening submissions to anonymous users, or when supporting
Python. Then grading moves to a queue (e.g. Redis/SQS) with a pool of throwaway
containers, and this API returns `202 Accepted` with a submission id to poll.

## D2. Synchronous grading with a concurrency cap

Grading in the request keeps the API simple (no queue, no polling) and meets the
2-second feedback goal. The cost is that capacity equals the number of slots. Instead of
letting requests pile up and time out, the API returns `503 Retry-After` when full, which
clients and load balancers already understand. The `202` + queue design in D1 is the
upgrade path.

## D3. SQLite via `node:sqlite`

No external database to run for a single-instance service, zero native dependencies,
and real SQL for the stats. Per-test results get their own table so "which test fails
most?" is one `GROUP BY` instead of parsing JSON in application code.

Trade-off: one writer at a time and one instance only. WAL mode handles this load.
Moving to Postgres means changing `database.ts` and the SQL dialect in
`repository.ts`; routes and grader don't touch the database directly.

`node:sqlite` is still flagged experimental in Node 22. Accepted for a portfolio-scale
service; the warning is suppressed at startup, and CI runs on Node 22 and 24 to catch
API changes.

## D4. JSON-schema validation at the edge, and strict about unknown fields

Fastify validates every body against a schema before the handler runs. By default Fastify
**strips** unknown properties silently. I turned that off (`removeAdditional: false`)
after a test caught it: a client sending `timelimitMs` (wrong case) would otherwise get
the default time limit with no error.

## D5. Hidden tests are redacted at the source

The worker itself omits `expected`, `actual` and error text for hidden tests, so the
details never enter the database or the HTTP layer. Redacting only in the response
would mean one forgotten code path leaks the answer key.

## D6. Deep copies across the sandbox boundary

Test inputs are JSON-cloned into the sandbox for each test and results are JSON-cloned
back out. This prevents one test from mutating another's input, makes values from the
other `vm` realm comparable with `isDeepStrictEqual`, and limits test values to JSON
data, which is also what the API accepts.
