import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, missions, pluginToolExecutionReceipts, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { decodeRetainedToolOutcome, stageRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import {
  bindRetainedWorkflowTool, finalizeRetainedWorkflowTool, processQueuedWorkflowToolStepRuns,
  reconcileOrphanedWorkflowToolStepClaims, setWorkflowToolStepExecutor,
  type WorkflowToolStepExecutionRequest,
} from "../services/workflow/dag-engine.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const now = new Date("2026-10-29T12:00:00.000Z");
const oldAcceptedAt = new Date(now.getTime() - 60 * 60_000);
const toolName = "plugin:retained-fence";
const args = { query: "preserve complete result" };
const payload = { content: "full worker result", data: { nested: [1, { complete: true }] } };
const actual: ToolOutcome = { kind: "result", result: payload, response: { jsonrpc: "2.0", id: 1, result: payload } };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function pauseAfterFirstWorkflowStepRunSelect(db: Db, selected: (count: number) => Promise<void>): Db {
  let paused = false;
  const wrapCandidateBuilder = (builder: object): object => {
    let proxy: object;
    proxy = new Proxy(builder, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (property === "then" && typeof member === "function") {
          return (resolve: (rows: unknown) => void, reject: (error: unknown) => void) => {
            const query = (member as (...args: unknown[]) => Promise<unknown>).call(target,
              async (rows: unknown) => {
                if (!paused) {
                  paused = true;
                  await selected(Array.isArray(rows) ? rows.length : 0);
                }
                return rows;
              }, reject);
            void query.then(resolve, reject);
          };
        }
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const result = (member as (...values: unknown[]) => unknown).apply(target, args);
          if (result === target) return proxy;
          return result && typeof result === "object" ? wrapCandidateBuilder(result) : result;
        };
      },
    });
    return proxy;
  };

  return new Proxy(db, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (property === "select" && typeof member === "function") {
        return (...args: unknown[]) => {
          const builder = (member as (...values: unknown[]) => object).apply(target, args);
          return new Proxy(builder, {
            get(query, method) {
              const operation = Reflect.get(query, method, query) as unknown;
              if (method === "from" && typeof operation === "function") {
                return (table: unknown, ...fromArgs: unknown[]) => {
                  const result = (operation as (...values: unknown[]) => object).call(query, table, ...fromArgs);
                  return table === workflowStepRuns ? wrapCandidateBuilder(result) : result;
                };
              }
              return typeof operation === "function"
                ? (operation as (...values: unknown[]) => unknown).bind(query)
                : operation;
            },
          });
        };
      }
      return typeof member === "function"
        ? (member as (...args: unknown[]) => unknown).bind(target)
        : member;
    },
  });
}

describe("workflow retained tool claim fence", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("workflow-retained-claim-fence-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(pluginToolExecutionReceipts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(workflowDefinitions);
    await db.delete(companies);
  });

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp.cleanup(); });

  async function seed(input: { acceptedAt?: Date | null; marker?: unknown } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), runId = randomUUID(), stepRunId = randomUUID();
    const stepId = "tool", requestId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retained Fence",
      issuePrefix: `RF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Retained Fence Workflow",
      status: "active", timezone: "UTC", stepsJson: [{ id: stepId, name: "Tool", agentId: "", type: "tool",
        toolNames: [toolName], toolArgs: args, dependencies: [] }] });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId,
      status: "running", triggeredBy: "test" });
    const acceptedAt = input.acceptedAt === undefined ? oldAcceptedAt : input.acceptedAt;
    const invocation = { requestId, toolName, args, ...(input.marker !== undefined ? { retainedCompletion: input.marker } : {}) };
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId, status: "running",
      executionGeneration: 2, statusTransitionVersion: 7, startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
      lastDispatchRequestId: requestId, lastDispatchAcceptedAt: acceptedAt,
      metadata: { toolQueue: { status: acceptedAt ? "claimed" : "queued", claimedAt: acceptedAt?.toISOString() },
        toolInvocation: invocation } });
    const isoAcceptedAt = acceptedAt?.toISOString() ?? now.toISOString();
    return { companyId, missionId, workflowId, runId, stepRunId, stepId, requestId, acceptedAt,
      scope: { companyId, tool: toolName, parameters: args, workflow: {
        missionId, workflowRunId: runId, stepRunId, stepId, requestId, executionGeneration: 2,
        statusTransitionVersion: 7, runStatus: "running" as const, stepStatus: "running" as const,
        acceptedAt: isoAcceptedAt,
      } } };
  }

  async function readStep(seedRow: Awaited<ReturnType<typeof seed>>) {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seedRow.stepRunId));
    return row;
  }

  async function waitForBlockedQuery(fragment: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [blocked] = await db.execute(sql`select pid from pg_stat_activity
        where pid <> pg_backend_pid() and state = 'active' and wait_event_type = 'Lock'
          and query like ${`%${fragment}%`} limit 1`);
      if (blocked) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`database lock barrier was not reached for ${fragment}`);
  }

  it("keeps a claim selected before binding, its full actual, and dispatch count unchanged", async () => {
    const s = await seed();
    let selected!: () => void, release!: () => void;
    let selectedCount = 0;
    const selection = new Promise<void>((resolve) => { selected = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reaperDb = pauseAfterFirstWorkflowStepRunSelect(db, async (candidateCount) => {
      selectedCount = candidateCount;
      selected(); await gate;
    });
    const reaper = reconcileOrphanedWorkflowToolStepClaims(reaperDb, { now });
    let receiptId = "";
    let owner: Parameters<typeof finalizeRetainedWorkflowTool>[1] | undefined;
    try {
      await selection;
      expect(selectedCount).toBe(1);
      const binding = await bindRetainedWorkflowTool(db, s.scope);
      expect(binding.kind).toBe("claim");
      if (binding.kind !== "claim") throw new Error("retained binding did not win");
      owner = binding.owner;
      receiptId = binding.owner.receiptId;
      await stageRetainedToolOutcome(db, binding.owner, actual);
    } finally {
      release();
    }
    expect(await reaper).toEqual({ orphanedCount: 0, skippedCount: 1 });
    const bound = await readStep(s);
    const [receipt] = await db.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, receiptId));
    expect(bound.status).toBe("running");
    expect(bound.lastDispatchAcceptedAt).toEqual(s.acceptedAt);
    expect(record(bound.metadata).toolQueue).toMatchObject({ status: "claimed" });
    expect(record(record(bound.metadata).toolInvocation)).toHaveProperty("retainedCompletion");
    expect(receipt.status).toBe("executing");
    expect(receipt.completedAt).toBeNull();
    expect(receipt.resultStatus).toBeNull();
    expect(decodeRetainedToolOutcome(receipt.resultBody)?.actual).toEqual(actual);

    let sends = 0;
    setWorkflowToolStepExecutor(async () => { sends += 1; return { accepted: true }; });
    const queue = await processQueuedWorkflowToolStepRuns(db, { now });
    expect(queue.claimedCount).toBe(0);
    expect(queue.executedCount).toBe(0);
    expect(queue.failedCount).toBe(0);
    expect(sends).toBe(0);
    expect(await readStep(s)).toEqual(bound);

    if (!owner) throw new Error("retained binding did not return a finalization owner");
    await finalizeRetainedWorkflowTool(db, owner, actual);
    expect((await readStep(s)).status).toBe("completed");
    const [finalizedReceipt] = await db.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, receiptId));
    expect(finalizedReceipt.status).toBe("completed");
    expect(decodeRetainedToolOutcome(finalizedReceipt.resultBody)?.actual).toEqual(actual);
  });

  it("holds even a null retained marker instead of treating age as proof of no start", async () => {
    const s = await seed({ marker: null });
    const before = await readStep(s);
    expect(await reconcileOrphanedWorkflowToolStepClaims(db, { now }))
      .toEqual({ orphanedCount: 0, skippedCount: 0 });
    expect(await readStep(s)).toEqual(before);
  });

  it("does not let a full retained candidate window starve an ordinary expired claim", async () => {
    const retained = await Promise.all(Array.from({ length: 25 }, () =>
      seed({ acceptedAt: oldAcceptedAt, marker: null })));
    const ordinary = await seed({ acceptedAt: new Date(now.getTime() - 45 * 60_000) });
    const retainedBefore = await Promise.all(retained.map(readStep));

    expect(await reconcileOrphanedWorkflowToolStepClaims(db, { limit: 25, now }))
      .toEqual({ orphanedCount: 1, skippedCount: 0 });
    expect((await readStep(ordinary)).status).toBe("failed");
    expect((await readStep(ordinary)).lastDispatchErrorSummary).toContain("orphaned");
    expect(await Promise.all(retained.map(readStep))).toEqual(retainedBefore);
  });

  it("lets an ordinary reaper win first and then refuses binding without dispatch", async () => {
    const s = await seed();
    expect(await reconcileOrphanedWorkflowToolStepClaims(db, { now }))
      .toEqual({ orphanedCount: 1, skippedCount: 0 });
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(failed.status).toBe("failed");
    expect(failed.lastDispatchErrorSummary).toContain("orphaned");
    const decision = await bindRetainedWorkflowTool(db, s.scope).then((value) => value, () => null);
    expect(decision?.kind).not.toBe("claim");
    expect(record(record(failed.metadata).toolInvocation)).not.toHaveProperty("retainedCompletion");
    expect(await db.select().from(pluginToolExecutionReceipts)).toHaveLength(0);
    let sends = 0;
    setWorkflowToolStepExecutor(async () => { sends += 1; return { accepted: true }; });
    const queue = await processQueuedWorkflowToolStepRuns(db, { now });
    expect(queue.claimedCount).toBe(0);
    expect(queue.executedCount).toBe(0);
    expect(sends).toBe(0);
  });

  it("captures generation and status version from the winning claimed row", async () => {
    const s = await seed({ acceptedAt: null });
    let lockReady!: () => void, unlock!: () => void;
    const ready = new Promise<void>((resolve) => { lockReady = resolve; });
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId)).for("update");
      await tx.update(workflowStepRuns).set({ executionGeneration: 9, statusTransitionVersion: 23 })
        .where(eq(workflowStepRuns.id, s.stepRunId));
      lockReady(); await gate;
    });
    await ready;
    let captured: WorkflowToolStepExecutionRequest | undefined;
    setWorkflowToolStepExecutor(async (request) => { captured = request; return { accepted: true }; });
    const dispatch = processQueuedWorkflowToolStepRuns(db, { now });
    try { await waitForBlockedQuery("workflow_step_runs"); }
    finally { unlock(); await holder; }
    const result = await dispatch;
    const claimed = await readStep(s);
    expect(result.claimedCount).toBe(1);
    expect(result.executedCount).toBe(1);
    expect(captured?.originalAuthority).toEqual({ missionId: s.missionId, workflowRunId: s.runId,
      stepRunId: s.stepRunId, stepId: s.stepId, requestId: s.requestId, executionGeneration: 9,
      statusTransitionVersion: 23, runStatus: "running", stepStatus: "running",
      acceptedAt: claimed.lastDispatchAcceptedAt?.toISOString() });
    expect(claimed.executionGeneration).toBe(9);
    expect(claimed.statusTransitionVersion).toBe(23);
  });
});
