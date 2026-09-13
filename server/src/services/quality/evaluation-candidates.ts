// server/src/services/quality/evaluation-candidates.ts
//
// [purpose] T6 후보 생산. 인증된 author 단계의 현재 action에서 template/base/requirement를
//   읽어 불변 후보 본문을 저장하고, 독립 검증 B 단계(같은 mission 의 별도 실행)를 만들어
//   전달한다. 요청자는 다른 target을 지정할 수 없다(경로 파라미터 없음, action 고정).
// [boundary] 같은 본문 제출은 replay(같은 버전/평가/깨우기 키), 기존 checkId 내용 수정은
//   409 불변 위반, 새 checkId 조합은 새 불변 버전이다. 정책 한도(maxCandidatesPerAction) 초과 거절.
// [ordering] §3.3: usage → group → action 잠금 후 기록, 커밋 후 깨우기(부작용 분리).

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, evaluatorCandidateRuns, evaluatorVersions, heartbeatRuns, issues,
  qualityActionGroups, qualityActions, qualityPolicyUsage, qualityPolicyVersions,
  workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import {
  addendumCheckSchema, qualityAgentActorSchema, qualityPolicySchema, uuidSchema,
  type AddendumCheck, type ArtifactRef, type QualityAgentActor, type QualityPolicy,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { createIssueRecord } from "../issue-create-records.js";
import { bindWorkflowStepIssueRecord, createWorkflowStepRunRecord } from "../workflow/workflow-step-issue-records.js";
import { getStorageService } from "../../storage/index.js";
import { hashContract, parseEvidence } from "./contract.js";
import { attachEvidence, uploadEvidence } from "./evidence-store.js";
import { buildQualityVerificationSteps, findOrCreateImmutableQualityWorkflowDefinition } from "./native-definition.js";
import { deliverVerifierStep, replayVerifierStep } from "./evaluation-delivery.js";

const candidateInputSchema = z.object({
  issueId: uuidSchema,
  schemaVersion: z.literal(1),
  checks: z.array(addendumCheckSchema).min(1).refine(
    (checks) => new Set(checks.map((check) => check.checkId)).size === checks.length, "quality_duplicate_entry"),
}).strict();

export type StoredCandidate = {
  candidateVersionId: string; bodyRef: ArtifactRef;
  evaluationId: string; verifierIssueId: string; verifierStepRunId: string;
};

type CandidateContract = { bodyHash: string; bodyRef: ArtifactRef; checks: AddendumCheck[]; authors: string[] };

function candidateContract(row: typeof evaluatorVersions.$inferSelect): CandidateContract {
  const contract = row.qualityContract as unknown;
  const parsed = z.object({
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/), bodyRef: z.object({ attachmentId: z.string(), sha256: z.string() }),
    checks: z.array(addendumCheckSchema), authors: z.array(z.string().uuid()),
  }).passthrough().safeParse(contract);
  if (!parsed.success || (contract as { kind?: unknown }).kind !== "candidate") throw conflict("quality_candidate_contract_missing");
  return { ...parsed.data, bodyRef: parsed.data.bodyRef as ArtifactRef };
}

export async function loadQualityPolicy(db: Db, companyId: string, policyVersionId: string): Promise<QualityPolicy> {
  const [row] = await db.select({ definition: qualityPolicyVersions.definition }).from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, companyId), eq(qualityPolicyVersions.id, policyVersionId)));
  if (!row) throw conflict("quality_policy_inactive");
  return parseEvidence(qualityPolicySchema, row.definition);
}

/** 인증 agent 의 살아 있는 실행 binding: 회사·run·checkout·세대·epoch 를 매번 확인한다. */
export async function assertAgentStepAttempt(db: Db, actor: QualityAgentActor, expected: {
  issueId: string; stepRunId: string; generation: number;
}): Promise<void> {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, actor.companyId),
    eq(heartbeatRuns.id, actor.heartbeatRunId),
    eq(heartbeatRuns.agentId, actor.agentId),
  ));
  if (!run || run.executionEpoch !== actor.executionEpoch || run.issueId !== expected.issueId
    || run.workflowStepRunId !== expected.stepRunId || run.workflowExecutionGeneration !== expected.generation
    || !["queued", "running"].includes(run.status)) throw unprocessable("quality_attempt_binding_mismatch");
  const [issue] = await db.select({ checkoutRunId: issues.checkoutRunId }).from(issues)
    .where(and(eq(issues.companyId, actor.companyId), eq(issues.id, expected.issueId)));
  if (!issue || issue.checkoutRunId !== actor.heartbeatRunId) throw conflict("quality_step_checkout_required");
}

export async function submitQualityCandidate(db: Db, actorInput: unknown, input: unknown): Promise<StoredCandidate> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const value = parseEvidence(candidateInputSchema, input);
  const [issue] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, actor.companyId), eq(issues.id, value.issueId)));
  if (!issue) throw notFound("quality_action_not_found");
  const [action] = await db.select().from(qualityActions).where(and(
    eq(qualityActions.companyId, actor.companyId),
    eq(qualityActions.kind, "qa_addendum"),
    sql`${qualityActions.canonicalBinding}->>'issueId' = ${value.issueId}`,
  )).limit(1);
  if (!action) throw notFound("quality_action_not_found");
  if (action.cancelRequestedAt) throw conflict("quality_action_cancelled");
  const target = action.target;
  if (target.kind !== "qa_addendum") throw conflict("quality_action_kind_mismatch");
  const binding = action.canonicalBinding!;
  const policy = await loadQualityPolicy(db, actor.companyId, action.policyVersionId);
  if (!policy.authorAgentIds.includes(actor.agentId)) throw forbidden("quality_author_role_required");
  const [stepRunRow] = await db.select({ generation: workflowStepRuns.executionGeneration })
    .from(workflowStepRuns).where(eq(workflowStepRuns.id, binding.stepRunId));
  if (!stepRunRow) throw notFound("quality_action_not_found");
  await assertAgentStepAttempt(db, actor, { issueId: value.issueId, stepRunId: binding.stepRunId, generation: stepRunRow.generation });

  const policyTarget = policy.targets.find((t) => t.templateId === target.templateId && t.baseHash === target.baseHash);
  if (!policyTarget) throw conflict("quality_policy_target_unavailable");
  const baseCheckIds = new Set(policyTarget.required.map((check) => check.checkId));
  for (const check of value.checks) {
    if (baseCheckIds.has(check.checkId)) throw conflict("quality_candidate_check_conflict");
    for (const ref of check.requirementRefs) {
      if (!policy.requirementSourceRefs.some((source) => source.attachmentId === ref.attachmentId && source.sha256 === ref.sha256)) {
        throw unprocessable("quality_requirement_source_unapproved");
      }
    }
  }

  const bodyHash = hashContract({ schemaVersion: 1, checks: value.checks });
  const versions = await db.select().from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, actor.companyId), eq(evaluatorVersions.qualityActionId, action.id)))
    .orderBy(asc(evaluatorVersions.createdAt), asc(evaluatorVersions.id));
  const authors = new Set<string>(policy.authorAgentIds);
  for (const version of versions) {
    const contract = candidateContract(version);
    if (contract.bodyHash === bodyHash) return replayStoredCandidate(db, actor.companyId, action.id, version.id);
    for (const check of value.checks) {
      if (contract.checks.some((prior) => prior.checkId === check.checkId && hashContract(prior) !== hashContract(check))) {
        throw conflict("quality_candidate_body_immutable");
      }
    }
    for (const author of contract.authors) authors.add(author);
  }
  if (versions.length >= policy.maxCandidatesPerAction) throw conflict("quality_candidate_limit");
  const verifierAgentId = policy.verifierAgentIds.find((id) => !authors.has(id));
  if (!verifierAgentId) throw conflict("quality_verifier_unavailable");

  const bodyBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, checks: value.checks }));
  const uploaded = await uploadEvidence(getStorageService(), { companyId: actor.companyId, body: bodyBytes, contentType: "application/json", originalFilename: null });
  const candidateVersionId = randomUUID();
  const evaluationId = randomUUID();
  const steps = buildQualityVerificationSteps({ actionIntentKey: action.intentKey, verifierAgentId });
  const committed = await db.transaction(async (tx) => {
    await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
      .where(and(eq(qualityPolicyUsage.companyId, actor.companyId), eq(qualityPolicyUsage.policyVersionId, action.policyVersionId)))
      .orderBy(asc(qualityPolicyUsage.windowStart)).for("update");
    await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups)
      .where(and(eq(qualityActionGroups.companyId, actor.companyId), eq(qualityActionGroups.id, action.groupId))).for("update");
    const [locked] = await tx.select({ id: qualityActions.id, cancelRequestedAt: qualityActions.cancelRequestedAt })
      .from(qualityActions).where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, action.id))).for("update");
    if (!locked || locked.cancelRequestedAt) throw conflict("quality_action_cancelled");
    const bodyRef = await attachEvidence(tx, { companyId: actor.companyId, issueId: value.issueId, uploaded });
    await tx.insert(evaluatorVersions).values({
      id: candidateVersionId, companyId: actor.companyId, qualityActionId: action.id,
      qualityContract: {
        schemaVersion: 1, kind: "candidate", actionId: action.id,
        templateId: target.templateId, baseHash: target.baseHash, requirementVersionId: target.requirementVersionId,
        bodyHash, bodyRef, checks: value.checks, authors: [actor.agentId],
      },
      name: `quality-candidate-${action.intentKey}-${candidateVersionId.slice(0, 8)}`,
      status: "candidate",
    });
    const isolated = (await instanceSettingsService(tx as unknown as Db).getExperimental()).enableIsolatedWorkspaces;
    const definition = await findOrCreateImmutableQualityWorkflowDefinition(tx, { companyId: actor.companyId, missionId: binding.missionId, steps });
    const [run] = await tx.insert(workflowRuns).values({
      id: randomUUID(), companyId: actor.companyId, workflowId: definition.id, missionId: binding.missionId,
      status: "pending", triggeredBy: "quality",
      metadata: { qualityActionId: action.id, evaluationId },
    }).returning();
    const stepRun = await createWorkflowStepRunRecord(tx, { workflowRunId: run!.id, stepId: steps[0]!.id, metadata: { qualityActionId: action.id, evaluationId } });
    const verifierIssue = await createIssueRecord(tx, actor.companyId, {
      title: steps[0]!.name!, description: steps[0]!.description ?? null,
      status: "todo", assigneeAgentId: verifierAgentId, missionId: binding.missionId,
      originKind: "workflow_execution", originId: run!.id, originRunId: run!.id, labelIds: [],
    }, isolated);
    await bindWorkflowStepIssueRecord(tx, { companyId: actor.companyId, stepRunId: stepRun.id, issueId: verifierIssue.id });
    await tx.insert(evaluatorCandidateRuns).values({
      id: evaluationId, companyId: actor.companyId, qualityActionId: action.id,
      evaluatorVersionId: candidateVersionId, status: "queued",
      qualityContract: {
        schemaVersion: 1, kind: "evaluation", actionId: action.id, candidateVersionId, checks: value.checks,
        verifier: {
          agentId: verifierAgentId,
          step: {
            issueId: verifierIssue.id, stepRunId: stepRun.id, workflowRunId: run!.id,
            generation: stepRun.executionGeneration,
            // 생성된 run 행의 실제 값(returning) — 검증 영수증 교차검증이 소비한다.
            dispatchAuthorityVersion: run!.dispatchAuthorityVersion,
          },
          run: null,
        },
        authorRun: { heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch },
        invocationIndex: {}, invocations: {}, reads: {}, submissions: {}, resubmissions: {},
        verdict: null,
      },
    });
    const rows = await tx.update(qualityActions).set({ currentEvaluationId: evaluationId, updatedAt: new Date() })
      .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, action.id))).returning({ id: qualityActions.id });
    if (!rows.length) throw conflict("quality_action_cancelled");
    await tx.insert(activityLog).values({
      companyId: actor.companyId, actorType: "system", actorId: "quality",
      action: "quality.candidate_submitted", entityType: "evaluator_version", entityId: candidateVersionId,
      details: { actionId: action.id, evaluationId, verifierIssueId: verifierIssue.id, bodyHash },
    });
    return { verifierIssueId: verifierIssue.id, verifierStepRunId: stepRun.id, generation: stepRun.executionGeneration, workflowRunId: run!.id, bodyRef };
  });

  // 커밋 후 깨우기 — §3.3 규칙5: 실패(false) 시 같은 intent(같은 idempotencyKey)로 재조회·재시도하고
  // 계속 전달되지 않으면 구조화 activity 행으로 기록한다(아래 deliverVerifierStep).
  await deliverVerifierStep(db, {
    companyId: actor.companyId, actionId: action.id, evaluationId,
    workflowRunId: committed.workflowRunId, verifierStepRunId: committed.verifierStepRunId,
    verifierIssueId: committed.verifierIssueId, generation: committed.generation,
  });
  return {
    candidateVersionId, bodyRef: committed.bodyRef, evaluationId,
    verifierIssueId: committed.verifierIssueId, verifierStepRunId: committed.verifierStepRunId,
  };
}

/** [§3.3 규칙5] 같은 intent(같은 idempotencyKey)의 전달은 evaluation-delivery 가 담당한다. */
async function replayStoredCandidate(db: Db, companyId: string, actionId: string, versionId: string): Promise<StoredCandidate> {
  const [version] = await db.select().from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, companyId), eq(evaluatorVersions.id, versionId)));
  const contract = candidateContract(version!);
  const [evaluation] = await db.select().from(evaluatorCandidateRuns)
    .where(and(
      eq(evaluatorCandidateRuns.companyId, companyId),
      eq(evaluatorCandidateRuns.qualityActionId, actionId),
      eq(evaluatorCandidateRuns.evaluatorVersionId, versionId),
    )).orderBy(desc(evaluatorCandidateRuns.createdAt)).limit(1);
  if (!evaluation) throw conflict("quality_candidate_contract_missing");
  const step = replayVerifierStep(evaluation.qualityContract);
  await deliverVerifierStep(db, {
    companyId, actionId, evaluationId: evaluation.id,
    workflowRunId: step.workflowRunId, verifierStepRunId: step.stepRunId,
    verifierIssueId: step.issueId, generation: step.generation,
  });
  return { candidateVersionId: versionId, bodyRef: contract.bodyRef, evaluationId: evaluation.id, verifierIssueId: step.issueId, verifierStepRunId: step.stepRunId };
}

/** 현재 evaluation 의 판정 상태. 적용 자격은 이 값(currentEvaluationId 기준)뿐이다. */
export async function readCurrentEvaluationVerdict(db: Db, key: { companyId: string; actionId: string }): Promise<{ evaluationId: string; status: "pass" | "fail" | "no_improvement" | "pending" } | null> {
  const [action] = await db.select({ currentEvaluationId: qualityActions.currentEvaluationId }).from(qualityActions)
    .where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, key.actionId)));
  if (!action?.currentEvaluationId) return null;
  const [row] = await db.select().from(evaluatorCandidateRuns)
    .where(and(eq(evaluatorCandidateRuns.companyId, key.companyId), eq(evaluatorCandidateRuns.id, action.currentEvaluationId)));
  if (!row) return null;
  const verdict = (row.qualityContract as { verdict?: { status?: "pass" | "fail" | "no_improvement" } | null }).verdict;
  return { evaluationId: row.id, status: verdict?.status ?? "pending" };
}

/** [T6 완료 게이트] generic workflow 완료는 전용 근거 없이 author/verifier 단계를 끝낼 수 없다. */
export async function assertQualityStepCompletionAllowed(db: Db, input: { companyId: string; issueId: string }): Promise<void> {
  const [authorAction] = await db.select({ id: qualityActions.id }).from(qualityActions).where(and(
    eq(qualityActions.companyId, input.companyId),
    eq(qualityActions.kind, "qa_addendum"),
    sql`${qualityActions.canonicalBinding}->>'issueId' = ${input.issueId}`,
  )).limit(1);
  if (authorAction) {
    const [version] = await db.select({ id: evaluatorVersions.id }).from(evaluatorVersions)
      .where(and(eq(evaluatorVersions.companyId, input.companyId), eq(evaluatorVersions.qualityActionId, authorAction.id))).limit(1);
    if (!version) throw conflict("quality_candidate_missing");
  }
  const [evaluation] = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, input.companyId),
    sql`${evaluatorCandidateRuns.qualityContract}->'verifier'->'step'->>'issueId' = ${input.issueId}`,
  )).orderBy(desc(evaluatorCandidateRuns.createdAt)).limit(1);
  if (evaluation && !(evaluation.qualityContract as { verdict?: unknown }).verdict) throw conflict("quality_evaluation_verdict_missing");
}
