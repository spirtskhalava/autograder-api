import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase } from "./db/database.js";
import { Repository } from "./db/repository.js";
import { grade, type GraderOptions } from "./grader/grader.js";
import type { Assignment, TestCase } from "./types.js";

export interface AppOptions {
  dbPath?: string;
  logger?: boolean;
  grader?: GraderOptions;
  /** Max simultaneous grading workers; extra requests get 503 instead of queueing forever. */
  maxConcurrentGrades?: number;
}

const MAX_CODE_BYTES = 20_000;

const testCaseSchema = {
  type: "object",
  required: ["name", "input", "expected"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    input: { type: "array" },
    expected: {},
    hidden: { type: "boolean" },
  },
} as const;

const createAssignmentSchema = {
  body: {
    type: "object",
    required: ["title", "functionName", "tests"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      // Interpolated into sandbox code, so it must be a plain JS identifier.
      functionName: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]{0,63}$" },
      tests: { type: "array", minItems: 1, maxItems: 100, items: testCaseSchema },
      timeLimitMs: { type: "integer", minimum: 10, maximum: 5000, default: 1000 },
    },
  },
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

const submitSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["studentId", "code"],
    additionalProperties: false,
    properties: {
      studentId: { type: "string", minLength: 1, maxLength: 100 },
      code: { type: "string", minLength: 1 },
    },
  },
} as const;

/** What students see: hidden tests are reduced to their name. */
function publicView(a: Assignment) {
  return {
    ...a,
    tests: a.tests.map((t) => (t.hidden ? { name: t.name, hidden: true } : t)),
  };
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 256 * 1024,
    // Fastify's default strips unknown fields silently; reject them so client typos surface.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const db = openDatabase(opts.dbPath);
  const repo = new Repository(db);
  const maxConcurrent = opts.maxConcurrentGrades ?? 4;
  let running = 0;

  app.addHook("onClose", async () => db.close());

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/assignments", { schema: createAssignmentSchema }, async (req, reply) => {
    const body = req.body as { title: string; functionName: string; tests: TestCase[]; timeLimitMs: number };
    const names = body.tests.map((t) => t.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return reply.code(400).send({ error: "Bad Request", message: `Duplicate test name '${dup}'` });
    const created = repo.createAssignment(body);
    return reply.code(201).header("location", `/assignments/${created.id}`).send(publicView(created));
  });

  app.get("/assignments", async () => repo.listAssignments().map(publicView));

  app.get("/assignments/:id", { schema: { params: idParams } }, async (req, reply) => {
    const a = repo.getAssignment((req.params as { id: number }).id);
    return a ? publicView(a) : reply.code(404).send({ error: "Not Found", message: "Assignment not found" });
  });

  app.post("/assignments/:id/submissions", { schema: submitSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { studentId, code } = req.body as { studentId: string; code: string };

    const assignment = repo.getAssignment(id);
    if (!assignment) return reply.code(404).send({ error: "Not Found", message: "Assignment not found" });
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
      return reply.code(413).send({ error: "Payload Too Large", message: `Code exceeds ${MAX_CODE_BYTES} bytes` });
    }
    if (running >= maxConcurrent) {
      return reply.code(503).header("retry-after", "2").send({ error: "Service Unavailable", message: "Grader busy" });
    }

    running++;
    try {
      const result = await grade(
        { code, functionName: assignment.functionName, tests: assignment.tests, timeLimitMs: assignment.timeLimitMs },
        opts.grader,
      );
      const saved = repo.saveSubmission(id, studentId, code, result);
      return reply.code(201).send(saved);
    } finally {
      running--;
    }
  });

  app.get(
    "/assignments/:id/submissions",
    {
      schema: {
        params: idParams,
        querystring: { type: "object", properties: { studentId: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      if (!repo.getAssignment(id)) return reply.code(404).send({ error: "Not Found", message: "Assignment not found" });
      return repo.listSubmissions(id, (req.query as { studentId?: string }).studentId);
    },
  );

  app.get("/assignments/:id/stats", { schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    if (!repo.getAssignment(id)) return reply.code(404).send({ error: "Not Found", message: "Assignment not found" });
    return repo.stats(id);
  });

  return app;
}
