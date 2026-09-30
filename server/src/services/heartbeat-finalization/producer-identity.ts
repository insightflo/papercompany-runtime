import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import type { HeartbeatRun } from "./owner-capability.js";
import { producerAttempt } from "../work-products/producer-attempt.js";

/** Caller owns the claim/enqueue transaction. Never adopt current identity for a legacy wake. */
export async function readAdmittedWorkflowIdentity(db: Db, run: HeartbeatRun) {
  const reject = () => { throw conflict("heartbeat_workflow_identity_mismatch"); };
  if (!run.wakeupRequestId) {
    if (run.workflowStepRunId || run.workflowExecutionGeneration !== null) return reject();
    return null;
  }
  const [wake] = await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, run.wakeupRequestId)).for("share");
  if (!wake || wake.workflowExecutionGeneration === null) {
    if (run.workflowStepRunId !== null || run.workflowExecutionGeneration !== null) return reject();
    return null;
  }
  if (!wake.workflowStepRunId || !wake.workflowRunId || wake.companyId !== run.companyId
    || wake.agentId !== run.agentId || wake.issueId !== run.issueId || wake.runId !== run.id
    || wake.status === "coalesced" || !Number.isSafeInteger(wake.workflowExecutionGeneration)
    || wake.workflowExecutionGeneration < 0
    || (run.workflowStepRunId !== null && run.workflowStepRunId !== wake.workflowStepRunId)
    || (run.workflowExecutionGeneration !== null && run.workflowExecutionGeneration !== wake.workflowExecutionGeneration)) return reject();
  const [linked] = await db.select({ step: workflowStepRuns, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId, issueCompanyId: issues.companyId })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .leftJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .where(eq(workflowStepRuns.id, wake.workflowStepRunId)).for("share", { of: workflowStepRuns });
  if (!linked || linked.companyId !== run.companyId || linked.step.workflowRunId !== wake.workflowRunId
    || linked.step.issueId !== run.issueId || (run.issueId && linked.issueCompanyId !== run.companyId)
    || linked.step.executionGeneration !== wake.workflowExecutionGeneration || linked.missionId !== wake.missionId) return reject();
  try {
    await producerAttempt(db, { ...run, workflowStepRunId: wake.workflowStepRunId,
      workflowExecutionGeneration: wake.workflowExecutionGeneration }, linked.step, new Set(), run.status === "queued");
  } catch { throw conflict("heartbeat_workflow_attempt_unproven"); }
  return { workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId,
    workflowExecutionGeneration: wake.workflowExecutionGeneration, missionId: wake.missionId };
}

/** Persisted parent + original wake, never context hints or the current issue's inferred link. */
export async function retryWorkflowIdentity(db: Db, supplied: HeartbeatRun) {
  const reject = () => { throw conflict("heartbeat_workflow_parent_identity_mismatch"); };
  const [parent] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, supplied.id), eq(heartbeatRuns.companyId, supplied.companyId))).for("share");
  if (!parent || parent.agentId !== supplied.agentId || parent.issueId !== supplied.issueId
    || parent.wakeupRequestId !== supplied.wakeupRequestId || parent.workflowStepRunId !== supplied.workflowStepRunId
    || parent.workflowExecutionGeneration !== supplied.workflowExecutionGeneration) return reject();
  if (parent.workflowStepRunId === null && parent.workflowExecutionGeneration === null) return {};
  const identity = await readAdmittedWorkflowIdentity(db, parent);
  if (!identity) return reject();
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, identity.workflowStepRunId));
  await producerAttempt(db, parent, step);
  return identity;
}
