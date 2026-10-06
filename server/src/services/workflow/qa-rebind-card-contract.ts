import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { activityLog, operatorDecisions, workflowQaRebindClaims, type Db } from "@paperclipai/db";
import { workflowQaRebindExpectedDigestsSchema } from "@paperclipai/shared/validators/workflow-qa-rebind";
import { validateOperatorDecisionResult } from "../operator-decision-result.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { readQaRebindContext } from "./qa-rebind-evidence.js";
import type { QaRebindRecoveryIntent } from "./qa-rebind-recovery-intent.js";
import { logger } from "../../middleware/logger.js";

export const QA_REBIND_CARD_SOURCE_TYPE = "workflow_qa_rebind";
export type QaRebindClaim = typeof workflowQaRebindClaims.$inferSelect;
const targetChangedSchema = z.object({ schemaVersion: z.literal("workflow.qa-rebind-card-outcome.v1"),
  outcome: z.literal("target_changed"), candidateId: z.string().uuid(), approvalTargetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Only a schema-validated native receipt can retire an approval; generic audit prose cannot. */
export async function qaRebindCardTargetChanged(db: Pick<Db, "select">, candidate: QaRebindClaim,
  decisionId: string, approvalTargetHash: string) {
  const rows = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, candidate.companyId), eq(activityLog.entityId, decisionId),
    eq(activityLog.entityType, "operator_decision"), eq(activityLog.actorType, "system"), eq(activityLog.actorId, "qa-rebind-card"),
    eq(activityLog.action, "workflow.qa_rebind_target_changed")));
  return rows.some(row => {
    const parsed = targetChangedSchema.safeParse(row.details);
    return parsed.success && parsed.data.candidateId === candidate.id && parsed.data.approvalTargetHash === approvalTargetHash;
  });
}
const sourceIdSchema = z.string().regex(/^qrb1:[a-f0-9-]{36}:[a-f0-9]{64}$/).transform(value => {
  const [, candidateId, approvalTargetHash] = value.split(":");
  return { schemaVersion: "workflow.qa-rebind-card.v1" as const, candidateId, approvalTargetHash };
}).pipe(z.object({ schemaVersion: z.literal("workflow.qa-rebind-card.v1"), candidateId: z.string().uuid(),
  approvalTargetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict());

export function qaRebindApprovalTargetHash(target: Pick<QaRebindClaim, "bundleDigest" | "expectedDigests" | "authorityVersion" | "executionGeneration">) {
  const expected = target.expectedDigests === null ? null : workflowQaRebindExpectedDigestsSchema.parse(target.expectedDigests);
  return hashStructuredValue({ expectedDigests: { bundleDigest: target.bundleDigest,
    sha256: expected?.sha256 ?? null, byteSize: expected?.byteSize ?? null },
    authorityVersion: target.authorityVersion, executionGeneration: target.executionGeneration });
}
export function qaRebindCardRequestKey(runId: string, stepId: string, approvalTargetHash: string) {
  // The public contract bounds keys to 160 characters and ASCII stable IDs.
  const stepKey = stepId.length <= 52 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(stepId)
    ? stepId : hashStructuredValue(stepId).slice(0, 32);
  return `qrb1:${runId}:${stepKey}:${approvalTargetHash}`;
}
export function qaRebindCardSourceId(candidateId: string, approvalTargetHash: string) {
  const sourceId = `qrb1:${candidateId}:${approvalTargetHash}`;
  sourceIdSchema.parse(sourceId);
  return sourceId;
}

/** Dedicated machine-produced versioned identity, never labels, comments or error prose. */
export function readQaRebindCard(row: typeof operatorDecisions.$inferSelect, candidate: QaRebindClaim) {
  const identity = sourceIdSchema.safeParse(row.sourceId);
  if (!identity.success || row.companyId !== candidate.companyId || row.sourceType !== QA_REBIND_CARD_SOURCE_TYPE
    || identity.data.candidateId !== candidate.id || row.issueId !== null || row.continuationMode !== "none" || row.interactionType !== "single_select"
    || row.sourceContext.workflowRunId !== candidate.workflowRunId
    || row.requestKey !== qaRebindCardRequestKey(candidate.workflowRunId, candidate.consumerStepId, identity.data.approvalTargetHash)) return null;
  let selection: "approve" | "dismiss" | null = null;
  if (row.status === "resolved" && row.result) {
    try {
      const result = validateOperatorDecisionResult(row.definition, { actionId: row.result.actionId,
        selectedOptionIds: row.result.selectedOptionIds, comment: null });
      if (result.actionId === "submit" && result.outcome === "submit" && row.result.outcome === result.outcome
        && result.selectedOptionIds.length === 1 && ["approve", "dismiss"].includes(result.selectedOptionIds[0]))
        selection = result.selectedOptionIds[0] as "approve" | "dismiss";
    } catch { return null; }
  }
  return { ...identity.data, selection };
}

/** Caller holds mission → run → steps. This does not claim, reset, wake or continue. */
export async function validateQaRebindCardApproval(db: Db, input: {
  companyId: string; runId: string; stepId: string; qaRebind: QaRebindRecoveryIntent;
}, recordChange = false): Promise<boolean> {
  const decisionId = input.qaRebind.operatorDecisionId;
  if (!decisionId) return false;
  const [candidate] = await db.select().from(workflowQaRebindClaims).where(and(
    eq(workflowQaRebindClaims.companyId, input.companyId), eq(workflowQaRebindClaims.workflowRunId, input.runId),
    eq(workflowQaRebindClaims.consumerStepId, input.stepId), eq(workflowQaRebindClaims.id, input.qaRebind.candidateId),
    eq(workflowQaRebindClaims.status, "card_required")));
  const [card] = await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId), eq(operatorDecisions.id, decisionId)));
  if (!candidate || !card) return false;
  const authority = readQaRebindCard(card, candidate);
  if (authority?.selection !== "approve") return false;
  if (await qaRebindCardTargetChanged(db, candidate, card.id, authority.approvalTargetHash)) return false;
  const c = await readQaRebindContext(db, { companyId: input.companyId, workflowRunId: input.runId,
    consumerStepRunId: candidate.consumerStepRunId });
  const matches = c && authority.approvalTargetHash === qaRebindApprovalTargetHash({ bundleDigest: c.bundleDigest,
    expectedDigests: c.expectedDigests, authorityVersion: c.run.dispatchAuthorityVersion, executionGeneration: c.step.executionGeneration })
    && !c.rows.some(({ step }) => step.metadata.failureCascadeSkipped === true);
  if (matches) return true;
  if (recordChange) {
    // Audit failure cannot abort authoritative state; the approval still fails closed.
    try {
      await db.transaction(async tx => {
        if (!await qaRebindCardTargetChanged(tx, candidate, card.id, authority.approvalTargetHash)) await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "system", actorId: "qa-rebind-card",
          action: "workflow.qa_rebind_target_changed", entityType: "operator_decision", entityId: card.id,
          details: { schemaVersion: "workflow.qa-rebind-card-outcome.v1", outcome: "target_changed", candidateId: candidate.id,
            approvalTargetHash: authority.approvalTargetHash } });
      });
    } catch (err) { logger.warn({ err, decisionId }, "QA rebind target-change audit deferred"); }
  }
  return false;
}
