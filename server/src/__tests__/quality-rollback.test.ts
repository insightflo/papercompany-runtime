// [TEST] T9 철회: 현재 활성 연결이 정확히 그 불량 버전·세대일 때만 CAS 로 되돌린다. 기준 호환·검증된
// 이전 버전이 있으면 복구, 없으면 비활성화한다. 비활성화 동안 required 정책의 새 PLAN-QA 실행과
// 새 전달은 차단되고, 원본 terminal 기록은 보존된다. 실패 근거는 다른 회사·다른 action 의 것을 받지 않는다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  evaluatorCandidateRuns, evaluatorVersions, heartbeatRuns, issues, missionPlanArtifacts, missions,
  qualityActions, qualityConsumerBindings, qualityEvidenceRefs, type Db,
} from "@paperclipai/db";
import type { ArtifactRef, CheckResult, EvaluationScope, QualityAgentActor, SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";
import { applyVerifiedAddendum } from "../services/quality/adoption.js";
import { rollbackAddendum, isAddendumWithdrawnForTarget } from "../services/quality/rollback.js";
import { hashContract } from "../services/quality/contract.js";
import { attachEvidence, linkEvidence, uploadEvidence } from "../services/quality/evidence-store.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";
import { getStorageService } from "../storage/index.js";
import { blockedPlanQaTemplates, preparePlanQaManifest } from "../services/missions/plan-qa-addendum-manifest.js";

const ADD_CHECK_IDS = ["add-1", "add-2"];

async function runFixedEvaluation(db: Db, f: EvaluationFixture): Promise<string> {
  const checks = ADD_CHECK_IDS.map((checkId) => ({
    checkId, requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" as const },
    expectedEvidenceKinds: ["plan_document"], instructions: `추가 검사 ${checkId}`,
  }));
  const author: QualityAgentActor = { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
  const candidate = await submitQualityCandidate(db, author, { issueId: f.authorIssueId, schemaVersion: 1, checks });
  const verifierRunId = await checkInVerifier(db, f, candidate.verifierIssueId, candidate.verifierStepRunId, 0);
  const verifier: QualityAgentActor = { agentId: f.verifierAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
  // PASS 조건(T6 매트릭스): 불량 사례 후보 변형의 첫 추가 검사만 결함으로 제출한다.
  const statusFor = (caseId: string, variant: "baseline" | "candidate", checkId: string): CheckResult["status"] =>
    variant === "candidate" && checkId === ADD_CHECK_IDS[0] && caseId === f.caseIds.failure ? "defect" : "satisfied";
  const matrix: Array<[string, "baseline" | "candidate", string[]]> = [
    [f.caseIds.failure, "baseline", [f.baseCheckId]],
    [f.caseIds.failure, "candidate", [f.baseCheckId, ...ADD_CHECK_IDS]],
    ...f.caseIds.normal.flatMap((caseId): Array<[string, "baseline" | "candidate", string[]]> => [
      [caseId, "baseline", [f.baseCheckId]], [caseId, "candidate", [f.baseCheckId, ...ADD_CHECK_IDS]],
    ]),
  ];
  for (const [caseId, variant, checkIds] of matrix) {
    const opened = await openQualityCase(db, verifier, { issueId: candidate.verifierIssueId, evaluationId: candidate.evaluationId, caseId, variant });
    const readRefs: Record<string, ArtifactRef> = {};
    for (const checkId of checkIds) {
      readRefs[checkId] = (await readQualityCheck(db, verifier, { invocationId: opened.invocationId, checkId, pointers: ["/plan/goal"] })).readRef;
    }
    const results = checkIds.map((checkId): CheckResult => ({ checkId, status: statusFor(caseId, variant, checkId), readRef: readRefs[checkId]!, evidence: [] }));
    await submitQualityCase(db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results });
  }
  const verdict = await verifyQualityEvaluation(db, verifier, { companyId: f.companyId, actionId: f.actionId });
  if (!("status" in verdict) || verdict.status === "missing_evidence") throw new Error(`평가 판정 실패: ${JSON.stringify(verdict)}`);
  return verdict.status;
}

async function seedManifestWorld(db: Db, f: EvaluationFixture, decisionHash: string): Promise<{ missionId: string; planArtifactId: string }> {
  const missionId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId: f.companyId, ownerAgentId: f.authorAgentId, title: "T9 rollback mission", status: "active" });
  const [plan] = await db.insert(missionPlanArtifacts).values({
    companyId: f.companyId, missionId, ownerAgentId: f.authorAgentId, revision: 1, missionGoal: "T9 철회 목표",
    refs: {
      schemaVersion: 3,
      selectedExecutionUnits: [{ id: "unit-1", title: "작성", selectionState: "selected" }],
      planTemplates: { selectionSource: "explicit", items: [{ id: f.templateId, key: f.templateId.slice(0, 8), contentHash: f.baseHash }] },
      ownerPlanDecision: { decisionHash },
    },
    requiredInputs: [], successCriteria: [], steps: [],
  }).returning({ id: missionPlanArtifacts.id });
  return { missionId, planArtifactId: plan!.id };
}

/** 후속 불량 버전: 같은 template/base 의 형제 조치+자체 PASS 평가를 실제 링크로 만들고 적용까지 수행한다. */
async function adoptSuccessor(db: Db, f: EvaluationFixture): Promise<{ actionId: string; versionId: string; failureEvidenceRefId: string }> {
  const [priorAction] = await db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
  const [priorEvaluation] = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
  const priorContract = priorEvaluation!.qualityContract as { verdict: { rows: unknown[]; evidenceRefId: string }; verifier: unknown; authorRun: unknown };
  const priorReceipt = (await db.select().from(qualityEvidenceRefs).where(and(
    eq(qualityEvidenceRefs.companyId, f.companyId), eq(qualityEvidenceRefs.id, priorContract.verdict.evidenceRefId))))[0]!;
  const priorReceptContract = priorReceipt.qualityContract as { source: SourceAttempt; scope: EvaluationScope };
  const actionId = randomUUID();
  const versionId = randomUUID();
  const evaluationId = randomUUID();
  const intentKey = `successor-${actionId.slice(0, 8)}`;
  const target = { ...(priorAction!.target as Record<string, unknown>), intentKey };
  const effect = { ...(priorAction!.effect as Record<string, unknown>) };
  await db.insert(qualityActions).values({
    id: actionId, companyId: f.companyId, groupId: f.groupId, kind: "qa_addendum",
    occurrenceSetHash: priorAction!.occurrenceSetHash, occurrenceIds: priorAction!.occurrenceIds,
    policyVersionId: f.policyVersionId, scopeVersion: priorAction!.scopeVersion,
    target: target as never, targetHash: hashContract(target), effect: effect as never, effectHash: hashContract(effect),
    retryEnvelope: priorAction!.retryEnvelope, revision: 1, state: "created", intentKey, currentEvaluationId: evaluationId,
    canonicalBinding: priorAction!.canonicalBinding,
  });
  const checks = ["add-s1", "add-s2"].map((checkId) => ({
    checkId, requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" as const },
    expectedEvidenceKinds: ["plan_document"], instructions: `후속 검사 ${checkId}`,
  }));
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: f.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 1, checks })), contentType: "application/json", originalFilename: null,
  });
  const bodyRef = await db.transaction((tx) => attachEvidence(tx, { companyId: f.companyId, issueId: f.authorIssueId, uploaded }));
  await db.insert(evaluatorVersions).values({
    id: versionId, companyId: f.companyId, qualityActionId: actionId,
    qualityContract: {
      schemaVersion: 1, kind: "candidate", actionId, templateId: f.templateId, baseHash: f.baseHash,
      requirementVersionId: randomUUID(), bodyHash: uploaded.sha256, bodyRef, checks, authors: [f.authorAgentId],
    },
    name: `quality-successor-${actionId.slice(0, 8)}`, status: "candidate",
  });
  const scope = { ...priorReceptContract.scope, actionId, evaluationId };
  // 평가 행을 먼저 두어 linkEvidence 의 scope 재검증(평가 행 존재+action 연결)이 통과하게 한다.
  await db.insert(evaluatorCandidateRuns).values({
    id: evaluationId, companyId: f.companyId, qualityActionId: actionId, evaluatorVersionId: versionId, status: "passed",
    qualityContract: {
      schemaVersion: 1, kind: "evaluation", actionId, candidateVersionId: versionId, checks,
      verifier: priorContract.verifier, authorRun: priorContract.authorRun,
      invocationIndex: {}, invocations: {}, reads: {}, submissions: {}, resubmissions: {},
      verdict: { status: "pass", evidenceRefId: randomUUID(), rows: priorContract.verdict.rows, scoredAt: new Date().toISOString() },
    },
  });
  const verdictUploaded = await uploadEvidence(getStorageService(), {
    companyId: f.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "evaluation", evaluationId, status: "pass", rows: priorContract.verdict.rows, scoredAt: new Date().toISOString() })),
    contentType: "application/json", originalFilename: null,
  });
  const verdictReceipt = await db.transaction((tx) => linkEvidence(tx, {
    companyId: f.companyId, reviewItemId: f.reviewItemId, source: priorReceptContract.source, scope: scope as EvaluationScope,
    kind: "evaluation", uploaded: verdictUploaded, expiresAt: null, issuedBy: "t9-fixture",
  }));
  const [linked] = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.id, evaluationId)));
  const linkedContract = linked!.qualityContract as { verdict: { evidenceRefId: string } };
  linkedContract.verdict.evidenceRefId = verdictReceipt.evidenceRefId;
  await db.update(evaluatorCandidateRuns).set({ qualityContract: linkedContract as never }).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.id, evaluationId)));
  const applied = await applyVerifiedAddendum(db, { companyId: f.companyId, actionId });
  expect(applied.revision).toBe(2);
  const failureEvidenceRefId = await linkFailureEvidence(db, f, scope as EvaluationScope, priorReceptContract.source);
  return { actionId, versionId, failureEvidenceRefId };
}

async function linkFailureEvidence(db: Db, f: EvaluationFixture, scope: EvaluationScope, source: SourceAttempt): Promise<string> {
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: f.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "observation_report", defects: [{ checkId: "add-1", note: "사용 중 회귀 결함" }] })),
    contentType: "application/json", originalFilename: null,
  });
  const receipt = await db.transaction((tx) => linkEvidence(tx, {
    companyId: f.companyId, reviewItemId: f.reviewItemId, source, scope, kind: "observation", uploaded, expiresAt: null, issuedBy: "quality-observation",
  }));
  return receipt.evidenceRefId;
}

describeQualityDb("Quality addendum rollback (T9)", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  let v1: string;
  let bindingId: string;
  let successor: { actionId: string; versionId: string; failureEvidenceRefId: string };
  const bindingRow = async () => (await owned.db.select().from(qualityConsumerBindings).where(and(
    eq(qualityConsumerBindings.companyId, f.companyId), eq(qualityConsumerBindings.id, bindingId))))[0]!;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t9-rollback-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    expect(await runFixedEvaluation(owned.db, f)).toBe("pass");
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(and(
      eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
    v1 = evaluation!.evaluatorVersionId;
    const applied = await applyVerifiedAddendum(owned.db, { companyId: f.companyId, actionId: f.actionId });
    bindingId = applied.bindingId;
    successor = await adoptSuccessor(owned.db, f);
  }, 360_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("restores the verified previous version only at the exact bad version and revision", async () => {
    expect((await bindingRow()).activeVersionId).toBe(successor.versionId);
    const terminalBefore = await owned.db.select().from(issues).where(eq(issues.companyId, f.companyId));
    const missionsBefore = await owned.db.select().from(missions).where(eq(missions.companyId, f.companyId));
    const runsBefore = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const outcome = await rollbackAddendum(owned.db, {
      companyId: f.companyId, bindingId, badVersionId: successor.versionId,
      expectedRevision: 2, failureEvidenceRefId: successor.failureEvidenceRefId,
    });
    expect(outcome.status).toBe("restored");
    expect(outcome.evidenceRefId).toBeTruthy();
    const binding = await bindingRow();
    expect(binding).toMatchObject({ activeVersionId: v1, previousVerifiedVersionId: null, revision: 3 });
    expect(binding.withdrawalEvidenceRefId).toBe(outcome.evidenceRefId);
    expect(await owned.db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual(terminalBefore);
    expect(await owned.db.select().from(missions).where(eq(missions.companyId, f.companyId))).toEqual(missionsBefore);
    expect(await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual(runsBefore);
    // 이미 복구된 뒤 같은 입력 재철회는 충돌이고 연결을 바꾸지 않는다.
    const conflict = await rollbackAddendum(owned.db, {
      companyId: f.companyId, bindingId, badVersionId: successor.versionId,
      expectedRevision: 2, failureEvidenceRefId: successor.failureEvidenceRefId,
    });
    expect(conflict).toEqual({ status: "conflict", evidenceRefId: null });
    expect(await bindingRow()).toMatchObject({ activeVersionId: v1, revision: 3 });
  });

  it("rejects failure evidence from another action or an unknown receipt", async () => {
    const [originalEvaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(and(
      eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
    const originalReceipt = (await owned.db.select().from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, f.companyId),
      eq(qualityEvidenceRefs.id, (originalEvaluation!.qualityContract as { verdict: { evidenceRefId: string } }).verdict.evidenceRefId))))[0]!;
    // action1 의 실제 observation 영수증(qualityActionId=action1)을 만들어 후속 불량 버전(action2)의 근거로 지목한다.
    const originalContract = originalReceipt.qualityContract as { source: SourceAttempt; scope: EvaluationScope };
    const actionOneReceiptId = await linkFailureEvidence(owned.db, f, originalContract.scope, originalContract.source);
    await expect(rollbackAddendum(owned.db, {
      companyId: f.companyId, bindingId, badVersionId: successor.versionId,
      expectedRevision: 3, failureEvidenceRefId: actionOneReceiptId,
    })).rejects.toMatchObject({ status: 422, message: "quality_evidence_scope_mismatch" });
    await expect(rollbackAddendum(owned.db, {
      companyId: f.companyId, bindingId, badVersionId: successor.versionId,
      expectedRevision: 3, failureEvidenceRefId: randomUUID(),
    })).rejects.toMatchObject({ status: 422, message: "quality_evidence_missing" });
  });

  it("rejects rollback keyed to another company", async () => {
    await expect(rollbackAddendum(owned.db, {
      companyId: f.otherCompanyId, bindingId, badVersionId: successor.versionId,
      expectedRevision: 3, failureEvidenceRefId: successor.failureEvidenceRefId,
    })).rejects.toMatchObject({ status: 404 });
  });

  it("disables the addendum when no verified previous version exists", async () => {
    const second = await seedEvaluationFixture(owned.db);
    expect(await runFixedEvaluation(owned.db, second)).toBe("pass");
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(and(
      eq(evaluatorCandidateRuns.companyId, second.companyId), eq(evaluatorCandidateRuns.qualityActionId, second.actionId)));
    const [firstReceipt] = await owned.db.select().from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, second.companyId),
      eq(qualityEvidenceRefs.id, (evaluation!.qualityContract as { verdict: { evidenceRefId: string } }).verdict.evidenceRefId)));
    const firstContract = firstReceipt!.qualityContract as { source: SourceAttempt; scope: EvaluationScope };
    const applied = await applyVerifiedAddendum(owned.db, { companyId: second.companyId, actionId: second.actionId });
    const failureEvidenceRefId = await linkFailureEvidence(owned.db, second, firstContract.scope, firstContract.source);
    const outcome = await rollbackAddendum(owned.db, {
      companyId: second.companyId, bindingId: applied.bindingId, badVersionId: evaluation!.evaluatorVersionId,
      expectedRevision: applied.revision, failureEvidenceRefId,
    });
    expect(outcome.status).toBe("disabled");
    const [binding] = await owned.db.select().from(qualityConsumerBindings).where(eq(qualityConsumerBindings.id, applied.bindingId));
    expect(binding).toMatchObject({ activeVersionId: null, previousVerifiedVersionId: null, revision: 2 });
    expect(binding.withdrawalEvidenceRefId).toBe(outcome.evidenceRefId);
    expect(await isAddendumWithdrawnForTarget(owned.db, { companyId: second.companyId, templateId: second.templateId, baseHash: second.baseHash })).toBe(true);
    expect(await isAddendumWithdrawnForTarget(owned.db, { companyId: f.companyId, templateId: f.templateId, baseHash: f.baseHash })).toBe(false);
  });

  it("blocks newly prepared required-policy manifests and delivery while withdrawn", async () => {
    const second = await seedEvaluationFixture(owned.db);
    const world = await seedManifestWorld(owned.db, second, "b".repeat(64));
    expect(await runFixedEvaluation(owned.db, second)).toBe("pass");
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(and(
      eq(evaluatorCandidateRuns.companyId, second.companyId), eq(evaluatorCandidateRuns.qualityActionId, second.actionId)));
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, second.companyId),
      eq(qualityEvidenceRefs.id, (evaluation!.qualityContract as { verdict: { evidenceRefId: string } }).verdict.evidenceRefId)));
    const contract = receipt!.qualityContract as { source: SourceAttempt; scope: EvaluationScope };
    const applied = await applyVerifiedAddendum(owned.db, { companyId: second.companyId, actionId: second.actionId });
    const failureEvidenceRefId = await linkFailureEvidence(owned.db, second, contract.scope, contract.source);
    await rollbackAddendum(owned.db, {
      companyId: second.companyId, bindingId: applied.bindingId, badVersionId: evaluation!.evaluatorVersionId,
      expectedRevision: applied.revision, failureEvidenceRefId,
    });
    const prepared = await preparePlanQaManifest(owned.db, {
      companyId: second.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId,
      decisionHash: "b".repeat(64), reviewGeneration: 1,
    });
    const template = prepared.manifest.templates.find((entry) => entry.templateId === second.templateId)!;
    expect(template).toMatchObject({ status: "addendum_withdrawn", notAppliedReason: "addendum_withdrawn", checks: [] });
    expect(blockedPlanQaTemplates(prepared.manifest)).toEqual([second.templateId]);
    expect(await deliverQualityIntent(owned.db, { companyId: second.companyId, actionId: second.actionId }))
      .toEqual({ status: "blocked", receiptId: null });
  });
});
