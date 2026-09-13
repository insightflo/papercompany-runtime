// server/src/__tests__/quality-write-bypass.test.ts
//
// [purpose] T5 일반·구형 우회 차단: 일반 resolve/cancel/retry·continuation 전달 직전 실제 DB 연결
//   검사(qualityActionId 컬럼 기준 — sourceType 문구 무관), 구형 verdict/promote-anchor/
//   request-evidence/evidence/replay/promote 409 위임, self-improvement 채택의 addendum 우회 차단.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  evaluatorCandidateRuns,
  evaluatorVersions,
  heartbeatRuns,
  missionQualityVerdicts,
  operatorDecisionContinuations,
  operatorDecisions,
  qualityActions,
  qualityOccurrences,
  qualityReviewItems,
  type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import { createQualityDecisionCard } from "../services/quality/decisions.js";
import { guardQualityWrite } from "../services/quality/write-guard.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { operatorDecisionContinuationRetryService } from "../services/operator-decision-continuation-retry.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";
import { qualityService } from "../services/quality.js";
import { selfImprovementAdoptionService } from "../services/self-improvement-adoption.js";

const boardUser = { userId: "local-board", source: "local_implicit" as const, keyId: null };
const genericResolveBody = { actionId: "choose", selectedOptionIds: [], comment: null };

describeQualityDb("generic and legacy write bypass guards", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  const db = () => owned.db;

  async function qualityBoundDecision() {
    const actionId = randomUUID();
    const intentKey = `t5-bypass-${actionId.slice(0, 8)}`;
    const target = {
      kind: "qa_addendum" as const,
      companyId: f.companyId,
      templateId: f.templateId,
      baseHash: f.baseHash,
      requirementVersionId: "req-fixture-1",
      inputHash: "33".repeat(32),
      candidateVersionId: null,
      evaluationId: null,
      intentKey,
      execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
    };
    const effect = { kind: "reevaluate_requirements" as const, requirementVersionId: "req-fixture-1", target };
    await db().insert(qualityActions).values({
      id: actionId, companyId: f.companyId, groupId: f.groupId, kind: "qa_addendum",
      occurrenceSetHash: "21".repeat(32), occurrenceIds: [], policyVersionId: f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target), maxExecutorAttempts: 2,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: f.groupId, policyVersionId: f.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    const card = await createQualityDecisionCard(db(), boardUser, { companyId: f.companyId, actionId });
    return { actionId, decisionId: card.operatorDecisionId };
  }

  it("blocks generic resolve/cancel/retry for quality-bound decisions regardless of sourceType", async () => {
    const { actionId, decisionId } = await qualityBoundDecision();
    const write = operatorDecisionWriteService(db());
    await expect(write.resolve(decisionId, genericResolveBody, "board"))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(write.cancel(decisionId, { type: "user", id: "board" }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(operatorDecisionContinuationRetryService(db()).retryContinuation(decisionId, "board"))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    // sourceType 문구 변경·삭제로 우회하지 못한다: guard 는 실제 컬럼 연결만 본다.
    await db().update(operatorDecisions).set({ sourceType: "workflow_step" }).where(eq(operatorDecisions.id, decisionId));
    await expect(guardQualityWrite(db(), { companyId: f.companyId, subject: "decision", subjectId: decisionId, operation: "resolve" }))
      .rejects.toMatchObject({ status: 409, details: { detailPath: `/api/companies/${f.companyId}/quality-actions/${actionId}` } });
    await db().update(operatorDecisions).set({ sourceType: "quality" }).where(eq(operatorDecisions.id, decisionId));
    await expect(guardQualityWrite(db(), { companyId: f.companyId, subject: "decision", subjectId: decisionId, operation: "resolve" }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    // 비연결 결정은 일반 경로 그대로(가드 통과).
    await expect(guardQualityWrite(db(), { companyId: f.companyId, subject: "decision", subjectId: randomUUID(), operation: "resolve" }))
      .resolves.toBeUndefined();
  });

  it("never wakes a continuation whose decision is quality-bound", async () => {
    const { decisionId } = await qualityBoundDecision();
    await db().insert(operatorDecisionContinuations).values({
      companyId: f.companyId, operatorDecisionId: decisionId, issueId: null,
      state: "pending", nextAttemptAt: new Date(Date.now() - 60_000),
    });
    const wakeup = { wakeup: async () => { throw new Error("must not wake quality-bound decision"); } };
    const worker = operatorDecisionContinuationWorker(db(), { ...wakeup, workerId: "t5-bypass-worker" });
    await worker.pollOnce(new Date());
    expect(await db().select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    const [continuation] = await db().select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    expect(continuation!.state).not.toBe("accepted");
  });

  it("blocks legacy quality verdict/evidence/promote-anchor writes on occurrence-linked review items only", async () => {
    const svc = qualityService(db(), { heartbeat: { wakeup: async () => null } });
    const [linked] = await db().insert(qualityReviewItems).values({
      companyId: f.companyId, title: "linked item", status: "awaiting_review",
      targetType: "mission_output", triggerSource: "plan_qa_failure",
    }).returning();
    const [producer] = await db().insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.authorAgentId, executionEpoch: 1,
    }).returning();
    await db().insert(qualityOccurrences).values({
      companyId: f.companyId, reviewItemId: linked!.id, producerRunId: producer!.id,
      submissionKey: "bypass-1", payloadHash: "55".repeat(32),
      sourceBinding: { companyId: f.companyId, issueId: randomUUID(), heartbeatRunId: producer!.id, executionEpoch: 1, inputHash: "56".repeat(32), mission: { kind: "not_applicable", reason: "no_source_mission" }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } },
      occurredAt: new Date(),
    });
    await expect(svc.recordQualityVerdict({ reviewItemId: linked!.id, decidedByUserId: "board", verdict: "pass" }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.requestEvidence({ reviewItemId: linked!.id, requiredEvidenceSurfaces: ["db_row"] }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.recordEvidence({ reviewItemId: linked!.id, surface: "db_row", status: "verified" }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.promoteVerdictToAnchor({ reviewItemId: linked!.id, verdictId: randomUUID(), title: "anchor" }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    const [item] = await db().select().from(qualityReviewItems).where(eq(qualityReviewItems.id, linked!.id));
    expect(item!.status).toBe("awaiting_review");
    // 비연결 과거 항목은 구형 동작 유지(열람·일반 판정).
    const [plain] = await db().insert(qualityReviewItems).values({
      companyId: f.companyId, title: "plain item", status: "awaiting_review",
      targetType: "mission_output", triggerSource: "plan_qa_failure",
    }).returning();
    const verdict = await svc.recordQualityVerdict({ reviewItemId: plain!.id, decidedByUserId: "board", verdict: "pass" });
    expect(verdict.reviewItem.status).toBe("resolved_pass");
  });

  it("blocks legacy replay and promote on quality-linked evaluator rows only", async () => {
    const svc = qualityService(db(), { heartbeat: { wakeup: async () => null } });
    const [linkedVersion] = await db().insert(evaluatorVersions).values({
      companyId: f.companyId, name: "linked candidate", status: "candidate", coverageSummary: {},
    }).returning();
    const { actionId } = await qualityBoundDecision();
    await db().update(evaluatorVersions).set({ qualityActionId: actionId }).where(eq(evaluatorVersions.id, linkedVersion!.id));
    const [linkedRun] = await db().insert(evaluatorCandidateRuns).values({
      companyId: f.companyId, evaluatorVersionId: linkedVersion!.id, status: "queued", replayInput: {},
    }).returning();
    await expect(svc.runCandidateReplay(f.companyId, linkedRun!.id, { regressions: 0 }))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.promoteEvaluatorVersion(f.companyId, linkedVersion!.id))
      .rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    // 비연결 행은 구형 동작 유지: replay passed → promote production.
    const [plainVersion] = await db().insert(evaluatorVersions).values({
      companyId: f.companyId, name: "plain candidate", status: "candidate", coverageSummary: {},
    }).returning();
    const [plainRun] = await db().insert(evaluatorCandidateRuns).values({
      companyId: f.companyId, evaluatorVersionId: plainVersion!.id, status: "queued", replayInput: {},
    }).returning();
    expect((await svc.runCandidateReplay(f.companyId, plainRun!.id, { regressions: 0 })).status).toBe("passed");
    expect((await svc.promoteEvaluatorVersion(f.companyId, plainVersion!.id)).status).toBe("production");
  });

  it("blocks self-improvement adoption for quality-linked candidates but not plain company skills", async () => {
    const dbx = db();
    const [skill] = await dbx.insert(companySkills).values({
      companyId: f.companyId, key: "bypass/gazua-report", slug: "bypass-gazua", name: "Bypass Skill",
      markdown: ["---", "name: Bypass Skill", "description: 우회 검증 스킬", "---", "", "## Validation checklist", "- Check contrast.", ""].join("\n"),
      sourceType: "catalog",
    }).returning();
    const svc = selfImprovementAdoptionService(dbx);
    const { actionId } = await qualityBoundDecision();
    const [qualityVersion] = await dbx.insert(evaluatorVersions).values({
      companyId: f.companyId, name: "quality-owned", status: "candidate", coverageSummary: {}, qualityActionId: actionId,
    }).returning();
    const candidate = (evidenceSource: unknown[]) => ({
      assetType: "skill",
      assetRef: skill!.key,
      evidenceSource,
      pattern: "같은 부류 재발 방지",
      proposedEdit: { operation: "add", section: "Validation checklist", content: "- 게이트 재검" },
      validationPlan: "재발 시나리오 리플레이",
      gateOwner: "peer:validator",
      autoAdoptionResult: "accepted",
    });
    const boardActor = { type: "board" as const };
    // board inline PASS 도 Quality 독립 평가가 아니다: quality 소유 산물은 전용 경로로만.
    await expect(svc.apply({
      companyId: f.companyId, candidates: [candidate([{ type: "evaluator_version", id: qualityVersion!.id }])],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }], actor: boardActor,
    })).rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.apply({
      companyId: f.companyId, candidates: [candidate([{ type: "quality_action", id: actionId }])],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }], actor: boardActor,
    })).rejects.toMatchObject({ status: 409, message: "quality_domain_action_required" });
    await expect(svc.apply({
      companyId: f.companyId, candidates: [candidate([{ type: "evaluator_version", id: randomUUID() }])],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }], actor: boardActor,
    })).rejects.toMatchObject({ status: 422 });
    const applied = await svc.apply({
      companyId: f.companyId, candidates: [candidate([{ type: "workflow_run", id: "run-1" }])],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }], actor: boardActor,
    });
    expect(applied.applied).toHaveLength(1);
  });
});
