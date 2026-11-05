import { access, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { toolDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFrozenRun,
  markRunStatus,
  seedCompanyOnly,
  seedQueuedToolStepRun,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { executePluginCoreToolCall } from "../services/workflow/plugin-core-tool-call.js";
import {
  createRuntimeExecutionLifecycle,
  deferredBeforeStartSchema,
  type RuntimeExecutionIdentity,
  type RuntimeExecutionLifecycle,
} from "../services/runtime-execution-lifecycle.js";

type Fixture = Extract<ExecutionDefinitionFixture, { supported: true }>;
let fixture: Fixture | undefined;
let db: Db;
let tempRoot = "";
const currentFixture = () => {
  if (!fixture) throw new Error("test_fixture_unavailable");
  return fixture;
};

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "http-core-start-"));
  const started = await startExecutionDefinitionFixture("http-core-start-");
  if (!started.supported) throw new Error(started.reason);
  fixture = started;
  db = started.db;
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function seedTool(name: string, adapterConfig: Record<string, unknown>) {
  const f = currentFixture();
  const { companyId } = await seedCompanyOnly(f.sql, `H2${randomUUID().replace(/-/gu, "").slice(0, 8)}`);
  await db.insert(toolDefinitions).values({ companyId, name, adapterType: "builtin", adapterConfig });
  return companyId;
}

async function seedNativeAttempt(adapterConfig: Record<string, unknown>) {
  const toolName = `h2-${randomUUID()}`;
  const companyId = await seedTool(toolName, adapterConfig);
  const f = currentFixture();
  const workflowId = await seedWorkflowDefinition(f.sql, { companyId, stepsJson: [
    { id: "publish", name: "Publish", agentId: "", dependencies: [], tools: [toolName], toolArgs: {} },
  ] });
  const run = await createFrozenRun(db, { workflowId, companyId });
  await markRunStatus(db, run.id, "running");
  const requestId = randomUUID();
  const step = await seedQueuedToolStepRun(db, { runId: run.id, stepId: "publish", requestId });
  return { toolName, companyId, runId: run.id, requestId, step };
}

function recordingLifecycle(afterStart?: (lifecycle: RuntimeExecutionLifecycle) => void) {
  const base = createRuntimeExecutionLifecycle();
  const identities: RuntimeExecutionIdentity[] = [];
  const lifecycle: RuntimeExecutionLifecycle = {
    createScope(identity) {
      identities.push(identity);
      const scope = base.createScope(identity);
      return afterStart ? { ...scope, start<T>(start: () => T) {
        const decision = scope.start(start);
        afterStart(lifecycle);
        return decision;
      } } : scope;
    },
    beginShutdown: signal => base.beginShutdown(signal),
    shutdownState: () => base.shutdownState(),
  };
  return { lifecycle, identities, base };
}

async function waitUntilBlocked(observer: Db, blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer.execute(sql`select pid, pg_blocking_pids(pid) as blockers, query
      from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid)) and query ilike '%workflow_step_runs%'`) as unknown as Array<{ pid: number; blockers: number[]; query: string }>;
    if (rows[0]?.blockers.includes(blockerPid)) return rows[0];
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`workflow_step_runs_wait_not_observed_for_${blockerPid}`);
}

async function exists(file: string) {
  try { await access(file); return true; } catch { return false; }
}

describe("HTTP core tool start boundary", () => {
  it("refuses a not-yet-started local child after shutdown during held DB preparation", async () => {
    const marker = path.join(tempRoot, "held-preparation-child-started");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
    const seeded = await seedNativeAttempt({ command: process.execPath,
      progress: { version: 1, idleTimeoutMs: 5_000, maxDurationMs: 15_000, stages: [{ key: "work", unit: "items" }] } });
    const locker = currentFixture().openConnection(), observer = currentFixture().openConnection();
    const heldClient = await locker.$client.reserve();
    let released = false;
    try {
      await heldClient.unsafe("begin");
      await heldClient.unsafe("select id from workflow_step_runs where id = $1::uuid for update", [seeded.step.id]);
      const [{ pid }] = await heldClient.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      const observed = recordingLifecycle();
      const execution = executeCoreWorkflowTool({ db, companyId: seeded.companyId, toolName: seeded.toolName,
        parameters: ["-e", script], requestId: seeded.requestId, workflowRunId: seeded.runId,
        stepRunId: seeded.step.id, stepId: "publish", runtimeLifecycle: observed.lifecycle });
      await waitUntilBlocked(observer, Number(pid));
      expect(observed.identities).toEqual([{ requestId: seeded.requestId, executionId: seeded.runId,
        attemptId: seeded.step.id, executionGeneration: seeded.step.executionGeneration }]);
      observed.lifecycle.beginShutdown("SIGTERM");
      await heldClient.unsafe("rollback");
      released = true;
      const result = await execution;
      expect(result.status).toBe(503);
      expect(deferredBeforeStartSchema.safeParse(result.deferredBeforeStart).success).toBe(true);
      expect(result.deferredBeforeStart).toMatchObject({ requestId: seeded.requestId, executionId: seeded.runId,
        attemptId: seeded.step.id, externalStarted: false });
      expect(await exists(marker)).toBe(false);
    } finally {
      if (!released) await heldClient.unsafe("rollback").catch(() => {});
      heldClient.release();
      await locker.$client.end({ timeout: 5 });
      await observer.$client.end({ timeout: 5 });
    }
  }, 30_000);

  it("keeps the native generation and returns the exact result of an already-started child", async () => {
    const seeded = await seedNativeAttempt({ command: process.execPath });
    const generation = 7;
    await db.update(workflowStepRuns).set({ executionGeneration: generation }).where(eq(workflowStepRuns.id, seeded.step.id));
    const originalBytes = Buffer.from("http-core-original-result");
    const script = `process.stdout.write(${JSON.stringify(originalBytes.toString("utf8"))})`;
    const observed = recordingLifecycle(lifecycle => lifecycle.beginShutdown("SIGTERM"));
    const httpRequestIdentity = { requestId: seeded.requestId, executionId: "http-execution", attemptId: "http-attempt",
      executionGeneration: generation + 100 };
    const result = await executeCoreWorkflowTool({ db, companyId: seeded.companyId, toolName: seeded.toolName,
      parameters: ["-e", script], requestId: seeded.requestId, workflowRunId: seeded.runId,
      stepRunId: seeded.step.id, stepId: "publish", httpRequestIdentity, runtimeLifecycle: observed.lifecycle });

    expect(observed.identities).toEqual([{ requestId: seeded.requestId, executionId: seeded.runId,
      attemptId: seeded.step.id, executionGeneration: generation }]);
    expect(observed.base.shutdownState()?.signal).toBe("SIGTERM");
    expect(result.status).toBe(200);
    expect(Buffer.from(result.body.content ?? "").equals(originalBytes)).toBe(true);
  }, 30_000);

  it("does not fall back to a valid HTTP identity when the complete native attempt is stale", async () => {
    const marker = path.join(tempRoot, "stale-native-child-started");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
    const seeded = await seedNativeAttempt({ command: process.execPath });
    const requestId = randomUUID();
    const httpRequestIdentity = { requestId, executionId: "http-execution", attemptId: "http-attempt", executionGeneration: 3 };
    const observed = recordingLifecycle();
    const result = await executeCoreWorkflowTool({ db, companyId: seeded.companyId, toolName: seeded.toolName,
      parameters: ["-e", script], requestId, workflowRunId: seeded.runId, stepRunId: seeded.step.id,
      stepId: "publish", httpRequestIdentity, runtimeLifecycle: observed.lifecycle });

    expect(result.status).toBe(500);
    expect(result.body.error).toBe("workflow_tool_attempt_stale");
    expect(observed.identities).toEqual([]);
    expect(await exists(marker)).toBe(false);
  }, 30_000);

  it("accepts the bridge's server identity and keeps the old call shape working", async () => {
    const name = `h2-bridge-${randomUUID()}`;
    const companyId = await seedTool(name, { command: process.execPath });
    const identity = { requestId: randomUUID(), executionId: "http-run", attemptId: "receipt", executionGeneration: 1 };
    const observed = recordingLifecycle();
    const bridgeInput = { db, actor: { type: "board", source: "session", companyId, agentId: null, runId: null } as never,
      runContext: { companyId, agentId: "", runId: "bridge-run" } as never, workflowRunIssueId: null, tool: name,
      parameters: ["-e", `process.stdout.write('bridge-result')`],
      stepEnv: { PAPERCLIP_WORKFLOW_RUN_ID: "display-run", PAPERCLIP_WORKFLOW_STEP_ID: "display-step" } };
    const result = await executePluginCoreToolCall({ ...bridgeInput, httpRequestIdentity: identity, runtimeLifecycle: observed.lifecycle });
    expect(result.status).toBe(200);
    expect(result.body.content).toBe("bridge-result");
    expect(observed.identities).toEqual([identity]);

    const legacyName = `h2-legacy-${randomUUID()}`;
    await db.insert(toolDefinitions).values({ companyId, name: legacyName, adapterType: "builtin", adapterConfig: { command: process.execPath } });
    const legacy = await executePluginCoreToolCall({ ...bridgeInput, tool: legacyName,
      parameters: ["-e", `process.stdout.write('legacy-bridge-result')`], stepEnv: {} });
    expect(legacy.status).toBe(200);
    expect(legacy.body.content).toBe("legacy-bridge-result");
  }, 30_000);
});
