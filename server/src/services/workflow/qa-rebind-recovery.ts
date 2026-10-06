import { and, eq } from "drizzle-orm";
import { workflowQaRebindClaims, workflowRuns, type Db } from "@paperclipai/db";
import { retryIssueLessToolWorkflowStep } from "./dag-engine.js";
import { isQaRebindRecoveryEnabled } from "./qa-rebind-recovery-flag.js";
import { logger } from "../../middleware/logger.js";

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
    }
  }
}
