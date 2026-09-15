// [TEST] T9 적용: 현재 평가 PASS 원본만 적용 근거다. 과거 PASS·진행 중·실패 평가와
// baseline/template 해시 변경은 거절한다. 활성 연결 CAS+영수증 연결이 같은 tx 로 확정될 때만
// 적용 완료고, 재요청은 원래 영수증을 돌려준다. 새 PLAN-QA 명세는 활성 버전 검사를 고정한다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  evaluatorCandidateRuns, missionPlanArtifacts, missions, qualityActions, qualityConsumerBindings, type Db,
} from "@paperclipai/db";
import type { ArtifactRef, CheckResult, QualityAgentActor } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";
import { applyVerifiedAddendum, canReplace, verifyAdoptionReadback } from "../services/quality/adoption.js";
import { hashContract } from "../services/quality/contract.js";
import { preparePlanQaManifest } from "../services/missions/plan-qa-addendum-manifest.js";

const ADD_CHECK_IDS = ["add-1", "add-2"];
const SPOILED_CHECK_IDS = ["spoil-1", "spoil-2"];

function addChecks(f: EvaluationFixture, ids: string[]) {
  return ids.map((checkId) => ({
    checkId, requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" as const },
    expectedEvidenceKinds: ["plan_document"], instructions: `추가 검사 ${checkId}`,
  }));
}

/** 실제 T6 경로로 고정 평가를 끝까지 운행한다. spoil 시 정상 사례 후보 변형에 결함을 낸다(fail 판정). */
export async function runFixedEvaluation(db: Db, f: EvaluationFixture, checks: string[], spoil = false): Promise<string> {
  const author: QualityAgentActor = { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
  const candidate = await submitQualityCandidate(db, author, { issueId: f.authorIssueId, schemaVersion: 1, checks: addChecks(f, checks) });
  const verifierRunId = await checkInVerifier(db, f, candidate.verifierIssueId, candidate.verifierStepRunId, 0);
  const verifier: QualityAgentActor = { agentId: f.verifierAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
  // PASS 조건(불량 사례 후보 변형에 결함 1개, T6 매트릭스와 동일): 불량 baseline=pass, 후보=request_changes.
  const statusFor = (caseId: string, variant: "baseline" | "candidate", checkId: string): CheckResult["status"] => {
    if (variant === "candidate" && checkId === checks[0] && (spoil || caseId === f.caseIds.failure)) return "defect";
    return "satisfied";
  };
  const matrix: Array<[string, "baseline" | "candidate", string[]]> = [
    [f.caseIds.failure, "baseline", [f.baseCheckId]],
    [f.caseIds.failure, "candidate", [f.baseCheckId, ...checks]],
    ...f.caseIds.normal.flatMap((caseId): Array<[string, "baseline" | "candidate", string[]]> => [
      [caseId, "baseline", [f.baseCheckId]], [caseId, "candidate", [f.baseCheckId, ...checks]],
    ]),
  ];
  for (const [caseId, variant, checkIds] of matrix) {
    const opened = await openQualityCase(db, verifier, { issueId: candidate.verifierIssueId, evaluationId: candidate.evaluationId, caseId, variant });
    const readRefs: Record<string, ArtifactRef> = {};
    for (const checkId of checkIds) {
      readRefs[checkId] = (await readQualityCheck(db, verifier, { invocationId: opened.invocationId, checkId, pointers: ["/plan/goal"] })).readRef;
    }
    const results = checkIds.map((checkId) => ({ checkId, status: statusFor(caseId, variant, checkId), readRef: readRefs[checkId]!, evidence: [] }));
    await submitQualityCase(db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results });
  }
  const verdict = await verifyQualityEvaluation(db, verifier, { companyId: f.companyId, actionId: f.actionId });
  if (!("status" in verdict) || verdict.status === "missing_evidence") throw new Error(`평가 판정 실패: ${JSON.stringify(verdict)}`);
  return verdict.status;
}

/** 매니페스트 준비에 필요한 mission+plan artifact 를 fixture 위에 붙인다. */
export async function seedManifestWorld(db: Db, f: EvaluationFixture, decisionHash: string): Promise<{ missionId: string; planArtifactId: string }> {
  const missionId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId: f.companyId, ownerAgentId: f.authorAgentId, title: "T9 manifest mission", status: "active" });
  const [plan] = await db.insert(missionPlanArtifacts).values({
    companyId: f.companyId, missionId, ownerAgentId: f.authorAgentId, revision: 1, missionGoal: "T9 목표",
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

describeQualityDb("Quality addendum adoption (T9)", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  let adopted: { bindingId: string; revision: number; evidenceRefId: string };
  let candidateVersionId: string;
  const key = () => ({ companyId: f.companyId, actionId: f.actionId });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t9-adopt-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    expect(await runFixedEvaluation(owned.db, f, ADD_CHECK_IDS)).toBe("pass");
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(and(
      eq(evaluatorCandidateRuns.companyId, f.companyId), eq(evaluatorCandidateRuns.qualityActionId, f.actionId)));
    candidateVersionId = evaluation!.evaluatorVersionId;
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("replaces only at the exact version and generation (brief contract)", () => {
    expect(canReplace({ versionId: "new", revision: 3 }, { versionId: "bad", revision: 2 })).toBe(false);
    expect(canReplace({ versionId: "bad", revision: 2 }, { versionId: "bad", revision: 2 })).toBe(true);
  });

  it("applies the current PASS evaluation with the binding row and receipt fixed together", async () => {
    expect(await verifyAdoptionReadback(owned.db, key())).toEqual({ verified: false, evidenceRefId: null });
    adopted = await applyVerifiedAddendum(owned.db, key());
    expect(adopted.revision).toBe(1);
    const [binding] = await owned.db.select().from(qualityConsumerBindings).where(and(
      eq(qualityConsumerBindings.companyId, f.companyId),
      eq(qualityConsumerBindings.templateId, f.templateId),
      eq(qualityConsumerBindings.baseHash, f.baseHash)));
    expect(binding).toMatchObject({ id: adopted.bindingId, activeVersionId: candidateVersionId, revision: 1, previousVerifiedVersionId: null });
    expect(binding!.adoptionEvidenceRefId).toBe(adopted.evidenceRefId);
  });

  it("returns the original receipt when the apply response was lost", async () => {
    const replay = await applyVerifiedAddendum(owned.db, key());
    expect(replay).toEqual(adopted);
    expect(await verifyAdoptionReadback(owned.db, key())).toEqual({ verified: true, evidenceRefId: adopted.evidenceRefId });
  });

  it("pins the adopted version checks into a newly prepared PLAN-QA manifest", async () => {
    const world = await seedManifestWorld(owned.db, f, "a".repeat(64));
    const prepared = await preparePlanQaManifest(owned.db, {
      companyId: f.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId,
      decisionHash: "a".repeat(64), reviewGeneration: 1,
    });
    const template = prepared.manifest.templates.find((entry) => entry.templateId === f.templateId)!;
    expect(template).toMatchObject({ status: "applied", addendumVersionId: candidateVersionId, notAppliedReason: null });
    expect(template.checks.map((check) => check.checkId)).toEqual([f.baseCheckId, ...ADD_CHECK_IDS]);
    expect(prepared.manifest.checks.map((check) => check.checkId)).toEqual([f.baseCheckId, ...ADD_CHECK_IDS]);
  });

  it("rejects adoption when the exact template base hash changed", async () => {
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
    const original = { target: action!.target, targetHash: action!.targetHash };
    const changed = { ...(action!.target as Record<string, unknown>), baseHash: "ab".repeat(32) };
    await owned.db.update(qualityActions).set({ target: changed as never, targetHash: hashContract(changed) }).where(eq(qualityActions.id, f.actionId));
    await expect(applyVerifiedAddendum(owned.db, key())).rejects.toMatchObject({ status: 409, message: "quality_policy_target_unavailable" });
    await owned.db.update(qualityActions).set({ target: original.target, targetHash: original.targetHash }).where(eq(qualityActions.id, f.actionId));
  });

  it("ignores an older PASS once a newer evaluation is current", async () => {
    const author: QualityAgentActor = { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
    await submitQualityCandidate(owned.db, author, { issueId: f.authorIssueId, schemaVersion: 1, checks: addChecks(f, ["add-3", "add-4"]) });
    await expect(applyVerifiedAddendum(owned.db, key())).rejects.toMatchObject({ status: 409, message: "quality_evaluation_pending" });
    await expect(verifyAdoptionReadback(owned.db, key())).resolves.toEqual({ verified: true, evidenceRefId: adopted.evidenceRefId });
  });

  it("rejects a failed current evaluation", async () => {
    const second = await seedEvaluationFixture(owned.db);
    expect(await runFixedEvaluation(owned.db, second, SPOILED_CHECK_IDS, true)).toBe("fail");
    await expect(applyVerifiedAddendum(owned.db, { companyId: second.companyId, actionId: second.actionId }))
      .rejects.toMatchObject({ status: 409, message: "quality_evaluation_not_passed" });
  });
});
