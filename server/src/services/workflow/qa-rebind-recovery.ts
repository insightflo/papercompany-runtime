import { and, eq, sql } from "drizzle-orm";
import { activityLog, workflowQaRebindClaims, workflowRuns, type Db } from "@paperclipai/db";
import { retryIssueLessToolWorkflowStep } from "./dag-engine.js";
import { isQaRebindRecoveryEnabled } from "./qa-rebind-recovery-flag.js";
import { logger } from "../../middleware/logger.js";

/** Failed auto-recovery attempts are bounded; exhaustion hands the claim to the operator card sweep. */
const QA_REBIND_RECOVERY_ATTEMPT_LIMIT = 3;

/** Attempt accounting shares no transaction with recovery: increments only ever touch a still-eligible claim. */
async function recordQaRebindRecoveryFailure(db: Db, companyId: string, candidateId: string) {
  try {
    await db.transaction(async tx => {
      // Guarded increment: reconciliation, a claimed win, or a prior escalation may have moved the claim first.
      const [bumped] = await tx.update(workflowQaRebindClaims)
        .set({ recoveryAttempts: sql`${workflowQaRebindClaims.recoveryAttempts} + 1`, updatedAt: new Date() })
        .where(and(eq(workflowQaRebindClaims.companyId, companyId), eq(workflowQaRebindClaims.id, candidateId),
          eq(workflowQaRebindClaims.status, "auto_eligible"))).returning();
      if (!bumped || bumped.recoveryAttempts < QA_REBIND_RECOVERY_ATTEMPT_LIMIT) return;
      const [escalated] = await tx.update(workflowQaRebindClaims)
        .set({ status: "card_required", reasonCode: "recovery_attempts_exhausted", updatedAt: new Date() })
        .where(and(eq(workflowQaRebindClaims.companyId, companyId), eq(workflowQaRebindClaims.id, candidateId),
          eq(workflowQaRebindClaims.status, "auto_eligible")))
        .returning({ id: workflowQaRebindClaims.id, recoveryAttempts: workflowQaRebindClaims.recoveryAttempts });
      if (!escalated) return;
      await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: "qa-rebind-recovery",
        action: "workflow.qa_rebind_recovery_exhausted", entityType: "workflow_qa_rebind_claim", entityId: escalated.id,
        details: { schemaVersion: "workflow.qa-rebind-recovery-exhausted.v1", from: "auto_eligible", to: "card_required",
          reasonCode: "recovery_attempts_exhausted", attempts: escalated.recoveryAttempts } });
    });
  } catch (error) {
    // Best-effort accounting must never abort the remaining sweep candidates.
    logger.warn({ companyId, candidateId, err: error }, "QA rebind recovery attempt accounting deferred");
  }
}

/** Native sweep only. Delivery/restart recovery remains owned by the existing accepted-tool receipt path. */
export async function recoverAutoEligibleQaRebindCandidates(db: Db, companyId: string): Promise<void> {
  if (!await isQaRebindRecoveryEnabled(db, companyId)) return;
  const candidates = await db.select({ candidate: workflowQaRebindClaims }).from(workflowQaRebindClaims)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowQaRebindClaims.workflowRunId)).where(and(
      eq(workflowQaRebindClaims.companyId, companyId), eq(workflowRuns.companyId, companyId),
      eq(workflowQaRebindClaims.status, "auto_eligible"), eq(workflowRuns.status, "failed")));
  for (const { candidate: c } of candidates) {
    try {
      await retryIssueLessToolWorkflowStep(db, { companyId, runId: c.workflowRunId, stepId: c.consumerStepId,
        recoveryRequestReference: `qa-rebind:${c.id}`,
        expectedFailure: { stepRunId: c.consumerStepRunId, authorityVersion: c.authorityVersion,
          executionGeneration: c.executionGeneration, dispatchRequestId: c.requestId },
        qaRebind: { candidateId: c.id, bundleDigest: c.bundleDigest, authorityVersion: c.authorityVersion,
          executionGeneration: c.executionGeneration },
        // Flag checked again inside the locked transaction. Validation never writes a claim.
        validateIntent: tx => isQaRebindRecoveryEnabled(tx, companyId),
      });
    } catch (error) {
      // Rebind/DB/delivery failure leaves either untouched eligibility or a durable accepted receipt.
      logger.warn({ companyId, candidateId: c.id, err: error }, "QA rebind recovery deferred");
      await recordQaRebindRecoveryFailure(db, companyId, c.id);
    }
  }
}
