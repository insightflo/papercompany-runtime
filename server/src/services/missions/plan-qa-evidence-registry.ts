import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { activityLog, qualityReviewItems } from "@paperclipai/db";
import { planQaScopeSchema, type ArtifactRef, type PlanQaScope, type SourceAttempt } from "@paperclipai/shared";
import type { PutFileResult } from "../../storage/index.js";
import { evidenceError, hashContract, type QualityDb, type QualityTx } from "../quality/contract.js";
import { linkEvidence, readEvidence, resolveEvidence } from "../quality/evidence-store.js";
import { assertCurrentPlanQaScope } from "./plan-qa-current-attempt.js";

const ISSUER = "mission-plan-qa";
const reviewBindingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("plan_qa_evidence_review"), scope: planQaScopeSchema,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

async function registryBinding(db: QualityDb, scope: PlanQaScope) {
  const { marker } = await assertCurrentPlanQaScope(db, scope);
  const binding = reviewBindingSchema.parse({ schemaVersion: 1, kind: "plan_qa_evidence_review", scope, inputHash: marker.inputHash });
  const source: SourceAttempt = {
    companyId: scope.companyId, issueId: scope.issueId, heartbeatRunId: scope.heartbeatRunId,
    executionEpoch: scope.executionEpoch, inputHash: marker.inputHash,
    mission: { kind: "mission", id: scope.missionId },
    workflow: { kind: "not_applicable", reason: "not_a_workflow_source" },
  };
  return { binding, source };
}

/** Called only for a complete verified submission under the existing attempt lock.
 * The closed review indexes this actual review attempt; it creates no pending work or failure finding.
 */
export async function linkPlanQaGateEvidence(tx: QualityTx, input: {
  scope: PlanQaScope; submission: PutFileResult; receipt: PutFileResult;
}) {
  const { scope } = input;
  const { binding, source } = await registryBinding(tx, scope);
  const [review] = await tx.insert(qualityReviewItems).values({
    companyId: scope.companyId, missionId: scope.missionId, title: "PLAN-QA verified review evidence",
    status: "closed", targetType: "other", targetId: scope.issueId,
    triggerSource: "plan_qa_review", triggerMetadata: binding,
  }).returning({ id: qualityReviewItems.id });
  await tx.insert(activityLog).values({ companyId: scope.companyId, actorType: "system", actorId: ISSUER,
    action: "mission.plan_qa.evidence_review_recorded", entityType: "quality_review_item", entityId: review.id,
    details: { issueId: scope.issueId, heartbeatRunId: scope.heartbeatRunId, executionEpoch: scope.executionEpoch } });
  const shared = { companyId: scope.companyId, reviewItemId: review.id, source, scope, issuedBy: ISSUER, expiresAt: null };
  const submission = await linkEvidence(tx, { ...shared, kind: "submission", uploaded: input.submission });
  const receipt = await linkEvidence(tx, { ...shared, kind: "evaluation", uploaded: input.receipt, originalRef: submission.ref });
  return { submissionRef: submission.ref, receiptRef: receipt.ref, evidenceRefId: receipt.evidenceRefId };
}

/** Exact registry IDs, original linkage, canonical review ownership, and source bytes are all required. */
export async function readPlanQaGateEvidence(db: QualityDb, input: {
  scope: PlanQaScope; evidenceRefId: string; receiptRef: ArtifactRef; submissionRef: ArtifactRef;
}) {
  const { scope } = input;
  const { binding, source } = await registryBinding(db, scope);
  const receipt = await resolveEvidence(db, scope.companyId, input.receiptRef);
  const submission = await resolveEvidence(db, scope.companyId, input.submissionRef);
  if (receipt.receipt.id !== input.evidenceRefId || receipt.contract.kind !== "evaluation"
    || hashContract(receipt.contract.originalRef) !== hashContract(input.submissionRef)
    || submission.contract.kind !== "submission" || submission.contract.originalRef !== null
    || submission.receipt.reviewItemId !== receipt.receipt.reviewItemId) evidenceError("quality_plan_qa_registry_mismatch");
  const [review] = await db.select().from(qualityReviewItems).where(and(
    eq(qualityReviewItems.companyId, scope.companyId), eq(qualityReviewItems.id, receipt.receipt.reviewItemId),
  )).limit(1);
  const parsed = reviewBindingSchema.safeParse(review?.triggerMetadata);
  if (!review || review.missionId !== scope.missionId || review.targetType !== "other" || review.targetId !== scope.issueId
    || review.triggerSource !== "plan_qa_review" || !parsed.success || hashContract(parsed.data) !== hashContract(binding)) {
    evidenceError("quality_plan_qa_registry_mismatch");
  }
  for (const evidence of [receipt, submission]) {
    if (hashContract(evidence.contract.source) !== hashContract(source) || hashContract(evidence.contract.scope) !== hashContract(scope)
      || evidence.contract.issuedBy !== ISSUER || evidence.receipt.collectedByActorType !== "system"
      || evidence.receipt.collectedByActorId !== ISSUER || evidence.receipt.surface !== "attachment") {
      evidenceError("quality_plan_qa_registry_mismatch");
    }
  }
  const read = (ref: ArtifactRef) => readEvidence(db, { companyId: scope.companyId, scope, ref, maxBytes: 2_097_152 });
  return { submissionBytes: await read(input.submissionRef), receiptBytes: await read(input.receiptRef) };
}
