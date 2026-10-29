import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const FIZZ = {
  title: "FizzBuzz",
  functionName: "fizz",
  tests: [
    { name: "three", input: [3], expected: "Fizz" },
    { name: "five", input: [5], expected: "Buzz" },
    { name: "fifteen", input: [15], expected: "FizzBuzz", hidden: true },
  ],
};

const CORRECT = `function fizz(n) {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}`;
const PARTIAL = `function fizz(n) { return n % 3 === 0 ? "Fizz" : "Buzz"; }`;

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp();
});
afterEach(async () => {
  await app.close();
});

async function createAssignment(body: object = FIZZ) {
  const res = await app.inject({ method: "POST", url: "/assignments", payload: body });
  return res;
}

async function submit(id: number, studentId: string, code: string) {
  return app.inject({ method: "POST", url: `/assignments/${id}/submissions`, payload: { studentId, code } });
}

describe("assignments", () => {
  it("creates an assignment and hides hidden test details", async () => {
    const res = await createAssignment();
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe("/assignments/1");
    const body = res.json();
    expect(body.timeLimitMs).toBe(1000); // default applied
    expect(body.tests[2]).toEqual({ name: "fifteen", hidden: true });

    const get = await app.inject({ method: "GET", url: "/assignments/1" });
    expect(get.json().tests[2]).toEqual({ name: "fifteen", hidden: true });
  });

  it.each([
    [{ ...FIZZ, functionName: "fizz(); process.exit()" }, "functionName"],
    [{ ...FIZZ, tests: [] }, "tests"],
    [{ ...FIZZ, extra: true }, "additional"],
    [{ ...FIZZ, timeLimitMs: 60_000 }, "timeLimitMs"],
  ])("rejects invalid input %#", async (body, hint) => {
    const res = await createAssignment(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(new RegExp(hint, "i"));
  });

  it("rejects duplicate test names", async () => {
    const res = await createAssignment({ ...FIZZ, tests: [FIZZ.tests[0], FIZZ.tests[0]] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Duplicate test name 'three'");
  });

  it("returns 404 for unknown assignment", async () => {
    expect((await app.inject({ method: "GET", url: "/assignments/99" })).statusCode).toBe(404);
    expect((await submit(99, "s1", CORRECT)).statusCode).toBe(404);
  });
});

describe("submissions", () => {
  it("grades, stores and lists submissions", async () => {
    await createAssignment();
    const res = await submit(1, "ana", PARTIAL);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 1, studentId: "ana", status: "graded", passed: 2, total: 3, score: 66.7 });

    await submit(1, "ana", CORRECT);
    await submit(1, "giorgi", CORRECT);

    const all = (await app.inject({ method: "GET", url: "/assignments/1/submissions" })).json();
    expect(all).toHaveLength(3);

    const ana = (await app.inject({ method: "GET", url: "/assignments/1/submissions?studentId=ana" })).json();
    expect(ana.map((s: { score: number }) => s.score)).toEqual([100, 66.7]); // newest first
    expect(ana[1].results[2]).toEqual({ name: "fifteen", hidden: true, status: "failed" });
  });

  it("rejects oversized code with 413", async () => {
    await createAssignment();
    const res = await submit(1, "ana", "//" + "x".repeat(20_001));
    expect(res.statusCode).toBe(413);
  });

  it("returns 503 when all grader slots are busy", async () => {
    await app.close();
    app = buildApp({ maxConcurrentGrades: 1 });
    await createAssignment({ ...FIZZ, timeLimitMs: 300 });
    const slow = "function fizz() { const t = Date.now(); while (Date.now() - t < 250) {} return 'Fizz'; }";
    const [a, b] = await Promise.all([submit(1, "a", slow), submit(1, "b", slow)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 503]);
  });
});

describe("stats", () => {
  it("aggregates best scores, pass rate, attempts and hardest tests", async () => {
    await createAssignment();
    await submit(1, "ana", PARTIAL);      // 66.7
    await submit(1, "ana", CORRECT);      // 100 on attempt 2
    await submit(1, "giorgi", CORRECT);   // 100 on attempt 1
    await submit(1, "nino", "syntax(");   // 0, compile error

    const stats = (await app.inject({ method: "GET", url: "/assignments/1/stats" })).json();
    expect(stats).toEqual({
      assignmentId: 1,
      submissions: 4,
      students: 3,
      averageBestScore: 66.7, // (100 + 100 + 0) / 3
      fullPassRate: 0.667,
      averageAttemptsToFullPass: 1.5,
      tests: [
        // compile errors store no per-test rows, so rates cover the 3 graded runs
        { name: "fifteen", hidden: true, failureRate: 0.333 },
        { name: "five", hidden: false, failureRate: 0 },
        { name: "three", hidden: false, failureRate: 0 },
      ],
    });
  });

  it("returns zeros for an assignment with no submissions", async () => {
    await createAssignment();
    const stats = (await app.inject({ method: "GET", url: "/assignments/1/stats" })).json();
    expect(stats).toMatchObject({ submissions: 0, students: 0, averageBestScore: 0, averageAttemptsToFullPass: null });
  });
});
