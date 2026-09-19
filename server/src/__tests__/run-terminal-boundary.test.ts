// [purpose] run-terminal-boundary v1 통합 테스트 — 원인 스탬프 종결, 회복 채널 게이트,
//   CAS/유니크 계약, legacy 혼합 버전 규칙, outbox 실행기·재처리를 임베디드 PG 로 검증한다.
//   코어 모듈은 플래그를 읽지 않으므로 대부분의 테스트가 finalizeRunTerminal 을 직접 호출한다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionAgentRuntimes,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  hoursFromNow,
  retryMetadata,
  seedBoundaryWorld,
  seedHeartbeatRun,
  seedLinkedWakeupRequest,
  seedMissionRuntime,
  seedUnblockIssue,
  stepRunsOf,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import {
  executeTerminalEffectIntents,
  finalizeRunTerminal,
  processPendingTerminalEffectIntents,
  validateTerminalCause,
  type FinalizeRunTerminalInput,
} from "../services/workflow/run-terminal-boundary.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-terminal-boundary tests: ${support.reason ?? "unsupported host"}`);
}

const FAILED_CAUSE = { policy: "budget_hard_stop", discovery: "engine_failure", origin: "reconciler", reason: "budget incident" } as const;
const CANCELLED_CAUSE = { policy: "operator_cancel", discovery: "engine_failure", origin: "reconciler" } as const;

function failedInput(world: BoundaryWorld, overrides?: Partial<FinalizeRunTerminalInput>): FinalizeRunTerminalInput {
  return {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "defer_on_open_recovery",
    now: new Date(), stepRuns: stepRunsOf(world), ...overrides,
  };
}

function cancelledInput(world: BoundaryWorld, overrides?: Partial<FinalizeRunTerminalInput>): FinalizeRunTerminalInput {
  return {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "cancelled", cause: { ...CANCELLED_CAUSE }, gatePolicy: "immediate",
    now: new Date(), stepRuns: stepRunsOf(world), ...overrides,
  };
}

async function decisionRows(db: ReturnType<typeof createDb>, runId: string) {
  return await db.select().from(workflowTerminalDecisions)
    .where(eq(workflowTerminalDecisions.workflowRunId, runId));
}

describeEP("run-terminal-boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-terminal-boundary-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("clear gate: failed finalize writes run + cause-stamped decision", async () => {
    const w = await seedBoundaryWorld(db);
    const result = await finalizeRunTerminal(db, failedInput(w));
    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") return;
    expect(result.decision).toBe("failed");
    expect(result.effectIntentCount).toBe(0);
    expect(result.run.status).toBe("failed");
    expect(result.run.completedAt).not.toBeNull();
    const [decision] = await decisionRows(db, w.runId);
    expect(decision!.id).toBe(result.decisionId);
    expect(decision!.policyCause).toBe("budget_hard_stop");
    expect(decision!.discoveryPath).toBe("engine_failure");
    expect(decision!.origin).toBe("reconciler");
    expect(decision!.recoveryGate).toMatchObject({ kind: "clear" });
  });

  it("open unblock channel defers failed finalize and touches nothing", async () => {
    const w = await seedBoundaryWorld(db, { stepRunMetadata: { note: "keep" } });
    const unblockId = await seedUnblockIssue(db, w);
    const result = await finalizeRunTerminal(db, failedInput(w));
    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") return;
    expect(result.gateKind).toBe("open");
    expect(result.evidence?.[0]).toMatchObject({ channel: "unblock_owner_action", targetId: unblockId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    expect(run!.status).toBe("running");
    expect(await decisionRows(db, w.runId)).toHaveLength(0);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.stepRunId));
    expect(stepRun!.metadata).toEqual({ note: "keep" });
  });

  it("stale unblock is superseded by the executor, not treated as an open channel", async () => {
    const w = await seedBoundaryWorld(db, { stepIssueStatus: "done" });
    const unblockId = await seedUnblockIssue(db, w);
    const result = await finalizeRunTerminal(db, failedInput(w));
    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") return;
    expect(result.effectIntentCount).toBe(1);
    const [decision] = await decisionRows(db, w.runId);
    expect(decision!.capturedStopTargets.supersededUnblockIssueIds).toEqual([unblockId]);
    expect(await executeTerminalEffectIntents(db, result.decisionId)).toEqual({ executed: 1, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, unblockId));
    expect(issue!.status).toBe("cancelled");
    expect(issue!.cancelledAt).not.toBeNull();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, unblockId));
    expect(comments.some((c) => c.body.includes(result.decisionId) && /superseded/i.test(c.body))).toBe(true);
  });

  it("valid retry reservation defers; exhausted retry clears", async () => {
    const liveMeta = retryMetadata("waiting", 1, 3, hoursFromNow(1));
    const w1 = await seedBoundaryWorld(db, { stepRunMetadata: liveMeta });
    const deferred = await finalizeRunTerminal(db, failedInput(w1, { stepRuns: stepRunsOf(w1, liveMeta) }));
    expect(deferred.kind).toBe("deferred");
    if (deferred.kind === "deferred") {
      expect(deferred.evidence?.[0]).toMatchObject({ channel: "retry_reservation", targetId: w1.stepRunId });
    }
    const deadMeta = retryMetadata("waiting", 4, 3, hoursFromNow(1));
    const w2 = await seedBoundaryWorld(db, { stepRunMetadata: deadMeta });
    expect((await finalizeRunTerminal(db, failedInput(w2, { stepRuns: stepRunsOf(w2, deadMeta) }))).kind).toBe("finalized");
  });

  it("active heartbeat defers; settled outcome or trigger self-exclusion clears", async () => {
    const w1 = await seedBoundaryWorld(db);
    const hb1 = await seedHeartbeatRun(db, w1);
    const deferred = await finalizeRunTerminal(db, failedInput(w1));
    expect(deferred.kind).toBe("deferred");
    if (deferred.kind === "deferred") {
      expect(deferred.evidence?.[0]).toMatchObject({ channel: "active_heartbeat", targetId: hb1 });
    }
    const w2 = await seedBoundaryWorld(db);
    await seedHeartbeatRun(db, w2, { terminalOutcome: "completed" });
    expect((await finalizeRunTerminal(db, failedInput(w2))).kind).toBe("finalized");
    const w3 = await seedBoundaryWorld(db);
    const hb3 = await seedHeartbeatRun(db, w3);
    expect((await finalizeRunTerminal(db, failedInput(w3, { triggerHeartbeatRunId: hb3 }))).kind).toBe("finalized");
  });

  it("stale authority version writes nothing", async () => {
    const w = await seedBoundaryWorld(db);
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, w.runId));
    const result = await finalizeRunTerminal(db, failedInput(w));
    expect(result.kind).toBe("stale_authority");
    if (result.kind !== "stale_authority") return;
    expect(result.expectedAuthorityVersion).toBe(0);
    expect(result.currentAuthorityVersion).toBe(1);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    expect(run!.status).toBe("running");
    expect(await decisionRows(db, w.runId)).toHaveLength(0);
  });

  it("same-version decision is idempotent; different decision conflicts", async () => {
    const w = await seedBoundaryWorld(db, { runStatus: "failed" });
    const [seeded] = await db.insert(workflowTerminalDecisions).values({
      companyId: w.companyId, workflowRunId: w.runId, decidedAuthorityVersion: 0, decision: "failed",
      policyCause: "budget_hard_stop", discoveryPath: "engine_failure", origin: "reconciler",
    }).returning();
    const same = await finalizeRunTerminal(db, failedInput(w));
    expect(same.kind).toBe("already_finalized");
    if (same.kind === "already_finalized") {
      expect(same.existingDecision).toEqual({ id: seeded!.id, decision: "failed" });
    }
    await expect(finalizeRunTerminal(db, cancelledInput(w))).rejects.toThrow("terminal decision conflict");
  });

  it("legacy terminal row reports already_finalized without fabricating a decision", async () => {
    const w = await seedBoundaryWorld(db, { runStatus: "failed" });
    const result = await finalizeRunTerminal(db, failedInput(w));
    expect(result.kind).toBe("already_finalized");
    if (result.kind === "already_finalized") {
      expect(result.currentStatus).toBe("failed");
      expect(result.existingDecision).toBeNull();
    }
    expect(await decisionRows(db, w.runId)).toHaveLength(0);
  });

  it("cancelled immediate finalizes even with an open unblock channel", async () => {
    const w = await seedBoundaryWorld(db);
    await seedUnblockIssue(db, w);
    const result = await finalizeRunTerminal(db, cancelledInput(w));
    expect(result.kind).toBe("finalized");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    expect(run!.status).toBe("cancelled");
    expect(await decisionRows(db, w.runId)).toHaveLength(1);
  });

  it("contract-breaking cause combinations throw RangeError", () => {
    expect(() => validateTerminalCause({ ...CANCELLED_CAUSE }, "failed")).toThrow(RangeError);
    expect(() => validateTerminalCause(
      { policy: "recovery_deadline_hard", discovery: "deadlock_detection", origin: "reconciler" },
      "failed",
    )).toThrow(RangeError);
  });

  it("effects executor cancels heartbeat with links and stops runtime", async () => {
    const w = await seedBoundaryWorld(db);
    const runtimeId = await seedMissionRuntime(db, w);
    const heartbeatId = await seedHeartbeatRun(db, w);
    const wakeupId = await seedLinkedWakeupRequest(db, w, heartbeatId);
    await db.update(issues).set({ checkoutRunId: heartbeatId, executionRunId: heartbeatId })
      .where(eq(issues.id, w.stepIssueId));
    const result = await finalizeRunTerminal(db, cancelledInput(w));
    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") return;
    expect(result.effectIntentCount).toBe(2);
    expect(await executeTerminalEffectIntents(db, result.decisionId)).toEqual({ executed: 2, failed: 0 });
    const [runtime] = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.id, runtimeId));
    expect(runtime!.status).toBe("stopped");
    expect(runtime!.stopReason).toBe(`terminal decision ${result.decisionId}`);
    const [hb] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatId));
    expect(hb!.status).toBe("cancelled");
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupId));
    expect(wakeup!.status).toBe("cancelled");
    const [issue] = await db.select().from(issues).where(eq(issues.id, w.stepIssueId));
    expect(issue!.checkoutRunId).toBeNull();
    expect(issue!.executionRunId).toBeNull();
    const intents = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.terminalDecisionId, result.decisionId));
    expect(intents.every((intent) => intent.status === "completed")).toBe(true);
  });

  it("failed effect stays pending and is reprocessed by processPending", async () => {
    const w = await seedBoundaryWorld(db);
    const heartbeatId = await seedHeartbeatRun(db, w);
    const result = await finalizeRunTerminal(db, cancelledInput(w));
    if (result.kind !== "finalized") throw new Error("expected finalized");
    // 실행기 실패 시뮬레이션: 대상 heartbeat 가 캡처 후 정산되어 버렸다.
    await db.update(heartbeatRuns).set({ status: "completed", terminalOutcome: "completed" })
      .where(eq(heartbeatRuns.id, heartbeatId));
    expect(await executeTerminalEffectIntents(db, result.decisionId)).toEqual({ executed: 0, failed: 1 });
    let [intent] = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.terminalDecisionId, result.decisionId));
    expect(intent!.status).toBe("pending");
    expect(intent!.attemptCount).toBe(1);
    expect(intent!.lastError).toContain("already settled");
    // 대상 복구 후 재처리(olderThanMs 0 → 방금 생성된 인텐트도 즉시 대상).
    // DB/JS 클록 정밀도 차이로 같은 ms 경계에서 밀리는 것을 막기 위해 createdAt 을 과거로 고정.
    await db.update(workflowTerminalEffectIntents)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(workflowTerminalEffectIntents.terminalDecisionId, result.decisionId));
    await db.update(heartbeatRuns).set({ status: "queued", terminalOutcome: null })
      .where(eq(heartbeatRuns.id, heartbeatId));
    expect((await processPendingTerminalEffectIntents(db, { olderThanMs: 0 })).executed).toBe(1);
    [intent] = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.terminalDecisionId, result.decisionId));
    expect(intent!.status).toBe("completed");
    expect(intent!.attemptCount).toBe(2);
    const [hb] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatId));
    expect(hb!.status).toBe("cancelled");
  });

  it("attempts-exhausted intents are failed without execution", async () => {
    const w = await seedBoundaryWorld(db);
    const result = await finalizeRunTerminal(db, failedInput(w));
    if (result.kind !== "finalized") throw new Error("expected finalized");
    await db.insert(workflowTerminalEffectIntents).values({
      companyId: w.companyId, terminalDecisionId: result.decisionId,
      effectKind: "cancel_heartbeat_run", targetId: randomUUID(), attemptCount: 5,
      // DB/JS 클록 경계 flake 방지 — cutoff(now - 0) 보다 확실히 과거로 삽입.
      createdAt: new Date(Date.now() - 120_000),
    });
    const processed = await processPendingTerminalEffectIntents(db, { olderThanMs: 0 });
    expect(processed.executed).toBe(0);
    expect(processed.skipped).toBe(1);
    const [intent] = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.terminalDecisionId, result.decisionId));
    expect(intent!.status).toBe("failed");
    expect(intent!.lastError).toBe("attempts exhausted");
  });
});
