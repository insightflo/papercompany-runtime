// [TEST] T9 적용 경합: 동시 적용은 하나의 연결 세대·하나의 영수증으로 직렬화되고, 유실 재요청은
// 같은 영수증을 돌려준다. 다른 조치의 평가·영수증으로는 적용할 수 없다(회사·action 스코프 거부).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  evaluatorCandidateRuns, evaluatorVersions, qualityActions, qualityConsumerBindings, qualityEvidenceRefs, type Db,
} from "@paperclipai/db";
import type { ArtifactRef, CheckResult, EvaluationScope, QualityAgentActor, SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";
import { applyVerifiedAddendum, verifyAdoptionReadback } from "../services/quality/adoption.js";
import { hashContract } from "../services/quality/contract.js";
import { attachEvidence, linkEvidence, uploadEvidence } from "../services/quality/evidence-store.js";
import { rollbackAddendum } from "../services/quality/rollback.js";
import { getStorageService } from "../storage/index.js";

const ADD_CHECK_IDS = ["add-1", "add-2"];

/** 실제 T6 경로로 고정 평가를 끝까지 운행한다(파일 간 테스트 등록 공유를 피하기 위해 국소 복제). */
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

/** 원 평가의 판정 영수증 계약(source·scope)과 평가 행을 회사·action 스코프로 읽는다. */
async function verdictContract(db: Db, f: EvaluationFixture): Promise<{
  source: SourceAttempt; scope: EvaluationScope; evaluation: typeof evaluatorCandidateRuns.$inferSelect;
}> {
  const [evaluation] = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
  const receiptId = (evaluation!.qualityContract as { verdict: { evidenceRefId: string } }).verdict.evidenceRefId;
  const [receipt] = await db.select().from(qualityEvidenceRefs).where(and(
    eq(qualityEvidenceRefs.companyId, f.companyId), eq(qualityEvidenceRefs.id, receiptId)));
  const contract = receipt!.qualityContract as { source: SourceAttempt; scope: EvaluationScope };
  return { source: contract.source, scope: contract.scope, evaluation: evaluation! };
}

/** 후속 불량 보고용 구조화 observation 영수증(회사·원 평가 scope 연결). */
async function linkObservationReceipt(db: Db, f: EvaluationFixture, contract: {
  source: SourceAttempt; scope: EvaluationScope;
}): Promise<string> {
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: f.companyId,
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "observation_report", defects: [{ checkId: ADD_CHECK_IDS[0], note: "사용 중 회귀 결함" }] })),
    contentType: "application/json", originalFilename: null,
  });
  const receipt = await db.transaction((tx) => linkEvidence(tx, {
    companyId: f.companyId, reviewItemId: f.reviewItemId, source: contract.source, scope: contract.scope,
    kind: "observation", uploaded, expiresAt: null, issuedBy: "quality-observation",
  }));
  return receipt.evidenceRefId;
}

/** 형제 조치가 같은 template/base 로 자체 PASS 평가 버전을 실제 링크로 적용한다(후속 세대). */
async function applySuccessorVersion(db: Db, f: EvaluationFixture): Promise<{ versionId: string; revision: number }> {
  const prior = await verdictContract(db, f);
  const priorContract = prior.evaluation.qualityContract as { verdict: { rows: unknown[] }; verifier: unknown; authorRun: unknown };
  const [priorAction] = await db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
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
  const scope = { ...prior.scope, actionId, evaluationId };
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
    companyId: f.companyId, reviewItemId: f.reviewItemId, source: prior.source, scope: scope as EvaluationScope,
    kind: "evaluation", uploaded: verdictUploaded, expiresAt: null, issuedBy: "t9-fixture",
  }));
  const [linked] = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.id, evaluationId)));
  const linkedContract = linked!.qualityContract as { verdict: { evidenceRefId: string } };
  linkedContract.verdict.evidenceRefId = verdictReceipt.evidenceRefId;
  await db.update(evaluatorCandidateRuns).set({ qualityContract: linkedContract as never }).where(and(
    eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.id, evaluationId)));
  const applied = await applyVerifiedAddendum(db, { companyId: f.companyId, actionId });
  return { versionId, revision: applied.revision };
}

describeQualityDb("Quality addendum adoption races (T9)", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  const key = () => ({ companyId: f.companyId, actionId: f.actionId });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t9-race-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    expect(await runFixedEvaluation(owned.db, f)).toBe("pass");
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("serializes concurrent applies of the same action into one binding revision and one receipt", async () => {
    const results = await Promise.all([
      applyVerifiedAddendum(owned.db, key()),
      applyVerifiedAddendum(owned.db, key()),
      applyVerifiedAddendum(owned.db, key()),
    ]);
    expect(new Set(results.map((row) => row.bindingId)).size).toBe(1);
    expect(new Set(results.map((row) => row.evidenceRefId)).size).toBe(1);
    expect(new Set(results.map((row) => row.revision)).size).toBe(1);
    expect(results[0]!.revision).toBe(1);
    const companyReceipts = await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, f.companyId));
    const adoptionReceipts = companyReceipts.filter((row) => (row.qualityContract as { kind?: string }).kind === "adoption");
    expect(adoptionReceipts).toHaveLength(1);
    expect(adoptionReceipts[0]!.id).toBe(results[0]!.evidenceRefId);
    const bindings = await owned.db.select().from(qualityConsumerBindings).where(eq(qualityConsumerBindings.companyId, f.companyId));
    expect(bindings).toHaveLength(1);
  });

  it("returns the original receipt on re-request after a lost response", async () => {
    const first = await applyVerifiedAddendum(owned.db, key());
    const replay = await applyVerifiedAddendum(owned.db, key());
    expect(replay).toEqual(first);
    expect(await verifyAdoptionReadback(owned.db, key())).toEqual({ verified: true, evidenceRefId: first.evidenceRefId });
  });

  it("rejects adoption keyed to another company", async () => {
    await expect(applyVerifiedAddendum(owned.db, { companyId: f.otherCompanyId, actionId: f.actionId }))
      .rejects.toMatchObject({ status: 404, message: "quality_action_not_found" });
  });

  it("rejects a verdict receipt that belongs to another action", async () => {
    const [originalEvaluation] = await owned.db.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
    const [original] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
    // 형제 조치: 같은 회사·같은 template/base, 자체 candidate 버전, 그러나 판정 영수증은 원래 조치 것.
    const actionId = randomUUID();
    const intentKey = `sibling-${actionId.slice(0, 8)}`;
    const target = { ...(original!.target as Record<string, unknown>), intentKey };
    const effect = { ...(original!.effect as Record<string, unknown>) };
    await owned.db.insert(qualityActions).values({
      id: actionId, companyId: f.companyId, groupId: f.groupId, kind: "qa_addendum",
      occurrenceSetHash: original!.occurrenceSetHash, occurrenceIds: original!.occurrenceIds,
      policyVersionId: f.policyVersionId, scopeVersion: original!.scopeVersion,
      target: target as never, targetHash: hashContract(target), effect: effect as never, effectHash: hashContract(effect),
      retryEnvelope: original!.retryEnvelope, revision: 1, state: "created", intentKey,
      canonicalBinding: original!.canonicalBinding,
    });
    const versionId = randomUUID();
    const uploaded = await uploadEvidence(getStorageService(), {
      companyId: f.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 1, checks: [{ checkId: "sib-1" }] })),
      contentType: "application/json", originalFilename: null,
    });
    const bodyRef = await owned.db.transaction((tx) => attachEvidence(tx, { companyId: f.companyId, issueId: f.authorIssueId, uploaded }));
    await owned.db.insert(evaluatorVersions).values({
      id: versionId, companyId: f.companyId, qualityActionId: actionId,
      qualityContract: {
        schemaVersion: 1, kind: "candidate", actionId, templateId: f.templateId, baseHash: f.baseHash,
        requirementVersionId: randomUUID(), bodyHash: uploaded.sha256, bodyRef, checks: [{ checkId: "sib-1" }], authors: [f.authorAgentId],
      },
      name: `quality-sibling-${actionId.slice(0, 8)}`, status: "candidate",
    });
    const siblingEvaluationId = randomUUID();
    await owned.db.insert(evaluatorCandidateRuns).values({
      id: siblingEvaluationId, companyId: f.companyId, qualityActionId: actionId, evaluatorVersionId: versionId, status: "passed",
      // 원래 평가의 판정 원본(다른 action 영수증 참조)을 그대로 재사용한다 — 적용 시 scope 검증으로 거부 대상.
      qualityContract: {
        ...(originalEvaluation!.qualityContract as Record<string, unknown>), actionId, candidateVersionId: versionId,
        invocationIndex: {}, invocations: {}, reads: {}, submissions: {}, resubmissions: {},
      },
    });
    await owned.db.update(qualityActions).set({ currentEvaluationId: siblingEvaluationId })
      .where(and(eq(qualityActions.companyId, f.companyId), eq(qualityActions.id, actionId)));
    await expect(applyVerifiedAddendum(owned.db, { companyId: f.companyId, actionId }))
      .rejects.toMatchObject({ status: 422, message: "quality_evidence_scope_mismatch" });
  });

  it("returns the original receipt without reactivating a withdrawn version", async () => {
    const first = await applyVerifiedAddendum(owned.db, key());
    const prior = await verdictContract(owned.db, f);
    const failureEvidenceRefId = await linkObservationReceipt(owned.db, f, prior);
    const outcome = await rollbackAddendum(owned.db, {
      companyId: f.companyId, bindingId: first.bindingId, badVersionId: prior.evaluation.evaluatorVersionId,
      expectedRevision: first.revision, failureEvidenceRefId,
    });
    expect(outcome.status).toBe("disabled");
    const replay = await applyVerifiedAddendum(owned.db, key());
    expect(replay).toEqual(first);
    const [binding] = await owned.db.select().from(qualityConsumerBindings)
      .where(eq(qualityConsumerBindings.companyId, f.companyId));
    // 철회 상태 그대로: 재요청이 철회된 버전을 다시 활성화하면 안 된다.
    expect(binding).toMatchObject({ activeVersionId: null, revision: 2, adoptionEvidenceRefId: first.evidenceRefId });
    expect(binding!.withdrawalEvidenceRefId).toBe(outcome.evidenceRefId);
    expect(await verifyAdoptionReadback(owned.db, key())).toEqual({ verified: false, evidenceRefId: first.evidenceRefId });
  });

  it("returns the original receipt when a newer action superseded the adopted version", async () => {
    const first = await applyVerifiedAddendum(owned.db, key());
    const successor = await applySuccessorVersion(owned.db, f);
    const replay = await applyVerifiedAddendum(owned.db, key());
    // 재요청은 원래 영수증 그대로고, 상위 버전으로의 자동 되돌림(새 영수증·재적용)이 없다.
    expect(replay).toEqual(first);
    const [binding] = await owned.db.select().from(qualityConsumerBindings)
      .where(eq(qualityConsumerBindings.companyId, f.companyId));
    expect(binding).toMatchObject({ activeVersionId: successor.versionId, revision: successor.revision });
    expect(binding!.adoptionEvidenceRefId).not.toBe(first.evidenceRefId);
    const adoptionReceipts = (await owned.db.select().from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.companyId, f.companyId)))
      .filter((row) => (row.qualityContract as { kind?: string }).kind === "adoption");
    expect(adoptionReceipts).toHaveLength(2);
    expect(await verifyAdoptionReadback(owned.db, key()))
      .toEqual({ verified: false, evidenceRefId: binding!.adoptionEvidenceRefId });
  });
});
