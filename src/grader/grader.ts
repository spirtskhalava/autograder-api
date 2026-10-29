import { Worker } from "node:worker_threads";
import type { GradeResult, SubmissionStatus, TestCase, TestResult } from "../types.js";

export interface GradeJob {
  code: string;
  functionName: string;
  tests: TestCase[];
  /** Per test-call CPU limit inside the sandbox. */
  timeLimitMs: number;
}

export interface GraderOptions {
  /** Hard wall-clock limit for the whole submission; the worker is killed after this. */
  wallClockMs?: number;
  maxHeapMb?: number;
}

interface WorkerReply {
  status: SubmissionStatus;
  results: TestResult[];
  error?: string;
}

const WORKER_URL = new URL("./worker.js", import.meta.url);

export async function grade(job: GradeJob, opts: GraderOptions = {}): Promise<GradeResult> {
  const wallClockMs = opts.wallClockMs ?? job.timeLimitMs * (job.tests.length + 1) + 1000;
  const started = performance.now();

  const reply = await new Promise<WorkerReply>((resolve) => {
    const worker = new Worker(WORKER_URL, {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? 64 },
      stdout: true, // don't let student output reach our logs
      stderr: true,
    });
    let settled = false;
    const finish = (r: WorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ status: "timeout", results: [], error: `Exceeded ${wallClockMs} ms wall-clock limit` }),
      wallClockMs,
    );
    worker.once("message", (msg: WorkerReply) => finish(msg));
    worker.once("error", (err) =>
      finish({ status: "crashed", results: [], error: err.message || "Worker crashed" }),
    );
    worker.once("exit", (code) => {
      if (code !== 0) finish({ status: "crashed", results: [], error: `Worker exited with code ${code}` });
    });
  });

  const total = job.tests.length;
  const passed = reply.results.filter((r) => r.status === "passed").length;
  return {
    status: reply.status,
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 1000) / 10,
    results: reply.results,
    ...(reply.error ? { error: reply.error } : {}),
    durationMs: Math.round(performance.now() - started),
  };
}
