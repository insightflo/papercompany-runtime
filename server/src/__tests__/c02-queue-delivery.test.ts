import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { adapter, database, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { DEFERRED_WAKE_CONTEXT_KEY, heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createCommitSourceHarness, issueC02, issueNextC02, type C02Case } from "./helpers/c02-fixture.js";
import { commitDbState } from "./qa-correction-commit-fixture.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { QA_CORRECTION_WAKE_PREFIX, qaCorrectionWakeKey, readQaCorrectionWakeRef } from "../services/work-products/qa-correction-producer-attempt.js";
import { isBoundedExecutionWakeKey, isQualityWakeKey, qualityWakeKey, planQaResubmissionWakeKey,
  QA_REMEDIATION_REFIRE_WAKE_PREFIX } from "../services/quality/native-wake.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "../services/operator-decision-continuation-store.js";
import { mergeableWakeupKeyCondition, queuePausedAgentWakeupRequest } from "../services/quality/heartbeat-admission.js";

// C02 단계4의 동작 보존 시험이다. 근거: doc/DATABASE.md의 원래 요청 신원·원자 선점
// 계약과 heartbeat-producer-promotion.test.ts:8–48의 공개 queued/deferred 경로.
// helper fixture가 파일별 임시 DB를 소유한다. 외부 adapter만 대기시키고 DB·서비스·선점은 실제 실행한다.
// running/claimed는 전달·선점 증거이며 현재 입력의 QA 결과 소비 증거가 아니다.
it.each([
  { path: "queued", enabled: false },
  { path: "queued", enabled: true },
  { path: "deferred", enabled: false },
  { path: "deferred", enabled: true },
] as const)("C02 stage4 $path promotion preserves original wake, finalization=$enabled", async ({ path, enabled }) => {
  const db = database();
  await flag(enabled);
  const f = await fixture();
  const heartbeat = heartbeatService(db);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  adapter.mockReset().mockImplementation(async () => {
    await held;
    return stopped;
  });
  try {
    let busyRunId: string | null = null;
    if (path === "queued") {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    } else {
      const [owner] = await db.insert(agents).values({
        companyId: f.companyId, name: "Different owner", status: "paused",
      }).returning();
      const [busy] = await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: owner.id, issueId: f.issueId,
        status: "running", contextSnapshot: { issueId: f.issueId },
      }).returning();
      busyRunId = busy.id;
      await db.update(issues).set({
        executionRunId: busy.id, executionAgentNameKey: "different-owner", executionLockedAt: new Date(),
      }).where(eq(issues.id, f.issueId));
    }

    const context = {
      issueId: f.issueId, taskId: f.issueId,
      workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId,
      forceFreshSession: true, queueExtractionProbe: { path, enabled },
    };
    await heartbeat.wakeup(f.agentId, {
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
      // queued 승격도 기존 저장 문맥 키를 읽도록 공개 payload에 문맥을 함께 보관한다.
      payload: { ...context, [DEFERRED_WAKE_CONTEXT_KEY]: context }, contextSnapshot: context,
      requestedByActorType: "system", requestedByActorId: "c02-stage4",
      idempotencyKey: `c02-stage4:${f.issueId}`,
    });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.agentId),
    ));
    expect(wakes).toHaveLength(1);
    const original = wakes[0]!;
    expect(original).toMatchObject({
      runId: null, claimedAt: null,
      status: path === "queued" ? "queued" : "deferred_issue_execution",
      companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7,
      source: "assignment", triggerDetail: "system",
      requestedByActorType: "system", requestedByActorId: "c02-stage4",
    });
    const proof = original.payload?.__paperclipWorkflowProducerAttempt;
    expect(proof).toMatchObject({
      schemaVersion: 1, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      workflowRunId: f.workflowRunId, stepRunId: f.stepRunId, executionGeneration: 7,
      retryCount: 0, iterationIndex: 0, wakeupRequestId: original.id, parentHeartbeatRunId: null,
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();

    if (path === "queued") {
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agentId));
      await heartbeat.resumeQueuedRuns(f.agentId);
    } else {
      await heartbeat.cancelRun(busyRunId!);
    }
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    // helper 반환 대신 adapter가 대기하는 동안 DB의 실행과 원래 요청을 관측한다.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      wakeupRequestId: original.id, status: "running",
      invocationSource: "assignment", triggerDetail: "system",
      workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7,
      finalizationVersion: enabled ? 1 : 0,
      contextSnapshot: { ...context, taskKey: f.issueId, dispatchGeneration: 1 },
    });
    expect(run.startedAt).toBeInstanceOf(Date);
    const [claimedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, original.id));
    expect(claimedWake).toMatchObject({
      runId: run.id, status: "claimed", finishedAt: null,
      workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: 7,
      requestedAt: original.requestedAt, idempotencyKey: original.idempotencyKey,
      payload: { __paperclipWorkflowProducerAttempt: proof },
    });
    expect(claimedWake!.claimedAt).toBeInstanceOf(Date);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, original.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({
      executionRunId: run.id, executionAgentNameKey: "writer",
    });
    expect(issue!.executionLockedAt).toBeInstanceOf(Date);
    const starts = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.execution_started"),
    ));
    if (path === "queued") {
      expect(issue).toMatchObject({ checkoutRunId: run.id, status: "in_progress", completedAt: null, cancelledAt: null });
      expect(issue!.startedAt).toBeInstanceOf(Date);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ runId: run.id, details: { reason: "queued_wakeup_promoted" } });
    } else {
      // deferred writer는 queued writer의 상태·checkout·시작 시각 갱신을 가져오지 않는다.
      expect(issue).toMatchObject({ checkoutRunId: null, status: "todo", startedAt: null });
      expect(starts).toHaveLength(0);
      expect(await f.readRun(busyRunId!)).toMatchObject({ status: "cancelled" });
    }
  } finally {
    release();
    // 상태 관측과 실제 후처리 종료는 다르다. fixture의 DB 종료 전에 추적된 실행을 모두 기다린다.
    await waitForHeartbeatExecutionsToDrain(db, 20_000);
  }
});

// C02 stage11/C12: transport와 후보 격리만 검사한다. controlled wake는 공개 전달·현재 실행 허가의 증거가 아니다.
describe("C02 stage11 correction merge isolation", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "c02-queue-storage"));
  }, 120000);
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);

  async function stored(c: C02Case, key: string | null, payload: Record<string, unknown> | null) {
    const [origin] = await c.s.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.s.f.verdictHeartbeatId));
    const t = c.followup.target;
    const [wake] = await insertWorkflowWakeRequest(c.s.db, {
      companyId: c.ref.companyId, agentId: origin!.agentId, issueId: t.issueId, missionId: c.s.p.missionId,
      workflowRunId: c.ref.workflowRunId, workflowStepRunId: t.stepRunId,
      workflowExecutionGeneration: t.executionGeneration, source: "automation", status: "queued",
      idempotencyKey: key, payload, coalescedCount: 3,
    });
    if (!wake) throw Error("controlled stored wake required");
    return wake;
  }

  it("excludes B/C in both SQL directions and same-B merge, preserving ordinary candidates", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), c = await issueNextC02(b);
    const bKey = qaCorrectionWakeKey(b.ref), cKey = qaCorrectionWakeKey(c.ref), t = c.followup.target;
    expect(b.ref.requestId).not.toBe(c.ref.requestId);
    const generic = await stored(c, null, { original: "generic" });
    const wb = await stored(c, bKey, { qaCorrectionFollowup: b.ref });
    const wc = await stored(c, cKey, { qaCorrectionFollowup: c.ref });
    await stored(c, cKey, { original: "key-only" });
    const malformed = await stored(c, QA_CORRECTION_WAKE_PREFIX, null);
    await stored(c, "stage11:marker", { qaCorrectionFollowup: null });
    const qKey = qualityWakeKey({ actionId: c.s.p.correctionId, stepRunId: t.stepRunId, generation: 0, attempt: 1 });
    const pKey = planQaResubmissionWakeKey({ issueId: t.issueId, decisionHash: "ab".repeat(32), generation: 0, attempt: 1 });
    const q = await stored(c, qKey, null), p = await stored(c, pKey, null);
    expect(readQaCorrectionWakeRef(wb)).toEqual(b.ref);
    expect(readQaCorrectionWakeRef(wc)).toEqual(c.ref);
    expect(() => readQaCorrectionWakeRef(malformed)).toThrow("workproduct_producer_attempt_unproven");
    const candidates = async (key: string | null) => c.peer.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, c.ref.companyId), eq(agentWakeupRequests.agentId, generic.agentId),
        eq(agentWakeupRequests.issueId, t.issueId), eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.runId), mergeableWakeupKeyCondition(key),
      )).orderBy(asc(agentWakeupRequests.id)).then(rows => rows.map(row => row.id));
    // Explicit fixture IDs are the oracle; no expected list is derived from the SQL under test.
    expect(await candidates(bKey)).toEqual([]);
    expect(await candidates(cKey)).toEqual([]);
    expect(await candidates(QA_CORRECTION_WAKE_PREFIX)).toEqual([]);
    expect(await candidates(null)).toEqual([generic.id]);
    expect(await candidates("stage11:generic")).toEqual([generic.id]);
    expect(await candidates(qKey)).toEqual([]);
    expect(await candidates(pKey)).toEqual([]);
    for (const key of [bKey, cKey, QA_CORRECTION_WAKE_PREFIX]) {
      expect(isBoundedExecutionWakeKey(key)).toBe(true);
      expect(isQualityWakeKey(key)).toBe(false);
    }
    for (const key of [qKey, pKey, OPERATOR_DECISION_WAKE_PREFIX + "control", QA_REMEDIATION_REFIRE_WAKE_PREFIX + "control"]) {
      expect(isBoundedExecutionWakeKey(key)).toBe(true);
    }
    expect(isBoundedExecutionWakeKey("stage11:generic")).toBe(false);
  }, 60000);

  it("refuses paused correction keys or payload markers before querying, writing or recording", async () => {
    const b = await issueC02(owned, { mode: "content-only", quality: true }), t = b.followup.target;
    const key = qaCorrectionWakeKey(b.ref), original = await stored(b, key, { qaCorrectionFollowup: b.ref, first: true });
    await b.s.db.update(agents).set({ status: "paused" }).where(eq(agents.id, original.agentId));
    expect(readWorkflowAttemptProof(original)).toMatchObject({ retryCount: 1, iterationIndex: 2, wakeupRequestId: original.id });
    const before = await commitDbState({ ...b.s, db: b.peer });
    expect(before.wakes.find(row => row.id === original.id)).toEqual(original);
    expect(before.usage.reduce((n, row) => n + row.executionAttempts, 0)).toBe(1);
    const recordEvent = vi.fn(async () => {});
    const input = {
      companyId: b.ref.companyId, agentId: original.agentId, source: "automation", triggerDetail: "system",
      reason: "stage11", requestedByActorType: "system" as const, requestedByActorId: "c02-stage11",
      missionIdForWake: b.s.p.missionId, recordEvent,
      typedQueueColumns: { requestKind: null, issueId: t.issueId, missionId: b.s.p.missionId,
        workflowRunId: b.ref.workflowRunId, workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration },
    };
    const attempts = [
      { idempotencyKey: key, payload: { qaCorrectionFollowup: b.ref } },
      { idempotencyKey: QA_CORRECTION_WAKE_PREFIX, payload: null },
      { idempotencyKey: QA_CORRECTION_WAKE_PREFIX.slice(0, -1), payload: null },
      { idempotencyKey: null, payload: { qaCorrectionFollowup: null } },
      { idempotencyKey: "stage11:generic", payload: { qaCorrectionFollowup: false } },
      { idempotencyKey: null, payload: { qaCorrectionFollowup: undefined } },
    ];
    // Observe calls without replacing the DB or SQL; snapshots always use the independent connection.
    const select = vi.spyOn(b.s.db, "select");
    try {
      for (const attempt of attempts) {
        await expect(queuePausedAgentWakeupRequest(b.s.db, { ...input, ...attempt }))
          .rejects.toThrow("qa_correction_root_admission_required");
        // Full rows include payload/proof, coalescedCount, requestedAt, all heartbeats, receipts and usage.
        expect(await commitDbState({ ...b.s, db: b.peer })).toEqual(before);
        expect(recordEvent).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
      }
      await expect(queuePausedAgentWakeupRequest(b.s.db, {
        ...input, idempotencyKey: key, payload: null, typedQueueColumns: { ...input.typedQueueColumns, issueId: null },
      })).rejects.toThrow("qa_correction_root_admission_required");
      expect(await commitDbState({ ...b.s, db: b.peer })).toEqual(before);
      expect(recordEvent).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  }, 60000);

  it("reuses one exact bounded helper row without merging its payload", async () => {
    const c = await issueC02(owned, { mode: "content-only" }), t = c.followup.target;
    const [origin] = await c.s.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.s.f.verdictHeartbeatId));
    const key = OPERATOR_DECISION_WAKE_PREFIX + "00000000-0000-4000-8000-000000000001:g1:a1";
    const recordEvent = vi.fn(async () => {});
    const input = { companyId: c.ref.companyId, agentId: origin!.agentId, source: "automation",
      triggerDetail: "system", reason: "operator_decision_resolved", payload: { first: true },
      typedQueueColumns: { requestKind: null, issueId: t.issueId, missionId: c.s.p.missionId,
        workflowRunId: c.ref.workflowRunId, workflowStepRunId: t.stepRunId },
      requestedByActorType: "user" as const, requestedByActorId: "c02-bounded",
      idempotencyKey: key, missionIdForWake: c.s.p.missionId, recordEvent };
    await queuePausedAgentWakeupRequest(c.s.db, input);
    await queuePausedAgentWakeupRequest(c.s.db, { ...input, payload: { second: true } });
    const rows = await c.peer.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, c.ref.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(rows).toEqual([expect.objectContaining({ agentId: origin!.agentId, issueId: t.issueId,
      payload: { first: true }, coalescedCount: 0 })]);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    await expect(queuePausedAgentWakeupRequest(c.s.db, { ...input, agentId: randomUUID() }))
      .rejects.toThrow("bounded_wakeup_identity_mismatch");
  }, 60000);
});
