import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, qualityActions, qualityEvidenceRefs, missionPlanArtifacts, evaluatorCandidateRuns } from "@paperclipai/db";
import { evidenceScopeSchema, sourceAttemptSchema, uuidSchema, type EvidenceScope, type SourceAttempt } from "@paperclipai/shared";
import { evidenceContractSchema, evidenceError, hashContract, parseEvidence, type EvidenceContract, type QualityDb } from "./contract.js";
import { conflict } from "../../errors.js";

export async function verifySourceAttempt(db: QualityDb, companyId: string, value: SourceAttempt): Promise<void> {
  const source = parseEvidence(sourceAttemptSchema, value);
  if (source.companyId !== companyId) evidenceError("quality_scope_company_mismatch");
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, source.issueId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, source.heartbeatRunId)));
  if (!issue || !run || run.issueId !== issue.id || run.executionEpoch !== source.executionEpoch) evidenceError("quality_evidence_scope_mismatch");
  if (issue.hiddenAt) evidenceError("quality_evidence_archived");
  const missionId = source.mission.kind === "mission" ? source.mission.id : null;
  if (issue.missionId !== missionId) evidenceError("quality_evidence_scope_mismatch");
  if (missionId) await verifyMission(db, companyId, missionId);
  if (source.workflow.kind === "not_applicable") {
    if (run.workflowStepRunId !== null) evidenceError("quality_evidence_scope_mismatch");
  } else {
    const wf = source.workflow;
    const workflow = await verifyWorkflow(db, companyId, wf.runId, wf.stepRunId, issue.id, wf.generation, missionId);
    if (workflow.dispatchAuthorityVersion !== wf.dispatchAuthorityVersion || run.workflowStepRunId !== wf.stepRunId || run.workflowExecutionGeneration !== wf.generation) evidenceError("quality_evidence_scope_mismatch");
  }
}

async function verifyMission(db: QualityDb, companyId: string, id: string) {
  const [mission] = await db.select({ id: missions.id }).from(missions).where(and(eq(missions.companyId, companyId), eq(missions.id, id)));
  if (!mission) evidenceError("quality_evidence_scope_mismatch");
}

async function verifyWorkflow(db: QualityDb, companyId: string, runId: string, stepId: string, issueId: string, generation: number, missionId: string | null) {
  const [workflow] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, runId)));
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.id, stepId)));
  if (!workflow || !step || step.issueId !== issueId || step.executionGeneration !== generation || workflow.missionId !== missionId) evidenceError("quality_evidence_scope_mismatch");
  return workflow;
}

export async function verifyEvidenceScope(db: QualityDb, companyId: string, value: EvidenceScope): Promise<void> {
  const scope = parseEvidence(evidenceScopeSchema, value);
  if (scope.companyId !== companyId) evidenceError("quality_scope_company_mismatch");
  if (scope.kind === "output_correction") {
    await verifySourceAttempt(db, companyId, scope.source);
    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, scope.actionId)));
    const [verifier] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, scope.verifierRunId)));
    if (!action || action.kind !== "current_output" || action.target.kind !== "current_output" || hashContract(action.target.source) !== hashContract(scope.source) || !verifier || verifier.executionEpoch !== scope.verifierEpoch) evidenceError("quality_evidence_scope_mismatch");
    const binding = action.canonicalBinding;
    if (binding) {
      if (binding.companyId !== companyId || binding.actionId !== action.id || verifier.issueId !== binding.issueId || verifier.workflowStepRunId !== binding.stepRunId || verifier.workflowExecutionGeneration === null) evidenceError("quality_evidence_scope_mismatch");
      await verifyWorkflow(db, companyId, binding.workflowRunId, binding.stepRunId, binding.issueId, verifier.workflowExecutionGeneration, binding.missionId);
    } else if (verifier.issueId !== scope.source.issueId) evidenceError("quality_evidence_scope_mismatch");
    return;
  }
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, scope.issueId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, scope.heartbeatRunId)));
  if (!issue || !run || issue.missionId !== scope.missionId || run.issueId !== issue.id || run.executionEpoch !== scope.executionEpoch) evidenceError("quality_evidence_scope_mismatch");
  if (issue.hiddenAt) evidenceError("quality_evidence_archived");
  await verifyMission(db, companyId, scope.missionId);
  if (scope.kind === "plan_qa") {
    const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.id, scope.planArtifactId), eq(missionPlanArtifacts.missionId, scope.missionId)));
    if (!plan || run.workflowStepRunId !== null) evidenceError("quality_evidence_scope_mismatch");
    if (plan.status !== "active") evidenceError("quality_evidence_archived");
    return;
  }
  await verifyWorkflow(db, companyId, scope.workflowRunId, scope.stepRunId, scope.issueId, scope.generation, scope.missionId);
  const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, scope.actionId)));
  const [evaluation] = await db.select().from(evaluatorCandidateRuns).where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, scope.evaluationId), eq(evaluatorCandidateRuns.qualityActionId, scope.actionId)));
  if (!action || !evaluation || action.currentEvaluationId !== scope.evaluationId || run.workflowStepRunId !== scope.stepRunId || run.workflowExecutionGeneration !== scope.generation) evidenceError("quality_evidence_scope_mismatch");
}

// --- T9 적용·철회 영수증 계약 -----------------------------------------------
// 적용(adoption)/철회(rollback) 영수증은 기존 evidence 원장(quality_evidence_refs)의 한 kind 다.
// 별도 테이블·워커를 만들지 않고, 서버가 생산한 원본 bytes 를 계약 schema 로만 해석한다.

export const MAX_QUALITY_RECEIPT_BYTES = 262_144;
const receiptSha256 = z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256");
const receiptInstant = z.string().datetime();

export const adoptionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("adoption"),
  actionId: uuidSchema, intentKey: z.string().min(1).max(200),
  templateId: uuidSchema, baseHash: receiptSha256,
  newVersionId: uuidSchema,
  evaluationId: uuidSchema, evaluationEvidenceRefId: uuidSchema,
  policyVersionId: uuidSchema, scopeVersion: z.number().int().safe().min(0),
  appliedAt: receiptInstant,
}).strict();
export type AdoptionReceipt = z.infer<typeof adoptionReceiptSchema>;

export const rollbackReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("rollback"),
  bindingId: uuidSchema, templateId: uuidSchema, baseHash: receiptSha256,
  badVersionId: uuidSchema, restoredVersionId: uuidSchema.nullable(),
  failureEvidenceRefId: uuidSchema, withdrawnAt: receiptInstant,
}).strict();
export type RollbackReceipt = z.infer<typeof rollbackReceiptSchema>;

/** quality_evidence_refs 행을 회사 스코프로 읽고 계약을 파싱하며, kind 와 검증 상태를 강제한다. */
export async function loadEvidenceReceipt(db: QualityDb, companyId: string, evidenceRefId: string,
  kind: EvidenceContract["kind"]): Promise<{ receipt: typeof qualityEvidenceRefs.$inferSelect; contract: EvidenceContract }> {
  const [receipt] = await db.select().from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, companyId), eq(qualityEvidenceRefs.id, evidenceRefId)));
  if (!receipt) evidenceError("quality_evidence_missing");
  const contract = parseEvidence(evidenceContractSchema, receipt.qualityContract);
  if (contract.kind !== kind) evidenceError("quality_evidence_kind_mismatch");
  if (receipt.status !== "verified") evidenceError("quality_evidence_unverified");
  return { receipt, contract };
}

/**
 * [brief 계약] 응답 유실 재요청 복구: 이 조치가 현재 평가(evaluationId)로 이미 커밋한 adoption 영수증을
 * evidence 원장(회사+action 스코프)에서 찾는다. 활성 연결이 다른 버전으로 바뀌었거나 철회된 뒤에도
 * 원본 identity(evidenceRefId·적용 시점 revision)를 그대로 돌려준다 — 연결을 되돌리거나 철회된 버전을
 * 재활성화하는 근거로 쓰지 않는다. 적용 시점 revision 은 같은 tx 에 기록된 activity_log 구조화 details
 * 에서만 복구하며, 원장·감사 증거가 어긋나면 실패 종결한다. 원래 영수증이 없으면 null(신규 적용)이다.
 */
export async function findOriginalAdoptionReceipt(db: QualityDb, input: {
  companyId: string; actionId: string; bindingId: string; evaluationId: string;
}): Promise<{ bindingId: string; revision: number; evidenceRefId: string } | null> {
  const rows = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract })
    .from(qualityEvidenceRefs)
    .where(and(
      eq(qualityEvidenceRefs.companyId, input.companyId),
      eq(qualityEvidenceRefs.qualityActionId, input.actionId),
      sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'adoption'`,
    ))
    .orderBy(asc(qualityEvidenceRefs.createdAt), asc(qualityEvidenceRefs.id));
  for (const row of rows) {
    const contract = parseEvidence(evidenceContractSchema, row.contract);
    if (contract.scope?.kind !== "evaluation" || contract.scope.evaluationId !== input.evaluationId) continue;
    await loadEvidenceReceipt(db, input.companyId, row.id, "adoption");
    const audits = await db.select({ details: activityLog.details }).from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "quality_consumer_binding"),
        eq(activityLog.entityId, input.bindingId),
      ))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    for (const audit of audits) {
      const details = audit.details as { actionId?: unknown; evaluationId?: unknown; revision?: unknown } | null;
      if (details?.actionId === input.actionId && details.evaluationId === input.evaluationId
        && typeof details.revision === "number") {
        return { bindingId: input.bindingId, revision: details.revision, evidenceRefId: row.id };
      }
    }
    throw conflict("quality_adoption_replay_unrecoverable");
  }
  return null;
}
