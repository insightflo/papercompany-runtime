// server/src/__tests__/source-issue-cap-override-race.test.ts
//
// [목적] cap-override lease/authority/shape 계약과 production heartbeat queue ordering 검증.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { dispatchCapOverrideWake } from "../services/workflow/source-issue-cap-override-dispatch.js";
import { isCapOverrideWakeUniqueConflict } from "../services/workflow/cap-override-wakeup-conflict.js";
import {
  buildCapOverrideAuditPayload, capOwnerAction, drainHeartbeatRuns, FORWARD_APPLIED_AT, MAX_ITER, PRODUCER,
  reloadRun, reloadStepRun, seedCapExhaustedRun, startCapOverrideTestDb, testWake, type SeedOpts,
} from "./helpers/cap-override-fixtures.js";

function successfulAdapterResult() {
  return {
    exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null,
    provider: "test", model: "test-model", resultJson: null, runtimeServices: [],
  };
}

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip cap-override race tests: ${support.reason ?? "unsupported host"}`);

describeEP("cap-override shared lease/wake race + authority/shape proof", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  async function seedPending(overrides: Record<string, unknown> = {}, seedOverrides: SeedOpts = {}) {
    const s = await seedCapExhaustedRun(db, seedOverrides);
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: MAX_ITER + 1, startedAt: null, completedAt: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null, metadata: {} }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    const payload = buildCapOverrideAuditPayload(s, overrides);
    const [audit] = await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:${s.decisionCommentId}`, payload }).returning({ id: workflowTransitionEvents.id });
    return { s, auditId: audit!.id, payload };
  }

  const call = (s: Awaited<ReturnType<typeof seedCapExhaustedRun>>, wakeFn = testWake(db), overrides: Partial<{ issueId: string; ownerActionIssueId: string; missionId: string }> = {}) => dispatchSourceIssueNativeResume(db, {
    companyId: s.companyId, issueId: overrides.issueId ?? s.producerIssueId, allowBlockedIssue: true,
    ownerAction: { ownerActionIssueId: overrides.ownerActionIssueId ?? s.ownerActionIssueId, missionId: overrides.missionId ?? s.missionId, decisionCommentId: s.decisionCommentId },
    wakeFn,
  });
  const callProduction = (s: Awaited<ReturnType<typeof seedCapExhaustedRun>>) => dispatchSourceIssueNativeResume(db, {
    companyId: s.companyId,
    issueId: s.producerIssueId,
    allowBlockedIssue: true,
    ownerAction: capOwnerAction(s),
  });

  async function exactWakes(s: Awaited<ReturnType<typeof seedCapExhaustedRun>>) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.decisionCommentId}`), eq(agentWakeupRequests.requestKind, "workflow_resume"), eq(agentWakeupRequests.workflowRunId, s.workflowRunId), eq(agentWakeupRequests.workflowStepRunId, s.producerStepRunId), eq(agentWakeupRequests.issueId, s.producerIssueId)));
  }

  async function expectAuthorityRollback(s: Awaited<ReturnType<typeof seedCapExhaustedRun>>, reason: string) {
    expect(await reloadRun(db, s.workflowRunId)).toEqual(expect.objectContaining({ status: "failed" }));
    expect(await reloadStepRun(db, s.workflowRunId, PRODUCER)).toEqual(expect.objectContaining({ status: "completed", iterationIndex: MAX_ITER }));
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    expect(issue).toEqual(expect.objectContaining({ status: "done" }));
    expect(issue!.completedAt).not.toBeNull();
    expect(await exactWakes(s)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, s.producerIssueId), inArray(heartbeatRuns.status, ["queued", "running"])))).toHaveLength(0);
    const [audit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, `cap-override:${s.decisionCommentId}`));
    expect(audit!.payload).toEqual(expect.objectContaining({ status: "rolled_back", rollbackReason: reason }));
  }

  it("A race: fresh caller claimed before recovery caller → exactly one queue/accepted", async () => {
    const s = await seedCapExhaustedRun(db);
    let wakeCalls = 0;
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const wake = async (input: Parameters<ReturnType<typeof testWake>>[0]) => { wakeCalls += 1; enter(); await gate; return testWake(db)(input); };
    const fresh = call(s, wake);
    await entered; // fresh owns the fenced transaction while its wake is stalled.
    const recoveryPromise = call(s, wake);
    release();
    const [freshResult, recovery] = await Promise.all([fresh, recoveryPromise]);
    expect(freshResult.kind).toBe("cap_override_applied");
    expect(recovery.kind).not.toBe("cap_override_applied");
    expect(wakeCalls).toBe(1);
    expect(await exactWakes(s)).toHaveLength(1);
  });

  it("stale dispatching takeover race: exact observed token+epoch+startedAt CAS permits exactly one queue/accepted", async () => {
    const { s } = await seedPending({ status: "dispatching", dispatchToken: "stale-token", dispatchEpoch: 7, dispatchStartedAt: "2020-01-01T00:00:00.000Z" });
    let wakeCalls = 0;
    const wake = async (input: Parameters<ReturnType<typeof testWake>>[0]) => { wakeCalls += 1; return testWake(db)(input); };
    const results = await Promise.all([call(s, wake), call(s, wake)]);
    expect(results.filter((r) => r.kind === "cap_override_applied")).toHaveLength(1);
    expect(wakeCalls).toBe(1);
    expect(await exactWakes(s)).toHaveLength(1);
  });

  it("B/sup1: forged accepted payload without matching exact wake row is NOT already_applied", async () => {
    const { s } = await seedPending({ status: "accepted", acceptedWakeupRequestId: randomUUID() });
    const result = await call(s);
    expect(result.kind).toBe("report_only");
    expect(await exactWakes(s)).toHaveLength(0);
  });

  it("B/sup1: same key/wakeId but wrong requestKind is not accepted proof", async () => {
    const wakeId = randomUUID();
    const { s } = await seedPending({ status: "accepted", acceptedWakeupRequestId: wakeId });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.producerAgentId, source: "test", status: "queued", requestKind: "other", workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, idempotencyKey: `cap-override-wake:${s.decisionCommentId}` });
    expect((await call(s)).kind).toBe("report_only");
  });

  it("C: stale post-forward metadata shape forbids wake and releases recovery lease to pending", async () => {
    const { s } = await seedPending();
    await db.update(workflowStepRuns).set({ metadata: { race: true } }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    let wakeCalls = 0;
    const result = await call(s, async () => { wakeCalls += 1; return true; });
    expect(result.kind).toBe("report_only");
    expect(wakeCalls).toBe(0);
    const [audit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, `cap-override:${s.decisionCommentId}`));
    expect((audit!.payload as Record<string, unknown>).status).toBe("pending");
  });

  it("newer replan after pending audit atomically restores the prior non-runnable state", async () => {
    const { s } = await seedPending({}, { producerIssueStatus: "done" });
    await db.insert(issueComments).values({ companyId: s.companyId, issueId: s.ownerActionIssueId, authorAgentId: s.ownerAgentId, createdAt: new Date("2026-07-10T00:40:00.000Z"), body: `### Mission owner decision\nDecision: replan_mission\nSource issue: ${s.producerIssueId}\nReason: supersede retry.` });
    let wakeCalls = 0;
    const result = await call(s, async () => { wakeCalls += 1; return true; });
    expect(result.kind).toBe("report_only");
    expect(wakeCalls).toBe(0);
    await expectAuthorityRollback(s, "decision_revalidation_failed");
  });

  it("mission owner change after pending audit rejects stale authority and restores all producer state", async () => {
    const { s } = await seedPending({}, { producerIssueStatus: "done" });
    await db.update(missions).set({ ownerAgentId: s.qaAgentId }).where(and(eq(missions.id, s.missionId), eq(missions.companyId, s.companyId)));
    let wakeCalls = 0;
    const result = await call(s, async () => { wakeCalls += 1; return true; });
    expect(result.kind).toBe("report_only");
    expect(wakeCalls).toBe(0);
    await expectAuthorityRollback(s, "current_authority_invalid");
  });

  it("identity fail-closed: wrong issue / owner action / mission never wake", async () => {
    const cases = [
      { issueId: randomUUID() },
      { ownerActionIssueId: randomUUID() },
      { missionId: randomUUID() },
    ];
    for (const overrides of cases) {
      const { s } = await seedPending();
      let wakeCalls = 0;
      const result = await call(s, async () => { wakeCalls += 1; return true; }, overrides);
      expect(result.kind).toBe("report_only");
      expect(wakeCalls).toBe(0);
    }
  });

  it("production stale A/B queues one committed wake/run and only then starts execution", async () => {
    const { s, auditId, payload } = await seedPending();
    executeSpy.mockReset();
    let claimed!: () => void;
    let resume!: () => void;
    let executed!: () => void;
    const claimObserved = new Promise<void>((resolve) => { claimed = resolve; });
    const resumeA = new Promise<void>((resolve) => { resume = resolve; });
    const executionObserved = new Promise<void>((resolve) => { executed = resolve; });
    let executionState: { wakeCount: number; runCount: number; auditStatus: unknown } | null = null;
    executeSpy.mockImplementation(async () => {
      if (!executionState) {
        const wakes = await exactWakes(s);
        const runs = wakes[0]
          ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakes[0].id))
          : [];
        const [audit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, auditId));
        executionState = {
          wakeCount: wakes.length,
          runCount: runs.length,
          auditStatus: (audit!.payload as Record<string, unknown>).status,
        };
        executed();
      }
      return { ...successfulAdapterResult(), exitCode: 1, errorMessage: "intentional production-path stop" };
    });
    const first = dispatchCapOverrideWake(db, {
      companyId: s.companyId, auditId, auditIdempotencyKey: `cap-override:${s.decisionCommentId}`,
      payload, wakeKey: `cap-override-wake:${s.decisionCommentId}`,
      allowBlockedIssue: true, mode: "recover",
      afterClaim: async () => { claimed(); await resumeA; },
    });
    await claimObserved;
    expect(executeSpy).not.toHaveBeenCalled();
    const [claimedAudit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, auditId));
    await db.update(workflowTransitionEvents).set({
      payload: { ...(claimedAudit!.payload as Record<string, unknown>), dispatchStartedAt: "2020-01-01T00:00:00.000Z" },
    }).where(eq(workflowTransitionEvents.id, auditId));
    const secondResult = await callProduction(s);
    await executionObserved;
    resume();
    const firstResult = await first;

    expect(executionState).toEqual(expect.objectContaining({ wakeCount: 1, runCount: 1 }));
    expect(["dispatching", "accepted"]).toContain(executionState!.auditStatus);
    expect([firstResult, secondResult].filter((result) => result.kind === "cap_override_applied")).toHaveLength(1);
    expect([firstResult, secondResult].filter((result) => result.kind === "cap_override_already_applied")).toHaveLength(1);
    const wakes = await exactWakes(s);
    expect(wakes).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakes[0]!.id))).toHaveLength(1);
    await drainHeartbeatRuns(db);
  });

  it("cap wake partial index rejects only the second live key", async () => {
    const s = await seedCapExhaustedRun(db);
    const idempotencyKey = `cap-override-wake:index-${randomUUID()}`;
    const insert = (status = "queued") => db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.producerAgentId, source: "test.index", status,
      requestKind: "workflow_resume", workflowRunId: s.workflowRunId,
      workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, idempotencyKey,
    });
    const results = await Promise.allSettled([insert(), insert()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && isCapOverrideWakeUniqueConflict(rejected.reason)).toBe(true);
    await insert("skipped");
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))).toHaveLength(2);
  });
  it("production rejected enqueue rolls back cap state without escaped execution", async () => {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus: "done" });
    executeSpy.mockReset();
    executeSpy.mockImplementation(async () => successfulAdapterResult());
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, s.producerAgentId));

    const result = await callProduction(s);

    expect(result).toEqual(expect.objectContaining({ kind: "report_only", reason: "cap_override_queue_rolled_back" }));
    expect(executeSpy).not.toHaveBeenCalled();
    const wakes = await exactWakes(s);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).toBe("skipped");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, s.producerIssueId))).toHaveLength(0);
    expect(await reloadRun(db, s.workflowRunId)).toEqual(expect.objectContaining({ status: "failed" }));
    expect(await reloadStepRun(db, s.workflowRunId, PRODUCER)).toEqual(expect.objectContaining({ status: "completed", iterationIndex: MAX_ITER }));
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    expect(issue).toEqual(expect.objectContaining({ status: "done" }));
    const [audit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, `cap-override:${s.decisionCommentId}`));
    expect(audit!.payload).toEqual(expect.objectContaining({ status: "rolled_back", rollbackReason: "wake_not_accepted" }));
  });
  it("missing step lookup after claim releases lease to pending", async () => {
    const missingStepRunId = randomUUID();
    const { s } = await seedPending({ producerStepRunId: missingStepRunId });
    let wakeCalls = 0;
    const result = await call(s, async () => { wakeCalls += 1; return true; });
    expect(result.kind).toBe("report_only");
    expect(wakeCalls).toBe(0);
    const [audit] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, `cap-override:${s.decisionCommentId}`));
    expect((audit!.payload as Record<string, unknown>).status).toBe("pending");
  });
});
