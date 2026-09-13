// [TEST] T8 bounded resubmission: 소명 누락 결과가 버전 있는 계약으로 영속 저장되고,
//   manifest 고정 정책의 유한 한도 안에서만 재제출 실행이 예약됨을 실제 DB로 증명한다.
//   콜백 반환값·응답 필드만으로는 예약/수락 증거가 되지 않는다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, heartbeatRuns, missionPlanQaVerdicts, qualityPolicyVersions,
} from "@paperclipai/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PlanQaResubmissionDispatch, PlanQaVerdictState } from "@paperclipai/shared";
import { planQaVerdictStateSchema } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import {
  GATE_DECISION_HASH, checkoutReviewer, readAndVerify, seedGateWorld, type GateWorld,
} from "./helpers/plan-qa-addendum.js";
import { planQaResubmissionWakeKey } from "../services/quality/native-wake.js";
import { dispatchPendingPlanQaResubmission } from "../services/missions/plan-qa-resubmission.js";
import { buildPlanQaScope } from "../services/missions/plan-qa-addendum-gate.js";
import { verifyPlanQaSubmission } from "../services/missions/mission-plan-qa-verdicts.js";

type FakeWake = {
  companyId: string; agentId: string; issueId: string; missionId: string; intentKey: string; attempt: number;
};

function fakeDispatcher() {
  const calls: FakeWake[] = [];
  return {
    calls,
    enqueue: async (input: FakeWake) => { calls.push(input); return { queued: true }; },
  };
}

function dispatchInput(w: GateWorld, enqueue: unknown) {
  return {
    companyId: w.companyId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH,
    missionId: w.missionId, enqueue,
  } as Parameters<typeof dispatchPendingPlanQaResubmission>[1];
}

async function loadState(w: GateWorld): Promise<PlanQaVerdictState> {
  const [row] = await w.db.select().from(missionPlanQaVerdicts).where(and(
    eq(missionPlanQaVerdicts.companyId, w.companyId),
    eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId),
    eq(missionPlanQaVerdicts.decisionHash, GATE_DECISION_HASH),
  )).limit(1);
  const parsed = planQaVerdictStateSchema.safeParse(row?.qualityContract);
  expect(parsed.success).toBe(true);
  return parsed.data!;
}

function submitMissing(w: GateWorld, attempt?: { runId: string; executionEpoch: number }) {
  return readAndVerify(w, "pass", {}, attempt);
}

describeQualityDb("PLAN-QA bounded resubmission ledger", () => {
  let owned: QualityTestDb;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-resubmit-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("persists a versioned dispatch record with the exact missing-evidence document before any wake", async () => {
    const w = await seedGateWorld(owned.db);
    const dispatcher = fakeDispatcher();
    const missing = await submitMissing(w);
    expect(missing.status).toBe("missing_evidence");
    const dispatched = await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    expect(dispatched).toEqual({ requested: true, accepted: false });
    const state = await loadState(w);
    expect(state.dispatches).toHaveLength(1);
    const record: PlanQaResubmissionDispatch = state.dispatches[0]!;
    expect(record.schemaVersion).toBe(1);
    expect(record.kind).toBe("plan_qa_resubmission_dispatch");
    expect(record.attempt).toBe(1);
    expect(record.maxResubmissions).toBe(2);
    expect(record.intentKey).toBe(planQaResubmissionWakeKey({
      issueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, generation: 1, attempt: 1,
    }));
    expect(record.missingEvidence).toEqual(missing);
    expect(record.missingEvidence.scope).toMatchObject({ kind: "plan_qa", issueId: w.planQaIssueId });
    expect((record.missingEvidence.scope as { executionEpoch: number }).executionEpoch).toBe(w.actor.executionEpoch);
    expect(record.policyVersionId).not.toBeNull();
    expect(record.policyDefinitionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatcher.calls).toEqual([{
      companyId: w.companyId, agentId: w.reviewerAgentId, issueId: w.planQaIssueId,
      missionId: w.missionId, intentKey: record.intentKey, attempt: 1,
    }]);
    expect((await w.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, w.companyId), eq(activityLog.action, "mission.plan_qa.resubmission_scheduled"),
    ))).map((row) => row.entityId)).toContain(w.planQaIssueId);
  });

  it("does not schedule a second dispatch for the same attempt scope; remaining derives from the ledger", async () => {
    const w = await seedGateWorld(owned.db);
    const dispatcher = fakeDispatcher();
    const first = await submitMissing(w);
    expect(first).toMatchObject({ status: "missing_evidence", remainingResubmissions: 2 });
    await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    const second = await submitMissing(w);
    expect(second).toMatchObject({ status: "missing_evidence", remainingResubmissions: 1 });
    await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    expect((await loadState(w)).dispatches).toHaveLength(1);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("never schedules without a pinned policy (limit 0) and no dispatch record exists", async () => {
    const w = await seedGateWorld(owned.db, { policy: false });
    const dispatcher = fakeDispatcher();
    // 정책이 없으면 추가 검사 자체가 적용 대상이 아니다(readPlanQaCheck 을 호출할 수 없다).
    // 빈 checks 제출 → manifest coverage 무효로 missing_evidence, 남은 횟수 0, 예약 없음.
    const scope = await buildPlanQaScope(w.db, {
      companyId: w.companyId, issueId: w.planQaIssueId,
      heartbeatRunId: w.actor.heartbeatRunId, executionEpoch: w.actor.executionEpoch,
    });
    const missing = await verifyPlanQaSubmission(w.db, w.actor, { scope, schemaVersion: 2, checks: [] });
    expect(missing).toMatchObject({ status: "missing_evidence", remainingResubmissions: 0 });
    const dispatched = await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    expect(dispatched).toEqual({ requested: false, accepted: false });
    expect((await loadState(w)).dispatches ?? []).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("rejects a changed pinned policy definition instead of scheduling", async () => {
    const w = await seedGateWorld(owned.db);
    // 같은 파일의 다른 회사 정책과 격리하기 위해 반드시 이 회사의 정책 행을 고른다.
    const [policy] = await owned.db.select().from(qualityPolicyVersions)
      .where(eq(qualityPolicyVersions.companyId, w.companyId));
    await owned.db.update(qualityPolicyVersions)
      .set({ definition: { ...policy!.definition, maxEvidenceResubmissions: 9 } })
      .where(eq(qualityPolicyVersions.id, policy!.id));
    await expect(submitMissing(w)).rejects.toMatchObject({ status: 409 });
    const dispatcher = fakeDispatcher();
    await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("stops scheduling after the pinned policy allowance is exhausted across new attempts", async () => {
    const w = await seedGateWorld(owned.db, { maxEvidenceResubmissions: 1 });
    const dispatcher = fakeDispatcher();
    const first = await submitMissing(w);
    expect(first).toMatchObject({ status: "missing_evidence", remainingResubmissions: 1 });
    await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    await w.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, w.runId));
    const run2 = await checkoutReviewer(w.db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    const second = await submitMissing(w, { runId: run2, executionEpoch: 2 });
    expect(second).toMatchObject({ status: "missing_evidence", remainingResubmissions: 0 });
    await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue));
    const state = await loadState(w);
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]!.attempt).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("reports acceptance only from the durable admission receipt, never from the callback", async () => {
    const w = await seedGateWorld(owned.db);
    await submitMissing(w);
    const intentKey = (await loadState(w)).dispatches[0]!.intentKey;
    const dispatched = await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, () => "accepted-marker"));
    expect(dispatched).toEqual({ requested: true, accepted: false });
    await w.db.insert(agentWakeupRequests).values({
      companyId: w.companyId, agentId: w.reviewerAgentId, source: "automation", triggerDetail: "system",
      reason: "plan_qa_evidence_resubmission", status: "queued", idempotencyKey: intentKey,
      issueId: w.planQaIssueId, missionId: w.missionId,
      qualityAcceptance: { intentKey, inputHash: "a".repeat(64), attempt: 1, heartbeatRunId: w.runId },
    });
    const replay = await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, () => {
      throw new Error("must not re-invoke an already requested wake");
    }));
    expect(replay).toEqual({ requested: true, accepted: true });
  });

  it("does nothing when no dispatch record exists or no handler is wired", async () => {
    const w = await seedGateWorld(owned.db);
    const dispatcher = fakeDispatcher();
    expect(await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, dispatcher.enqueue)))
      .toEqual({ requested: false, accepted: false });
    expect(dispatcher.calls).toHaveLength(0);
    await submitMissing(w);
    expect(await dispatchPendingPlanQaResubmission(w.db, dispatchInput(w, null)))
      .toEqual({ requested: false, accepted: false });
  });
});
