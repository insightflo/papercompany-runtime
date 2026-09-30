import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { producerAttempt } from "./work-products/producer-attempt.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY, withoutWorkflowAttemptProof, workflowAttemptProofSchema } from "./heartbeat-finalization/workflow-attempt-proof.js";

/** Original insertion only. Nested callers use a savepoint; step locks last until outer admission commits. */
export async function insertWorkflowWakeRequest(db: Db, values: typeof agentWakeupRequests.$inferInsert,
  parentHeartbeatRunId: string | null = null): Promise<Array<typeof agentWakeupRequests.$inferSelect>> {
  return db.transaction(async tx => {
    const reject = () => { throw conflict("heartbeat_workflow_attempt_unproven"); };
    const id = values.id ?? randomUUID(), payload = withoutWorkflowAttemptProof(values.payload ?? null);
    // Non-executing rows and historical NULL identities never acquire a proof by inference.
    if (values.workflowExecutionGeneration == null || ["skipped", "coalesced"].includes(values.status ?? "queued")) {
      return tx.insert(agentWakeupRequests).values({ ...values, id, payload }).returning();
    }
    if (!values.workflowStepRunId || !values.workflowRunId) return reject();
    const [linked] = await tx.select({ step: workflowStepRuns, run: workflowRuns, issueCompanyId: issues.companyId, agentCompanyId: agents.companyId })
      .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .innerJoin(agents, eq(agents.id, values.agentId))
      .leftJoin(issues, eq(issues.id, workflowStepRuns.issueId))
      .where(eq(workflowStepRuns.id, values.workflowStepRunId)).for("share", { of: workflowStepRuns });
    if (!linked || linked.run.companyId !== values.companyId || linked.agentCompanyId !== values.companyId || linked.run.id !== values.workflowRunId
      || linked.step.issueId !== (values.issueId ?? null) || (values.issueId && linked.issueCompanyId !== values.companyId)
      || linked.run.missionId !== (values.missionId ?? null)
      || linked.step.executionGeneration !== values.workflowExecutionGeneration) return reject();
    let attempt = { retryCount: linked.step.retryCount, iterationIndex: linked.step.iterationIndex };
    if (parentHeartbeatRunId) {
      const [parent] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, parentHeartbeatRunId)).for("share");
      if (!parent || parent.companyId !== values.companyId || parent.agentId !== values.agentId
        || parent.issueId !== (values.issueId ?? null) || parent.workflowStepRunId !== linked.step.id
        || parent.workflowExecutionGeneration !== values.workflowExecutionGeneration) return reject();
      attempt = await producerAttempt(tx as unknown as Db, parent, linked.step);
    }
    const proof = workflowAttemptProofSchema.parse({ schemaVersion: 1, companyId: values.companyId, agentId: values.agentId,
      issueId: values.issueId ?? null, missionId: linked.run.missionId, workflowRunId: linked.run.id,
      stepRunId: linked.step.id, executionGeneration: linked.step.executionGeneration, ...attempt,
      wakeupRequestId: id, parentHeartbeatRunId });
    return tx.insert(agentWakeupRequests).values({ ...values, id,
      payload: { ...payload, [WORKFLOW_ATTEMPT_PROOF_KEY]: proof } }).returning();
  });
}
