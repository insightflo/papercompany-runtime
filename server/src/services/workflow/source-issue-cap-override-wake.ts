import type { Db } from "@paperclipai/db";
import { wakeExistingWorkflowStepIssue, type WorkflowStep } from "./dag-engine.js";
import { findAcceptedWakeProof } from "./source-issue-cap-override-authority.js";
import { isCapOverrideWakeUniqueConflict } from "./cap-override-wakeup-conflict.js";

export async function enqueueCapOverrideWake(input: {
  db: Db;
  companyId: string;
  wakeKey: string;
  run: Parameters<typeof wakeExistingWorkflowStepIssue>[0]["run"];
  definition: Parameters<typeof wakeExistingWorkflowStepIssue>[0]["definition"];
  step: WorkflowStep;
  stepRunId: string;
  stepRunMetadata: Record<string, unknown>;
  issueId: string;
  allowBlockedIssue: boolean;
  existingProofId: string | null;
  wakeFn?: typeof wakeExistingWorkflowStepIssue;
}): Promise<{ proof: { id: string } | null; dispatched: boolean; failureReason: string }> {
  const wakeContext = {
    workflowRunId: input.run.id,
    stepRunId: input.stepRunId,
    issueId: input.issueId,
  };
  if (input.existingProofId) {
    const proof = await findAcceptedWakeProof(
      input.db,
      input.companyId,
      input.wakeKey,
      wakeContext,
      input.existingProofId,
    );
    if (proof) return { proof, dispatched: false, failureReason: "" };
  }

  let uniqueConflict = false;
  let wakeAccepted = false;
  let failureReason = "wake_not_accepted";
  try {
    wakeAccepted = await (input.wakeFn ?? wakeExistingWorkflowStepIssue)({
      db: input.db,
      run: input.run,
      definition: input.definition,
      step: input.step,
      stepRunId: input.stepRunId,
      stepRunMetadata: input.stepRunMetadata,
      issueId: input.issueId,
      allowBlockedIssue: input.allowBlockedIssue,
      idempotencyKey: input.wakeKey,
    });
  } catch (error) {
    uniqueConflict = isCapOverrideWakeUniqueConflict(error);
    failureReason = uniqueConflict ? "cap_wake_unique_conflict_without_exact_proof" : "wake_failed";
  }

  const proof = await findAcceptedWakeProof(input.db, input.companyId, input.wakeKey, wakeContext);
  if (proof) return { proof, dispatched: wakeAccepted && !uniqueConflict, failureReason: "" };
  return { proof: null, dispatched: false, failureReason };
}
