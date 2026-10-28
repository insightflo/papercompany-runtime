import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDb, agents, companies, issues, heartbeatRuns, heartbeatRunEvents, issueComments,
  activityLog, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, toolDefinitions,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { successfulAdapterResult, waitForRunTerminal } from "./heartbeat-raw-provider-session-rotation.helpers.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { createToolProgressStore } from "../services/tools/progress-store.js";
import { workProductService } from "../services/work-products.js";
import { readC07ProgressEvidence } from "../services/heartbeat-progress-evidence.js";
import { computeConsecutiveNoProgress } from "../services/heartbeat-no-progress.js";
import { resolveNoProgressAutoBlockThreshold } from "../services/heartbeat-stability.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })), runningProcesses: new Map(),
}));
import { heartbeatService } from "../services/heartbeat.js";
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Skipping heartbeat C07 tests: " + (support.reason ?? "unsupported environment"));
type Db = ReturnType<typeof createDb>;
type Issue = typeof issues.$inferSelect;
type AdapterInput = { runId: string; context: Record<string, unknown>; onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> };
const policy = { version: 1 as const, idleTimeoutMs: 2500, maxDurationMs: 10_000, stages: [{ key: "copy", unit: "items" as const }] };

async function waitForIssueRow(fetch: () => Promise<Issue | null>, predicate: (row: Issue | null) => boolean) {
  const deadline = Date.now() + 5_000;
  let row = await fetch();
  while (!predicate(row) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25)); row = await fetch();
  }
  return row;
}
async function emitLargeOutput(input: Pick<AdapterInput, "onLog">, chunks: number) {
  for (let i = 0; i < chunks; i += 1) await input.onLog?.("stdout", "x".repeat(20_000) + "\n");
  return successfulAdapterResult();
}
describeDb("heartbeat C07 log and no-progress preservation", () => {
  let db: Db, tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-c07-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterEach(async () => { executeSpy.mockReset(); vi.unstubAllEnvs(); await new Promise(resolve => setTimeout(resolve, 150)); });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  async function seedC07Fixture(adapterConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Run Stability", issuePrefix: "RST" + companyId.replace(/-/g, "").toUpperCase(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Run Stability Agent", role: "engineer", status: "active", adapterType: "opencode_local", adapterConfig, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, identifier: "RST-" + companyId.slice(0, 4).toUpperCase(), title: "Run stability issue", status: "todo", assigneeAgentId: agentId });
    const heartbeat = heartbeatService(db), scope = and(eq(issues.id, issueId), eq(issues.companyId, companyId));
    return { companyId, agentId, issueId,
      async invoke(withIssue = false) {
        const run = await heartbeat.invoke(agentId, "on_demand", withIssue ? { issueId, taskKey: "issue:" + issueId } : {}, "manual", { actorId: "test-suite", actorType: "system" });
        if (!run) throw new Error("Expected heartbeat run");
        return { run, final: await waitForRunTerminal(heartbeat, run.id) };
      },
      async reopenIssue() { await db.update(issues).set({ status: "in_progress", completedAt: null }).where(scope); },
      async linkIssue(runId: string) { await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(scope); },
      waitForIssue(status: string) { return waitForIssueRow(() => db.select().from(issues).where(eq(issues.id, issueId)).then(rows => rows[0] ?? null), row => row?.status === status); },
    };
  }
  type Fixture = Awaited<ReturnType<typeof seedC07Fixture>>;
  async function workflow(f: Fixture) {
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, name: "C07", stepsJson: [] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: f.companyId, workflowId: definition.id, status: "running", triggeredBy: "test" }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "write", issueId: f.issueId, status: "running", executionGeneration: 4 }).returning();
    const admit = async () => {
      const heartbeatId = randomUUID();
      await admittedProducer(db, { ...f, stepRunId: step.id, heartbeatId, status: "running" });
      return heartbeatId;
    };
    return { run, step, admit };
  }
  async function toolAdvance(f: Fixture, runId: string, workflowRunId?: string, stepId?: string) {
    const [tool] = await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "copy-" + randomUUID(), adapterType: "builtin" }).returning();
    const store = createToolProgressStore(db), scope = { companyId: f.companyId, toolId: tool.id, requestId: randomUUID(), adapterType: "builtin" as const, workflowRunId, stepId };
    const execution = await store.start(scope, policy);
    const event = { version: 1 as const, executionId: execution.id, sequence: 1, stage: "copy", unit: "items" as const, current: 1 };
    const context = { scope, agentId: f.agentId, actor: { type: "agent" as const, source: "agent_jwt" as const, companyId: f.companyId, agentId: f.agentId, runId }, targetRunId: runId };
    expect(await store.acceptLocal(f.companyId, execution.id, { ...event, current: 0 }, context)).toEqual({ accepted: false, reason: "no_progress" });
    expect(await store.acceptLocal(f.companyId, execution.id, event, context)).toEqual({ accepted: true });
    expect(await store.acceptLocal(f.companyId, execution.id, event, context)).toEqual({ accepted: false, reason: "no_progress" });
    return { store, execution, event, context };
  }
  it("finishes large output while storing only complete records within the cap", async () => {
    const { invoke } = await seedC07Fixture({ runawayLogLimitBytes: 60_000 });
    executeSpy.mockImplementation((input: AdapterInput) => emitLargeOutput(input, 5));
    const { run, final } = await invoke();
    expect(final.status).toBe("succeeded"); expect(final.errorCode).toBeNull();
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    const summaries = events.filter(event => event.eventType === "log_storage_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload).toMatchObject({ version: 1, storageLimitBytes: 60_000, storedRecords: 3, omittedRecords: 3, writeErrors: 0 });
    expect(final.logStore).toBe("local_file"); expect(final.logRef).toBeTruthy();
    const stored = await getRunLogStore().read({ store: "local_file", logRef: final.logRef! });
    const records = stored.content.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(records[0].chunk).toContain("[paperclip] No project or prior session workspace was available.");
    expect(records.slice(1).map(record => record.chunk)).toEqual(Array(2).fill("x".repeat(20_000) + "\n"));
    expect(final.logBytes).toBe(Buffer.byteLength(stored.content)); expect(final.logBytes).toBeLessThanOrEqual(60_000);
    expect(final.logSha256).toBe(createHash("sha256").update(stored.content).digest("hex"));
    expect(summaries[0].payload).toMatchObject({ storedBytes: final.logBytes, actualBytes: final.logBytes, sha256: final.logSha256 });
  });
  it("does not emit log-volume advisory or termination events", async () => {
    const { invoke } = await seedC07Fixture({ runawayLogLimitBytes: 100_000 });
    executeSpy.mockImplementation((input: AdapterInput) => emitLargeOutput(input, 6));
    const { run, final } = await invoke();
    expect(final.status).toBe("succeeded"); expect(final.errorCode).toBeNull();
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    expect(events.some(event => (event.message ?? "").includes("Runaway advisory") || (event.message ?? "").includes("Runaway log guard"))).toBe(false);
  });
  it("does not inject a runaway recovery brief after a storage-capped successful run", async () => {
    const { invoke, reopenIssue } = await seedC07Fixture({ runawayLogLimitBytes: 60_000 });
    const contexts: Array<Record<string, unknown>> = [];
    executeSpy.mockImplementation(async (input: AdapterInput) => { contexts.push(input.context); return contexts.length === 1 ? emitLargeOutput(input, 5) : successfulAdapterResult(); });
    const first = await invoke(true);
    expect(first.final.status).toBe("succeeded"); expect(first.final.errorCode).toBeNull();
    await reopenIssue();
    const second = await invoke(true);
    expect(second.final.status).toBe("succeeded"); expect(contexts).toHaveLength(2);
    expect(contexts.every(context => context.paperclipRunawayRecoveryBrief === undefined)).toBe(true);
  });
  it("no-progress ladder: advisory at N, recovery brief on next wake, honest auto-block at K", async () => {
    const f = await seedC07Fixture(), contexts: Array<Record<string, unknown>> = [];
    await f.reopenIssue();
    executeSpy.mockImplementation(async (input: AdapterInput) => {
      contexts.push(input.context); await f.linkIssue(input.runId);
      // C07: changed prose, an unmeasured product and arbitrary transitions must not reset N/K.
      await input.onLog?.("stdout", "completed item " + contexts.length + "\n");
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, body: "status: partial deliverable registered " + contexts.length });
      await db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: f.issueId, createdByRunId: input.runId, provider: "github", type: "document", status: "active", title: "unmeasured" });
      await db.insert(workflowTransitionEvents).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: input.runId, eventType: "step_completed", layer: "test" });
      return successfulAdapterResult();
    });
    const invokeOnIssue = async () => { const execution = await f.invoke(true); expect(execution.final.status).toBe("succeeded"); return execution; };
    const first = await invokeOnIssue();
    expect((await f.waitForIssue("done"))?.status).toBe("done");
    const firstEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, first.run.id));
    expect(firstEvents.some(event => (event.message ?? "").includes("No-progress advisory"))).toBe(false);
    expect(contexts[0]?.paperclipNoProgressRecoveryBrief).toBeUndefined(); await f.reopenIssue();
    const second = await invokeOnIssue();
    expect((await f.waitForIssue("done"))?.status).toBe("done");
    const secondEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, second.run.id));
    const advisory = secondEvents.find(event => (event.message ?? "").includes("No-progress advisory"));
    expect(advisory).toBeTruthy(); expect(advisory?.level).toBe("warn"); await f.reopenIssue();
    await invokeOnIssue();
    expect(contexts[2]?.paperclipNoProgressRecoveryBrief).toMatchObject({ kind: "no_progress_recovery", consecutiveCount: 2, lastRunId: second.run.id });
    const blockedIssue = await f.waitForIssue("blocked");
    expect(blockedIssue?.status).toBe("blocked"); expect(blockedIssue?.executionRunId).toBeNull();
    const [blockActivity] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.no_progress_auto_blocked")));
    expect(blockActivity).toBeTruthy();
    expect(blockActivity?.details?.consecutiveNoProgress).toBe(3); expect(blockActivity?.details?.reason).toBe("consecutive_no_progress");
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments.map(row => row.body).join("\n")).toContain("연속 무진행 실행");
  });
  it("no-progress ladder: structured evidence in the run resets the chain and the issue completes normally", async () => {
    const f = await seedC07Fixture(); let calls = 0;
    await f.reopenIssue();
    executeSpy.mockImplementation(async (input: AdapterInput) => {
      calls += 1; await f.linkIssue(input.runId);
      // C07 plan: third-run comment used to reset the chain; only an official advance now does.
      if (calls >= 3) { const t = await toolAdvance(f, input.runId); await t.store.finish(f.companyId, t.execution.id, "succeeded"); }
      return successfulAdapterResult();
    });
    for (let i = 0; i < 3; i += 1) { expect((await f.invoke(true)).final.status).toBe("succeeded"); if (i < 2) await f.reopenIssue(); }
    expect((await f.waitForIssue("done"))?.status).toBe("done");
    const blocks = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.no_progress_auto_blocked")));
    expect(blocks).toHaveLength(0);
  });
  it("deduplicates official advances across rereads, retains old attempts and rejects conflicting attribution", async () => {
    const f = await seedC07Fixture(), w = await workflow(f), runId = await w.admit();
    const t = await toolAdvance(f, runId, w.run.id, w.step.stepId), input = { ...f, runIds: [runId] };
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, t.execution.id), eq(activityLog.action, "tool_progress.advanced")));
    const { id: _id, createdAt: _createdAt, ...duplicate } = audit;
    await db.insert(activityLog).values(duplicate);
    const first = await readC07ProgressEvidence(db, input);
    expect(first.byRun.get(runId)).toHaveLength(1);
    expect(first.byRun.get(runId)?.[0]).toMatchObject({ runId, workflowAttempt: { executionGeneration: 4, retryCount: 0, iterationIndex: 0 } });
    await db.update(workflowStepRuns).set({ executionGeneration: 5, retryCount: 1, iterationIndex: 1 }).where(eq(workflowStepRuns.id, w.step.id));
    await expect(t.store.acceptLocal(f.companyId, t.execution.id, { ...t.event, sequence: 2, current: 2 }, t.context)).rejects.toMatchObject({ reason: "tool_progress_scope_replaced" });
    const reader = createDb(tempDb.connectionString);
    try { expect(await readC07ProgressEvidence(reader, input)).toEqual(first); } finally { await reader.$client.end({ timeout: 5 }); }
    const otherRunId = await w.admit();
    await db.insert(activityLog).values({ ...duplicate, runId: otherRunId });
    const conflict = await readC07ProgressEvidence(db, input);
    expect(conflict.byRun.has(runId)).toBe(false);
    expect(conflict.rejected).toHaveLength(3); expect(conflict.rejected.every(row => row.reason === "conflicting_attribution")).toBe(true);
  });
  it.each(["company", "agent", "wake", "attempt", "request"])("rejects a forged official-record binding: %s", async field => {
    const f = await seedC07Fixture(), w = await workflow(f), runId = await w.admit();
    const t = await toolAdvance(f, runId, w.run.id, w.step.stepId);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, t.execution.id), eq(activityLog.action, "tool_progress.advanced")));
    const e = { ...audit.details!.progressEvidence as Record<string, unknown> };
    if (field === "company") e.companyId = randomUUID();
    if (field === "agent") e.agentId = randomUUID();
    if (field === "wake") e.wakeupRequestId = randomUUID();
    if (field === "request") e.requestId = randomUUID();
    if (field === "attempt") e.workflowAttempt = { ...e.workflowAttempt as Record<string, unknown>, retryCount: 8 };
    await db.update(activityLog).set({ details: { ...audit.details, progressEvidence: e } }).where(eq(activityLog.id, audit.id));
    const result = await readC07ProgressEvidence(db, { ...f, runIds: [runId] });
    expect(result.byRun.has(runId)).toBe(false); expect(result.rejected).toEqual([{ activityId: audit.id, reason: "invalid_progress_evidence" }]);
  });
  it("uses measured creation/change, excludes identical or unknown previous bytes, and preserves historical attribution", async () => {
    const f = await seedC07Fixture(), w = await workflow(f), firstId = await w.admit();
    const dir = await mkdtemp(path.join(os.tmpdir(), "heartbeat-c07-")), file = path.join(dir, "output.bin"), svc = workProductService(db);
    try {
      await writeFile(file, "abc");
      const product = await svc.createForIssue(f.issueId, f.companyId, { provider: "local_file", type: "document", status: "active", title: "output.bin", createdByRunId: firstId, metadata: { path: file } });
      const read = (runIds: string[]) => readC07ProgressEvidence(db, { ...f, runIds });
      expect((await read([firstId])).byRun.get(firstId)).toHaveLength(1);
      await db.update(workflowStepRuns).set({ iterationIndex: 1 }).where(eq(workflowStepRuns.id, w.step.id));
      const nextId = await w.admit();
      await svc.restampProducer(product!.id, nextId, {});
      expect((await read([nextId])).byRun.has(nextId)).toBe(false);
      await writeFile(file, "changed");
      await svc.restampProducer(product!.id, nextId, {});
      const before = await read([firstId, nextId]);
      expect(before.byRun.get(nextId)).toHaveLength(1); expect(before.byRun.get(firstId)).toHaveLength(1);
      await db.update(workflowStepRuns).set({ iterationIndex: 2 }).where(eq(workflowStepRuns.id, w.step.id));
      const unknownId = await w.admit(), stored = await svc.getById(product!.id);
      const { sha256: _hash, byteSize: _size, ...legacy } = stored!.metadata!.workflowProducer as Record<string, unknown>;
      await db.update(issueWorkProducts).set({ metadata: { path: file, workflowProducer: legacy } }).where(eq(issueWorkProducts.id, product!.id));
      await writeFile(file, "changed again"); await svc.restampProducer(product!.id, unknownId, {});
      expect((await read([unknownId])).byRun.has(unknownId)).toBe(false);
      // Even a positive flag cannot turn unknown old bytes into a measured change.
      const [unknownAudit] = await db.select().from(activityLog).where(and(eq(activityLog.runId, unknownId), eq(activityLog.action, "issue.work_product_progress_accepted")));
      await db.update(activityLog).set({ details: { ...unknownAudit.details, progressEvidence: { ...unknownAudit.details!.progressEvidence as Record<string, unknown>, contentChanged: true } } }).where(eq(activityLog.id, unknownAudit.id));
      expect((await read([unknownId])).byRun.has(unknownId)).toBe(false);
      await db.transaction(async tx => {
        await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, unknownId));
        expect((await computeConsecutiveNoProgress(tx, f))?.count).toBe(1);
      });
      await db.update(workflowStepRuns).set({ executionGeneration: 5 }).where(eq(workflowStepRuns.id, w.step.id));
      expect(await read([firstId, nextId])).toEqual(before);
      await expect(svc.restampProducer(product!.id, unknownId, {})).rejects.toThrow("workproduct_producer_stale_generation");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps six hours, twenty successes even at K=21, 0-disable and no cumulative elapsed-time cap", async () => {
    const f = await seedC07Fixture(), now = new Date(), old = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seed = (createdAt: Date, elapsed = 600) => db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "succeeded", createdAt, startedAt: createdAt, finishedAt: new Date(createdAt.getTime() + elapsed), sessionIdAfter: randomUUID() });
    await seed(old); await seed(old);
    executeSpy.mockImplementation(async (input: AdapterInput) => { await f.linkIssue(input.runId); return successfulAdapterResult(); });
    await f.reopenIssue(); expect((await f.invoke(true)).final.status).toBe("succeeded");
    expect((await computeConsecutiveNoProgress(db, f))?.count).toBe(1); await f.waitForIssue("done");
    // Two finished 0.6T records (T=1000ms) are still two runs; this reader creates no duration budget.
    const pair = await seedC07Fixture(); const start = new Date(now.getTime() - 2000);
    await db.insert(heartbeatRuns).values([0, 1000].map(offset => ({ companyId: pair.companyId, agentId: pair.agentId, issueId: pair.issueId, status: "succeeded", createdAt: new Date(start.getTime() + offset), startedAt: new Date(start.getTime() + offset), finishedAt: new Date(start.getTime() + offset + 600) })));
    expect((await computeConsecutiveNoProgress(db, pair))?.count).toBe(2);
    for (let i = 0; i < 25; i += 1) await seed(new Date(now.getTime() - 10_000 - i));
    vi.stubEnv("PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD", "21");
    expect(resolveNoProgressAutoBlockThreshold()).toBe(21);
    await f.reopenIssue(); expect((await f.invoke(true)).final.status).toBe("succeeded");
    expect((await f.waitForIssue("done"))?.status).toBe("done");
    expect(await computeConsecutiveNoProgress(db, f)).toMatchObject({ count: 20, runsInspected: 20 });
    vi.stubEnv("PAPERCLIP_NO_PROGRESS_WINDOW_SEC", "0");
    expect(await computeConsecutiveNoProgress(db, f)).toBeNull();
    vi.stubEnv("PAPERCLIP_NO_PROGRESS_WINDOW_SEC", "21600"); vi.stubEnv("PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD", "0");
    const contexts: Array<Record<string, unknown>> = [];
    executeSpy.mockImplementation(async (input: AdapterInput) => { contexts.push(input.context); await f.linkIssue(input.runId); return successfulAdapterResult(); });
    await f.reopenIssue(); expect((await f.invoke(true)).final.status).toBe("succeeded");
    expect((await f.waitForIssue("done"))?.status).toBe("done"); expect(contexts[0].paperclipNoProgressRecoveryBrief).toBeUndefined();
    vi.stubEnv("PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD", "2"); vi.stubEnv("PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD", "0");
    await f.reopenIssue(); expect((await f.invoke(true)).final.status).toBe("succeeded");
    expect((await f.waitForIssue("done"))?.status).toBe("done");
    expect(contexts[1].paperclipNoProgressRecoveryBrief).toMatchObject({ consecutiveCount: 20, autoBlockThreshold: 0 });
  });
});
