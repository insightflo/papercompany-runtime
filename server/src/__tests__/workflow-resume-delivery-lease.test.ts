import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowResumeExecutions, workflowResumeRequests, missions, companies, type Db } from "@paperclipai/db";
import { startNativeEntryFixture, type NativeEntryFixture } from "./helpers/workflow-resume-native-entry-fixture.js";
import { loadDeliveryExecution, loadDeliveryRequest, markRunPendingDelivery, resetResumeDeliveryIsolation,
  seedResumeDeliveryGraph } from "./helpers/workflow-resume-delivery-fixture.js";

// Controlled await boundaries only. Serialization, claims and all authority writes use real PG.
const hooks = vi.hoisted(() => ({ locked: vi.fn(), committed: vi.fn(), runtime: vi.fn(), ready: vi.fn(), sync: vi.fn() }));
vi.mock("../services/workflow/resume/serialization.js", async (original) => {
  const actual = await original<typeof import("../services/workflow/resume/serialization.js")>();
  return { ...actual, withResumeSerialization: async (...args: Parameters<typeof actual.withResumeSerialization>) => {
    const result = await actual.withResumeSerialization(args[0], args[1], async (context) => {
      await hooks.locked();
      return args[2](context);
    });
    await hooks.committed();
    return result;
  } };
});
vi.mock("../services/missions/mission-workflow-lifecycle.js", async (original) => ({
  ...await original<typeof import("../services/missions/mission-workflow-lifecycle.js")>(),
  ensureMissionRuntimesForResumeReactivation: hooks.runtime,
}));
vi.mock("../services/workflow/resume/readiness.js", () => ({ assertResumeExecutionReadiness: hooks.ready }));
vi.mock("../services/workflow/dag-engine.js", async (original) => ({
  ...await original<typeof import("../services/workflow/dag-engine.js")>(), syncWorkflowRunState: hooks.sync,
}));
import { dispatchAcceptedResumeWork } from "../services/workflow/resume/dispatcher.js";
import { claimPendingResumeRequests, claimStaleResumeExecutions } from "../services/workflow/resume/execution-queue.js";

const future = new Date("2099-01-01T00:00:00Z");
describe("resume delivery DB-clock lease authority", () => {
  let fixture: Extract<NativeEntryFixture, { supported: true }>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    const started = await startNativeEntryFixture("resume-lease-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started; db = fixture.db; other = fixture.openConnection();
  }, 60_000);
  afterAll(async () => { await other?.$client.end({ timeout: 5 }); await fixture?.cleanup(); });
  beforeEach(async () => {
    Object.values(hooks).forEach((hook) => hook.mockReset());
    await resetResumeDeliveryIsolation(db, new Date());
  });
  async function seed() {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "lease" });
    return { ...graph, requestId: await markRunPendingDelivery(db, graph) };
  }
  async function execution(requestId: string, state = "queued") {
    const [request] = await db.select().from(workflowResumeRequests).where(eq(workflowResumeRequests.id, requestId));
    await db.insert(workflowResumeExecutions).values({
      requestId, companyId: request!.companyId, missionId: request!.missionId,
      workflowRunId: request!.workflowRunId, authorityVersion: 3, generations: request!.appliedGenerations, state,
    });
  }
  async function expireExecution(requestId: string) {
    await other.update(workflowResumeExecutions).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(workflowResumeExecutions.requestId, requestId));
  }
  async function takeover(requestId: string) {
    await expireExecution(requestId);
    expect(await claimStaleResumeExecutions(other, { owner: "new-owner" })).toHaveLength(1);
  }
  it("caller future Date cannot steal a live request or execution lease", async () => {
    const { requestId } = await seed();
    await claimPendingResumeRequests(db, { owner: "live" });
    expect(await claimPendingResumeRequests(other, { now: future })).toHaveLength(0);
    expect((await loadDeliveryRequest(fixture.sql, requestId))?.lease_owner).toBe("live");
    await execution(requestId);
    await claimStaleResumeExecutions(db, { owner: "live" });
    expect(await claimStaleResumeExecutions(other, { now: future })).toHaveLength(0);
    expect((await loadDeliveryExecution(fixture.sql, requestId))?.lease_owner).toBe("live");
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 101, null, "10", true] as number[])("rejects malformed limit %s before SQL", async (limit) => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      await expect(claimPendingResumeRequests(db, { limit })).rejects.toThrow();
      await expect(claimStaleResumeExecutions(db, { limit })).rejects.toThrow();
      await expect(dispatchAcceptedResumeWork(db, { maxItems: limit })).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });
  it.each([NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, 300_001, null, "30000", true] as number[])("rejects malformed leaseMs %s before SQL", async (leaseMs) => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      await expect(claimPendingResumeRequests(db, { leaseMs })).rejects.toThrow();
      await expect(claimStaleResumeExecutions(db, { leaseMs })).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });
  it.each(["accept", "block", "cancel"])("expired pending owner cannot %s after takeover while waiting for serialization", async (action) => {
    const graph = await seed();
    if (action === "block") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 })
      .where(eq(companies.id, graph.companyId));
    if (action === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, graph.missionId));
    let before: unknown;
    hooks.locked.mockImplementationOnce(async () => {
      await other.update(workflowResumeRequests).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(workflowResumeRequests.id, graph.requestId));
      expect(await claimPendingResumeRequests(other, { owner: "new-owner" })).toHaveLength(1);
      before = await loadDeliveryRequest(fixture.sql, graph.requestId);
    });
    const result = await dispatchAcceptedResumeWork(db);
    expect(result).toMatchObject({ skippedCount: 1, acceptedCount: 0, blockedCount: 0, cancelledCount: 0, failedCount: 0 });
    expect(await loadDeliveryRequest(fixture.sql, graph.requestId)).toEqual(before);
    expect(await loadDeliveryExecution(fixture.sql, graph.requestId)).toBeUndefined();
    expect(hooks.runtime).not.toHaveBeenCalled();
  });
  it("pending-to-accepted commit includes the same owner's live execution lease", async () => {
    const { requestId } = await seed();
    let owner: unknown;
    hooks.locked.mockImplementationOnce(async () => { owner = (await loadDeliveryRequest(fixture.sql, requestId))?.lease_owner; });
    hooks.committed.mockImplementationOnce(async () => {
      expect((await loadDeliveryRequest(fixture.sql, requestId))?.state).toBe("accepted");
      const row = await loadDeliveryExecution(fixture.sql, requestId);
      expect(row).toMatchObject({ state: "queued", lease_owner: owner });
      expect(await claimStaleResumeExecutions(other, { now: future })).toHaveLength(0);
      expect(await dispatchAcceptedResumeWork(other, { now: future })).toMatchObject({ claimedCount: 0, completedCount: 0 });
    });
    expect(await dispatchAcceptedResumeWork(db, { now: future })).toMatchObject({ completedCount: 1, failedCount: 0 });
    const [row] = await fixture.sql`SELECT completed_at < clock_timestamp() AND completed_at > clock_timestamp() - interval '1 minute' AS db_time
      FROM workflow_resume_executions WHERE request_id = ${requestId}`;
    expect(row!.db_time).toBe(true);
  });
  it.each(["committed", "runtime", "ready", "sync"] as const)("loss at %s boundary aborts running/next boundary/completion", async (boundary) => {
    const { requestId } = await seed();
    hooks[boundary].mockImplementationOnce(() => takeover(requestId));
    const result = await dispatchAcceptedResumeWork(db);
    expect(result).toMatchObject({ completedCount: 0, skippedCount: 1, failedCount: 0 });
    const row = await loadDeliveryExecution(fixture.sql, requestId);
    expect(row).toMatchObject({ lease_owner: "new-owner", completed_at: null, state: boundary === "committed" ? "queued" : "running" });
    if (boundary === "committed") expect(hooks.runtime).not.toHaveBeenCalled();
    if (boundary === "runtime" || boundary === "committed") expect(hooks.ready).not.toHaveBeenCalled();
    if (boundary !== "sync") expect(hooks.sync).not.toHaveBeenCalled();
  });
  it("expired owner without takeover cannot report completion", async () => {
    const { requestId } = await seed();
    hooks.sync.mockImplementationOnce(() => expireExecution(requestId));
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ completedCount: 0, skippedCount: 1 });
    expect((await loadDeliveryExecution(fixture.sql, requestId))?.completed_at).toBeNull();
  });
  it.each(["blocked", "cancelled", "completed"])("pending path never resurrects a %s execution", async (state) => {
    const { requestId } = await seed();
    await execution(requestId, state);
    const before = await loadDeliveryExecution(fixture.sql, requestId);
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, completedCount: 0, skippedCount: 1 });
    expect(await loadDeliveryExecution(fixture.sql, requestId)).toEqual(before);
    expect((await loadDeliveryRequest(fixture.sql, requestId))?.state).toBe("pending_delivery");
  });
  it.each(["blocked", "cancelled", "accepted"])("pending claim cannot authorize a newly %s request", async (state) => {
    const { requestId } = await seed();
    hooks.locked.mockImplementationOnce(async () => {
      await other.update(workflowResumeRequests).set({ state }).where(eq(workflowResumeRequests.id, requestId));
    });
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, skippedCount: 1 });
    expect((await loadDeliveryRequest(fixture.sql, requestId))?.state).toBe(state);
    expect(await loadDeliveryExecution(fixture.sql, requestId)).toBeUndefined();
  });
  it.each(["accept", "block", "cancel"])("stale execution provenance cannot %s after another owner takes over", async (action) => {
    const graph = await seed();
    await db.update(workflowResumeRequests).set({ state: "accepted" }).where(eq(workflowResumeRequests.id, graph.requestId));
    await execution(graph.requestId, "running");
    if (action === "block") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 })
      .where(eq(companies.id, graph.companyId));
    if (action === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, graph.missionId));
    let before: unknown;
    hooks.locked.mockImplementationOnce(async () => {
      await takeover(graph.requestId); before = await loadDeliveryExecution(fixture.sql, graph.requestId);
    });
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, blockedCount: 0, cancelledCount: 0, skippedCount: 1 });
    expect(await loadDeliveryExecution(fixture.sql, graph.requestId)).toEqual(before);
    expect((await loadDeliveryRequest(fixture.sql, graph.requestId))?.state).toBe("accepted");
  });
  it.each(["committed", "runtime", "ready"] as const)("expiry alone at %s prevents the next operation", async (boundary) => {
    const { requestId } = await seed();
    hooks[boundary].mockImplementationOnce(() => expireExecution(requestId));
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ completedCount: 0, skippedCount: 1, failedCount: 0 });
    if (boundary === "committed") expect(hooks.runtime).not.toHaveBeenCalled();
    if (boundary !== "ready") expect(hooks.ready).not.toHaveBeenCalled();
    expect(hooks.sync).not.toHaveBeenCalled();
  });
  it.each(["completed", "blocked", "cancelled"])("stale claim never resurrects an execution that becomes %s before acceptance", async (state) => {
    const { requestId } = await seed();
    await db.update(workflowResumeRequests).set({ state: "accepted" }).where(eq(workflowResumeRequests.id, requestId));
    await execution(requestId, "running");
    let before: unknown;
    hooks.locked.mockImplementationOnce(async () => {
      await other.update(workflowResumeExecutions).set({ state }).where(eq(workflowResumeExecutions.requestId, requestId));
      before = await loadDeliveryExecution(fixture.sql, requestId);
    });
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, completedCount: 0, skippedCount: 1 });
    expect(await loadDeliveryExecution(fixture.sql, requestId)).toEqual(before);
  });
  it("stale execution must match the request's current scope", async () => {
    const { requestId } = await seed();
    await db.update(workflowResumeRequests).set({ state: "accepted" }).where(eq(workflowResumeRequests.id, requestId));
    await execution(requestId);
    const foreign = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "foreign" });
    await db.update(workflowResumeExecutions).set({ workflowRunId: foreign.runId })
      .where(eq(workflowResumeExecutions.requestId, requestId));
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, completedCount: 0, skippedCount: 1 });
    expect(hooks.runtime).not.toHaveBeenCalled();
    expect((await loadDeliveryExecution(fixture.sql, requestId))?.workflow_run_id).toBe(foreign.runId);
  });
  it.each(["blocked", "cancelled"])("terminal request at commit cannot authorize markRunning (%s)", async (state) => {
    const { requestId } = await seed();
    hooks.committed.mockImplementationOnce(async () => {
      await other.update(workflowResumeRequests).set({ state }).where(eq(workflowResumeRequests.id, requestId));
    });
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ completedCount: 0, skippedCount: 1 });
    expect((await loadDeliveryExecution(fixture.sql, requestId))?.state).toBe("queued");
    expect(hooks.runtime).not.toHaveBeenCalled();
  });
  it("a conditional completion that returns no row never increments completedCount", async () => {
    const { requestId } = await seed();
    hooks.sync.mockImplementationOnce(async () => {
      await other.update(workflowResumeExecutions).set({ state: "cancelled" })
        .where(eq(workflowResumeExecutions.requestId, requestId));
    });
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ completedCount: 0, skippedCount: 1 });
    expect((await loadDeliveryExecution(fixture.sql, requestId))?.state).toBe("cancelled");
  });
  it.each(["blocked", "cancelled"])("stale recovery never resurrects a terminal %s request", async (state) => {
    const { requestId } = await seed();
    await db.update(workflowResumeRequests).set({ state }).where(eq(workflowResumeRequests.id, requestId));
    await execution(requestId);
    expect(await dispatchAcceptedResumeWork(db)).toMatchObject({ acceptedCount: 0, completedCount: 0, skippedCount: 1 });
    expect((await loadDeliveryRequest(fixture.sql, requestId))?.state).toBe(state);
    expect(hooks.runtime).not.toHaveBeenCalled();
  });
});
