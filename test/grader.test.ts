import { describe, expect, it } from "vitest";
import { grade } from "../src/grader/grader.js";
import type { TestCase } from "../src/types.js";

const sumTests: TestCase[] = [
  { name: "small", input: [[1, 2, 3]], expected: 6 },
  { name: "empty", input: [[]], expected: 0 },
  { name: "negatives", input: [[-1, -2]], expected: -3, hidden: true },
];

const job = (code: string, tests = sumTests, timeLimitMs = 200) =>
  grade({ code, functionName: "sum", tests, timeLimitMs });

describe("grader", () => {
  it("scores a correct solution 100", async () => {
    const r = await job("function sum(xs) { return xs.reduce((a, b) => a + b, 0); }");
    expect(r).toMatchObject({ status: "graded", passed: 3, total: 3, score: 100 });
  });

  it("supports arrow functions declared with const", async () => {
    const r = await job("const sum = (xs) => xs.reduce((a, b) => a + b, 0);");
    expect(r.score).toBe(100);
  });

  it("reports partial credit and shows expected/actual only for visible tests", async () => {
    const r = await job("function sum(xs) { return xs.length ? xs[0] + xs[1] + xs[2] : 0; }");
    expect(r.score).toBe(66.7);
    expect(r.results).toEqual([
      { name: "small", hidden: false, status: "passed", expected: 6, actual: 6 },
      { name: "empty", hidden: false, status: "passed", expected: 0, actual: 0 },
      { name: "negatives", hidden: true, status: "failed" }, // no input/expected leaked
    ]);
  });

  it("compares objects and arrays deeply", async () => {
    const tests: TestCase[] = [{ name: "obj", input: [2], expected: { n: 2, list: [0, 1] } }];
    const r = await grade({
      code: "function make(n) { return { n, list: Array.from({ length: n }, (_, i) => i) }; }",
      functionName: "make",
      tests,
      timeLimitMs: 200,
    });
    expect(r.score).toBe(100);
  });

  it("returns compile_error for syntax errors", async () => {
    const r = await job("function sum(xs) { return ");
    expect(r.status).toBe("compile_error");
    expect(r.error).toMatch(/SyntaxError/);
    expect(r.score).toBe(0);
  });

  it("returns compile_error when the function is missing", async () => {
    const r = await job("function total(xs) { return 0; }");
    expect(r).toMatchObject({ status: "compile_error", error: "Function 'sum' is not defined" });
  });

  it("marks a runtime exception as a test error, not a crash", async () => {
    const r = await job("function sum(xs) { if (!xs.length) throw new RangeError('empty'); return 6; }");
    expect(r.status).toBe("graded");
    expect(r.results[1]).toMatchObject({ status: "error", error: "RangeError: empty" });
  });

  it("stops an infinite loop inside one test and keeps grading the others", async () => {
    const r = await job("function sum(xs) { while (xs.length === 0) {} return 6; }");
    expect(r.results.map((t) => t.status)).toEqual(["passed", "timeout", "failed"]);
  });

  it("stops an infinite loop at top level", async () => {
    const r = await job("while (true) {}");
    expect(r.status).toBe("timeout");
  });

  it("kills the worker when the wall-clock limit is hit before the CPU limit", async () => {
    const r = await grade(
      { code: "function sum() { return 1; } for(;;) { try { while(true){} } catch {} }", functionName: "sum", tests: sumTests, timeLimitMs: 5000 },
      { wallClockMs: 300 },
    );
    expect(r.status).toBe("timeout");
    expect(r.error).toMatch(/wall-clock/);
  });

  it("does not expose Node internals to student code", async () => {
    const tests: TestCase[] = [{ name: "probe", input: [], expected: "undefined,undefined,undefined" }];
    const r = await grade({
      code: "function probe() { return [typeof process, typeof require, typeof fetch].join(); }",
      functionName: "probe",
      tests,
      timeLimitMs: 200,
    });
    expect(r.score).toBe(100);
  });

  it("blocks eval and new Function", async () => {
    const r = await job("function sum() { return eval('6'); }");
    expect(r.results[0]).toMatchObject({ status: "error" });
    expect(r.results[0]?.error).toMatch(/EvalError|Code generation/);
  });

  it("does not let tests mutate each other's input", async () => {
    const tests: TestCase[] = [
      { name: "a", input: [[1]], expected: 1 },
      { name: "b", input: [[1]], expected: 1 },
    ];
    const r = await grade({
      code: "function f(xs) { xs.push(99); return xs[0]; }",
      functionName: "f",
      tests,
      timeLimitMs: 200,
    });
    expect(r.score).toBe(100);
    expect(tests[0]?.input).toEqual([[1]]);
  });

  it("crashes cleanly when memory limit is exceeded", async () => {
    const r = await grade(
      {
        code: "function sum() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }",
        functionName: "sum",
        tests: sumTests.slice(0, 1),
        timeLimitMs: 4000,
      },
      { maxHeapMb: 16, wallClockMs: 8000 },
    );
    expect(["crashed", "timeout"]).toContain(r.status);
    expect(r.score).toBe(0);
  });
});
