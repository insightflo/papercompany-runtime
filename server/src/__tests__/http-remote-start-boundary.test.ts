import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { toolDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFrozenRun,
  markRunStatus,
  seedCompanyOnly,
  seedQueuedToolStepRun,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { secretService } from "../services/secrets.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  createRuntimeExecutionLifecycle,
  deferredBeforeStartSchema,
  type RuntimeExecutionIdentity,
  type RuntimeExecutionLifecycle,
} from "../services/runtime-execution-lifecycle.js";

type Fixture = Extract<ExecutionDefinitionFixture, { supported: true }>;
let fixture: Fixture | undefined;
let db: Db;

beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "0".repeat(64));
  const started = await startExecutionDefinitionFixture("http-remote-start-");
  if (!started.supported) throw new Error(started.reason);
  fixture = started;
  db = started.db;
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

function currentFixture() {
  if (!fixture) throw new Error("test_fixture_unavailable");
  return fixture;
}

function observedLifecycle() {
  const base = createRuntimeExecutionLifecycle();
  const identities: RuntimeExecutionIdentity[] = [];
  const lifecycle: RuntimeExecutionLifecycle = {
    createScope(identity) {
      identities.push(identity);
      return base.createScope(identity);
    },
    beginShutdown: (signal) => base.beginShutdown(signal),
    shutdownState: () => base.shutdownState(),
  };
  return { base, lifecycle, identities };
}

async function startPeer(resultValue: Record<string, unknown>, holdResponse = false) {
  const posts: Array<{ body: string; authorization?: string }> = [];
  let resolvePosted!: () => void;
  const posted = new Promise<void>((resolve) => { resolvePosted = resolve; });
  let releaseResponse!: () => void;
  const responseGate = holdResponse
    ? new Promise<void>((resolve) => { releaseResponse = resolve; })
    : Promise.resolve();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    posts.push({ body: Buffer.concat(chunks).toString("utf8"), authorization: request.headers.authorization });
    resolvePosted();
    await responseGate;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: resultValue }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("http_peer_address_missing");
  return {
    url: `http://127.0.0.1:${address.port}/tool`,
    posts,
    posted,
    releaseResponse: () => releaseResponse?.(),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function seedHttpTool(url: string) {
  const companyId = (await seedCompanyOnly(currentFixture().sql,
    `R${randomUUID().replace(/-/gu, "").slice(0, 8).toUpperCase()}`)).companyId;
  const name = `remote-${randomUUID()}`;
  const secret = await secretService(db).create(companyId, {
    name: `auth-${name}`, provider: "local_encrypted", value: "remote-start-secret",
  });
  await db.insert(toolDefinitions).values({
    companyId,
    name,
    adapterType: "http",
    adapterConfig: {
      url,
      method: "POST",
      allowInsecureUrl: true,
      timeoutMs: 10_000,
      auth: { type: "header", headerName: "Authorization", secretId: secret.id, version: "latest" },
      response: { resultField: "result" },
    },
  });
  return { companyId, name };
}

async function seedNativeHttpAttempt(url: string) {
  const tool = await seedHttpTool(url);
  const workflowId = await seedWorkflowDefinition(currentFixture().sql, {
    companyId: tool.companyId,
    stepsJson: [{ id: "publish", name: "Publish", agentId: "", dependencies: [], tools: [tool.name], toolArgs: {} }],
  });
  const run = await createFrozenRun(db, { workflowId, companyId: tool.companyId });
  await markRunStatus(db, run.id, "running");
  const requestId = randomUUID();
  const step = await seedQueuedToolStepRun(db, { runId: run.id, stepId: "publish", requestId });
  return { ...tool, runId: run.id, requestId, step };
}

async function waitUntilBlocked(observer: Db, blockerPid: number, table: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const query = sql`select pid, pg_blocking_pids(pid) as blockers, query
      from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid)) and query ilike ${`%${table}%`}`;
    const rows = await observer.execute(query) as unknown as Array<{ pid: number; blockers: number[]; query: string }>;
    const blocked = rows.find((row) => row.blockers.includes(blockerPid));
    if (blocked) return blocked;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`database_wait_not_observed_for_${table}_${blockerPid}`);
}

function httpIdentity(requestId: string): RuntimeExecutionIdentity {
  return { requestId, executionId: `http-run-${randomUUID()}`, attemptId: `http-attempt-${randomUUID()}`, executionGeneration: 1 };
}

describe("HTTP remote start boundary", () => {
  it("positively defers without a POST when secret preparation is released after shutdown", async () => {
    const peer = await startPeer({ ok: "must-not-start" });
    const tool = await seedHttpTool(peer.url);
    const identity = httpIdentity(randomUUID());
    const observed = observedLifecycle();
    const locker = currentFixture().openConnection();
    const observer = currentFixture().openConnection();
    const heldClient = await locker.$client.reserve();
    let released = false;
    try {
      await heldClient.unsafe("begin");
      await heldClient.unsafe("lock table company_secrets in access exclusive mode");
      const [{ pid }] = await heldClient.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      const execution = executeCoreWorkflowTool({ db, companyId: tool.companyId, toolName: tool.name,
        parameters: { payload: "held" }, requestId: identity.requestId, httpRequestIdentity: identity,
        runtimeLifecycle: observed.lifecycle });
      await waitUntilBlocked(observer, Number(pid), "company_secrets");
      expect(observed.identities).toEqual([identity]);
      observed.lifecycle.beginShutdown("SIGTERM");
      await heldClient.unsafe("rollback");
      released = true;

      const result = await execution;
      const expected = { kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down",
        externalStarted: false, ...identity };
      expect(result.status).toBe(503);
      expect(deferredBeforeStartSchema.safeParse(result.deferredBeforeStart).success).toBe(true);
      expect(result.deferredBeforeStart).toEqual(expected);
      expect(peer.posts).toHaveLength(0);
    } finally {
      if (!released) await heldClient.unsafe("rollback").catch(() => {});
      heldClient.release();
      await locker.$client.end({ timeout: 5 });
      await observer.$client.end({ timeout: 5 });
      await peer.close();
    }
  }, 30_000);

  it("returns the original HTTP result when shutdown begins after the real POST", async () => {
    const original = { ok: true, receipt: "begun-post-result" };
    const peer = await startPeer(original, true);
    try {
      const tool = await seedHttpTool(peer.url);
      const identity = httpIdentity(randomUUID());
      const observed = observedLifecycle();
      const execution = executeCoreWorkflowTool({ db, companyId: tool.companyId, toolName: tool.name,
        parameters: { payload: "begin" }, requestId: identity.requestId, httpRequestIdentity: identity,
        runtimeLifecycle: observed.lifecycle });
      await peer.posted;
      expect(peer.posts).toHaveLength(1);
      expect(JSON.parse(peer.posts[0]!.body)).toEqual({ payload: "begin" });
      expect(peer.posts[0]!.authorization).toBe("remote-start-secret");
      observed.base.beginShutdown("SIGTERM");
      peer.releaseResponse();

      const result = await execution;
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual(original);
      expect(result.deferredBeforeStart).toBeUndefined();
      expect(observed.identities).toEqual([identity]);
    } finally {
      peer.releaseResponse();
      await peer.close();
    }
  }, 30_000);

  it("does not use a valid HTTP identity to rescue a stale complete native tuple", async () => {
    const peer = await startPeer({ ok: "must-not-fallback" });
    try {
      const seeded = await seedNativeHttpAttempt(peer.url);
      const requestId = randomUUID();
      const identity = httpIdentity(requestId);
      const observed = observedLifecycle();
      const result = await executeCoreWorkflowTool({ db, companyId: seeded.companyId, toolName: seeded.name,
        parameters: {}, requestId, workflowRunId: seeded.runId, stepRunId: seeded.step.id, stepId: "publish",
        httpRequestIdentity: identity, runtimeLifecycle: observed.lifecycle });

      expect(result.status).toBe(500);
      expect(result.body.error).toBe("workflow_tool_attempt_stale");
      expect(observed.identities).toEqual([]);
      expect(peer.posts).toHaveLength(0);
    } finally {
      await peer.close();
    }
  }, 30_000);

  it("uses the exact native attempt generation ahead of a valid but conflicting HTTP identity", async () => {
    const peer = await startPeer({ ok: true, owner: "native-generation" });
    try {
      const seeded = await seedNativeHttpAttempt(peer.url);
      const generation = 7;
      await db.update(workflowStepRuns).set({ executionGeneration: generation })
        .where(eq(workflowStepRuns.id, seeded.step.id));
      const identity = { requestId: seeded.requestId, executionId: "http-execution",
        attemptId: "http-attempt", executionGeneration: generation + 100 };
      const observed = observedLifecycle();
      const result = await executeCoreWorkflowTool({ db, companyId: seeded.companyId, toolName: seeded.name,
        parameters: { payload: "native" }, requestId: seeded.requestId, workflowRunId: seeded.runId,
        stepRunId: seeded.step.id, stepId: "publish", httpRequestIdentity: identity,
        runtimeLifecycle: observed.lifecycle });

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ ok: true, owner: "native-generation" });
      expect(peer.posts).toHaveLength(1);
      expect(observed.identities).toEqual([{ requestId: seeded.requestId, executionId: seeded.runId,
        attemptId: seeded.step.id, executionGeneration: generation }]);
    } finally {
      await peer.close();
    }
  }, 30_000);
});
