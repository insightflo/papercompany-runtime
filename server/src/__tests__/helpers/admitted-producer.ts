import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { insertWorkflowWakeRequest } from "../../services/heartbeat-workflow-wake.js";
import { claimQueuedHeartbeatRun } from "../../services/heartbeat-finalization/shadow-writes.js";

// Consumer/locking fixture: real admission writer + atomic claim, no adapter or fabricated proof.
// Full native wake/checkout coverage is in heartbeat-producer-*; this does not claim provider execution.
export async function admittedProducer(db: Db, input: { companyId: string; agentId: string; issueId: string | null;
  stepRunId: string; heartbeatId: string; wakeId?: string; idempotencyKey?: string | null;
  qualityAcceptance?: Record<string, unknown> | null; status?: string }) {
  return db.transaction(async tx => {
    const t = tx as unknown as Db;
    const [step] = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, input.stepRunId));
    const [workflow] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, step.workflowRunId));
    const [wake] = await insertWorkflowWakeRequest(t, { id: input.wakeId, companyId: input.companyId, agentId: input.agentId,
      issueId: input.issueId, missionId: workflow.missionId, workflowRunId: workflow.id, workflowStepRunId: step.id,
      workflowExecutionGeneration: step.executionGeneration, source: "automation", status: "queued",
      idempotencyKey: input.idempotencyKey === undefined ? (step.retryCount ? `workflow-step-retry:${step.id}:${step.retryCount}` : null) : input.idempotencyKey,
      qualityAcceptance: input.qualityAcceptance });
    const [run] = await tx.insert(heartbeatRuns).values({ id: input.heartbeatId, companyId: input.companyId, agentId: input.agentId,
      issueId: input.issueId, status: "queued", wakeupRequestId: wake.id }).returning();
    await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    const claimed = await claimQueuedHeartbeatRun(t, run, new Date());
    if (!claimed) throw new Error("fixture's real admission was not claimed");
    await tx.update(heartbeatRuns).set({ status: input.status ?? "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    return { wakeId: wake.id, heartbeatId: run.id };
  });
}
