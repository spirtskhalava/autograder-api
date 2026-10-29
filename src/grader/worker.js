// @ts-check
/**
 * Runs inside a worker thread. Executes untrusted student code in a fresh `vm`
 * context and runs each test case against the exported function.
 *
 * Isolation layers (see docs/DECISIONS.md, D1):
 *   1. vm context with no `require`, `process`, `import`, timers or fetch.
 *   2. Per-call `timeout` stops synchronous infinite loops.
 *   3. The parent kills the whole worker on a wall-clock deadline and caps its heap.
 * This is NOT a security boundary against a determined attacker.
 */
import { parentPort, workerData } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";

/** @typedef {import("../types.js").TestCase} TestCase */
/** @typedef {import("../types.js").TestResult} TestResult */

/** @param {unknown} err */
function describe(err) {
  if (err && typeof err === "object" && "message" in err) {
    const name = "name" in err ? String(err.name) : "Error";
    return `${name}: ${String(err.message)}`;
  }
  return String(err);
}

/**
 * Values from another vm context have different prototypes, so we round-trip
 * through JSON to compare and report plain data.
 * @param {unknown} value
 */
function toPlain(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** @param {{ code: string; functionName: string; tests: TestCase[]; timeLimitMs: number }} job */
function run({ code, functionName, tests, timeLimitMs }) {
  const sandbox = Object.create(null);
  sandbox.console = { log() {}, error() {}, warn() {} }; // swallow student logging
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false }, // no eval / new Function
  });

  try {
    new vm.Script(code, { filename: "submission.js" }).runInContext(context, { timeout: timeLimitMs });
  } catch (err) {
    const isTimeout = /Script execution timed out/.test(String(err));
    return { status: isTimeout ? "timeout" : "compile_error", error: describe(err), results: [] };
  }

  // Support both `function solve() {}` and `const solve = () => {}`.
  let fn;
  try {
    fn = vm.runInContext(`typeof ${functionName} === "function" ? ${functionName} : undefined`, context);
  } catch {
    fn = undefined;
  }
  if (typeof fn !== "function") {
    return { status: "compile_error", error: `Function '${functionName}' is not defined`, results: [] };
  }
  context.__fn = fn;

  /** @type {TestResult[]} */
  const results = tests.map((test) => {
    const hidden = Boolean(test.hidden);
    const base = { name: test.name, hidden };
    try {
      context.__args = JSON.parse(JSON.stringify(test.input));
      const raw = vm.runInContext("__fn(...__args)", context, { timeout: timeLimitMs });
      const actual = toPlain(raw);
      const passed = isDeepStrictEqual(actual, test.expected);
      return hidden
        ? { ...base, status: passed ? "passed" : "failed" }
        : { ...base, status: passed ? "passed" : "failed", expected: test.expected, actual };
    } catch (err) {
      const timedOut = /Script execution timed out/.test(String(err));
      return {
        ...base,
        status: timedOut ? "timeout" : "error",
        ...(hidden ? {} : { error: describe(err) }),
      };
    }
  });

  return { status: "graded", results };
}

parentPort?.postMessage(run(workerData));
