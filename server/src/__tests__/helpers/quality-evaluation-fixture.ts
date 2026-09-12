// server/src/__tests__/helpers/quality-evaluation-fixture.ts
//
// [TEST DATA — 운영 기본값 아님] T6 실제 평가 플로우 fixture.
// 실제 oracle 아티팩트(정상 사례 plan 문서)와 발생(실패 사례 plan 문서)을 저장하고,
// T3 ensureCanonicalQualityExecution 로 author 단계를 실제 binding 한다.
// author/verifier 실행 run과 checkout 상태는 실제 행으로 만든다(어댑터 모의 없음).

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents, assets, authUsers, companies, companyMemberships, heartbeatRuns, issueAttachments,
  issues, missionPlanTemplates, qualityActionGroups, qualityActions, qualityReviewItems, type Db,
} from "@paperclipai/db";
import type { ArtifactRef } from "@paperclipai/shared";
import { qualityFixtureBoardActor, QUALITY_TEST_POLICY_NUMBERS } from "./quality-fixture.js";
import { activateQualityPolicy, createQualityPolicy } from "../../services/quality/policy.js";
import { hashContract } from "../../services/quality/contract.js";
import { uploadEvidence, linkEvidence } from "../../services/quality/evidence-store.js";
import { writeOccurrence } from "../../services/quality/occurrences.js";
import { ensureCanonicalQualityExecution } from "../../services/quality/native-records.js";
import { getStorageService } from "../../storage/index.js";

export function planDocument(goal: string, stepTitles: string[]) {
  return {
    schemaVersion: 1 as const,
    goal,
    steps: stepTitles.map((title, index) => ({ id: `s${index + 1}`, title, detail: `${title} 상세` })),
  };
}

export type EvaluationFixture = {
  companyId: string;
  otherCompanyId: string;
  authorAgentId: string;
  verifierAgentId: string;
  thirdAgentId: string;
  templateId: string;
  baseHash: string;
  policyVersionId: string;
  groupId: string;
  actionId: string;
  intentKey: string;
  reviewItemId: string;
  authorIssueId: string;
  authorStepRunId: string;
  authorRunId: string;
  authorEpoch: number;
  missionId: string;
  workflowRunId: string;
  generation: number;
  caseIds: { failure: string; normal: string[] };
  baseCheckId: string;
  requirementRefs: ArtifactRef[];
};

async function storeArtifact(db: Db, companyId: string, issueId: string, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  const uploaded = await uploadEvidence(getStorageService(), { companyId, body: bytes, contentType: "application/json", originalFilename: null });
  const [asset] = await db.insert(assets).values({ companyId, ...uploaded }).returning({ id: assets.id });
  const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId, assetId: asset.id }).returning({ id: issueAttachments.id });
  return { attachmentId: attachment.id, sha256: uploaded.sha256 };
}

/** 실제 oracle(정상 사례) 아티팩트가 있는 정책 + 발생(실패 사례)이 고정된 조치 + 실제 author 단계.
 *  조치 effect 는 후보 생성 이전 phase 의 유효 형태(hold)만 쓸 수 있다 — T5 refine 이
 *  evaluate_candidate 에 candidateVersionId/evaluationId 실제 ID 를 필수화하기 때문이다. */
export async function seedEvaluationFixture(db: Db, options?: { effectKind?: "hold" }): Promise<EvaluationFixture> {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  await db.insert(companies).values([
    { id: companyId, name: "Quality Evaluation Co", issuePrefix: `QE${companyId.slice(0, 4)}` },
    { id: otherCompanyId, name: "Quality Evaluation Other", issuePrefix: `QX${companyId.slice(0, 4)}` },
  ]);
  const authorAgentId = randomUUID();
  const verifierAgentId = randomUUID();
  const thirdAgentId = randomUUID();
  await db.insert(agents).values([
    { id: authorAgentId, companyId, name: "Evaluation Author" },
    { id: verifierAgentId, companyId, name: "Evaluation Verifier" },
    { id: thirdAgentId, companyId, name: "Evaluation Third" },
  ]);
  for (const userId of ["quality-reviewer-1", "quality-rollback-1"]) {
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });
  }
  const templateId = randomUUID();
  await db.insert(missionPlanTemplates).values({
    id: templateId, companyId, key: `quality-eval-${templateId.slice(0, 8)}`,
    name: "Evaluation Template", selectionDescription: "평가용 템플릿", instructions: "평가용 지침",
    origin: "custom", enabled: true,
  });
  const baseHash = createHash("sha256").update("평가용 지침").digest("hex");
  const baseCheckId = "base-plan-check";

  // 정상 사례 2개 — 정책 oracle 아티팩트로 실제 저장.
  const producerIssue = (await db.insert(issues).values({ companyId, title: "평가 oracle 보관 이슈" }).returning())[0]!;
  const normalDocs = [
    planDocument("정상 계획 1", ["조사", "작성"]),
    planDocument("정상 계획 2", ["검증", "보고"]),
  ];
  const caseOracleRefs = [];
  for (const doc of normalDocs) caseOracleRefs.push(await storeArtifact(db, companyId, producerIssue.id, doc));
  const requirementRefs = [await storeArtifact(db, companyId, producerIssue.id, { schemaVersion: 1, requirement: "요구사항 원문" })];

  const policy = {
    targets: [{
      companyId, templateId, baseHash,
      required: [{
        checkId: baseCheckId, requirementRefs, applicability: { op: "selected_templates_all" as const, templateIds: [templateId] },
        expectedEvidenceKinds: ["plan_document"], instructions: "기본 계획 검사",
      }],
    }],
    authorAgentIds: [authorAgentId], verifierAgentIds: [verifierAgentId], allowedToolIds: [],
    reviewerUserIds: ["quality-reviewer-1"], rollbackUserIds: ["quality-rollback-1"],
    requirementSourceRefs: requirementRefs, caseOracleRefs,
    nativeOwnership: "native-active-plugin-disabled" as const,
    ...QUALITY_TEST_POLICY_NUMBERS,
    periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  const { policyVersionId } = await createQualityPolicy(db, qualityFixtureBoardActor, { companyId, policy });
  await activateQualityPolicy(db, qualityFixtureBoardActor, { companyId, policyVersionId, expectedActivePolicyVersionId: null });

  // [TEST DATA] 검증자 에이전트는 정책 활성화 검증(active) 이후 pending_approval 로 바꾼다 —
  // 깨우기가 skipped 행(전달 증거, idempotencyKey 보존)만 남기고 실제 대기열 입장/
  // 체크아웃 탈취를 하지 않게 해 테스트가 결정적으로 유지된다. 실제 환경에서 B 의 실행 run 은
  // 대기열이 만들고, 여기서는 checkInVerifier 로 실제 행을 만든다.
  await db.update(agents).set({ status: "pending_approval", updatedAt: new Date() })
    .where(eq(agents.id, verifierAgentId));
  await db.update(agents).set({ status: "pending_approval", updatedAt: new Date() })
    .where(eq(agents.id, thirdAgentId));

  // 실패 사례 1개 — 실제 발생(occurrence) 근거로 저장.
  const producerRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: producerRunId, companyId, agentId: authorAgentId, issueId: producerIssue.id, executionEpoch: 1, status: "succeeded" });
  const [review] = await db.insert(qualityReviewItems).values({ companyId, title: "평가 대상 리뷰", targetType: "qa_addendum", triggerSource: "test", failureType: "test" }).returning();
  const failureDoc = planDocument("실패 재현 계획", ["작성"]);
  const failureUploaded = await uploadEvidence(getStorageService(), { companyId, body: Buffer.from(JSON.stringify(failureDoc)), contentType: "application/json", originalFilename: null });
  const source = { companyId, issueId: producerIssue.id, heartbeatRunId: producerRunId, executionEpoch: 1, inputHash: failureUploaded.sha256, mission: { kind: "not_applicable" as const, reason: "no_source_mission" as const }, workflow: { kind: "not_applicable" as const, reason: "not_a_workflow_source" as const } };
  const failureRef = await db.transaction((tx) => linkEvidence(tx, { companyId, reviewItemId: review.id, source, scope: null, kind: "input", uploaded: failureUploaded, expiresAt: null, issuedBy: "quality-eval-fixture" }));
  const occurrence = await writeOccurrence(db, { companyId, reviewItemId: review.id, producerRunId, submissionKey: "t6-failure", source, evidence: [failureRef.ref] });

  const groupId = randomUUID();
  await db.insert(qualityActionGroups).values({ id: groupId, companyId, policyVersionId, rootOccurrenceSetHash: hashContract([occurrence.occurrenceId]), usage: {}, revision: 1 });
  const actionId = randomUUID();
  const intentKey = `quality-eval-action-${actionId.slice(0, 8)}`;
  const target = {
    kind: "qa_addendum" as const, companyId, templateId, baseHash, requirementVersionId: randomUUID(),
    inputHash: hashContract([occurrence.occurrenceId]), candidateVersionId: null, evaluationId: null, intentKey,
    execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
  };
  const effect = { kind: (options?.effectKind ?? "hold") as "hold", remindAt: null, target };
  const retryEnvelope = {
    intentKey, effectHash: hashContract(effect), targetHash: hashContract(target),
    maxExecutorAttempts: QUALITY_TEST_POLICY_NUMBERS.maxExecutionAttempts,
    deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), groupId, policyVersionId,
    maxCumulativeCostCents: QUALITY_TEST_POLICY_NUMBERS.maxCostCentsPerGroup,
  };
  await db.insert(qualityActions).values({
    id: actionId, companyId, groupId, kind: "qa_addendum",
    occurrenceSetHash: hashContract([occurrence.occurrenceId]), occurrenceIds: [occurrence.occurrenceId],
    policyVersionId, scopeVersion: 1, target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
    retryEnvelope, revision: 1, state: "created", intentKey,
  });

  // 실제 author 단계 binding(T3 경로) + author 실행 run/checkout.
  const binding = await ensureCanonicalQualityExecution(db, { companyId, actionId });
  const authorRunId = randomUUID();
  const authorEpoch = 1;
  await db.insert(heartbeatRuns).values({ id: authorRunId, companyId, agentId: authorAgentId, issueId: binding.issueId, executionEpoch: authorEpoch, status: "running", workflowStepRunId: binding.stepRunId, workflowExecutionGeneration: 0 });
  await db.update(issues).set({ status: "in_progress", assigneeAgentId: authorAgentId, checkoutRunId: authorRunId, executionRunId: authorRunId }).where(eq(issues.id, binding.issueId));

  return {
    companyId, otherCompanyId, authorAgentId, verifierAgentId, thirdAgentId,
    templateId, baseHash, policyVersionId, groupId, actionId, intentKey,
    reviewItemId: review.id, authorIssueId: binding.issueId, authorStepRunId: binding.stepRunId,
    authorRunId, authorEpoch, missionId: binding.missionId, workflowRunId: binding.workflowRunId,
    generation: 0,
    caseIds: { failure: `f1-${occurrence.occurrenceId.slice(0, 8)}`, normal: ["n1-0", "n2-1"] },
    baseCheckId,
    requirementRefs,
  };
}

/** verifier B 의 실행 run/checkout — B 단계 이슈가 만들어진 뒤 호출한다. */
export async function checkInVerifier(db: Db, f: EvaluationFixture, verifierIssueId: string, verifierStepRunId: string, generation: number) {
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.verifierAgentId, issueId: verifierIssueId, executionEpoch: 1, status: "running", workflowStepRunId: verifierStepRunId, workflowExecutionGeneration: generation });
  await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.verifierAgentId, checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, verifierIssueId));
  return runId;
}
