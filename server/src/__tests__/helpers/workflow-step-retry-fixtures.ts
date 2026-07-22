import { randomUUID } from "node:crypto";
import { createDb, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";

export type WorkflowRetryTestDb = ReturnType<typeof createDb>;

export async function setupWorkflow(
  db: WorkflowRetryTestDb,
  companyId: string,
  steps: Record<string, unknown>[],
) {
  const wfId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({
    id: wfId, companyId, name: `WF-${randomUUID().slice(0, 6)}`, stepsJson: steps,
  });
  await db.insert(workflowRuns).values({
    id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test",
  });
  return { wfId, runId };
}

export async function failIssueLessToolStep(
  db: WorkflowRetryTestDb,
  runId: string,
  stepId: string,
  onFailure = "retry",
  maxRetries = 2,
) {
  const reqId = `req-${randomUUID()}`;
  const [stepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId, status: "failed",
    lastDispatchRequestId: reqId, completedAt: new Date(),
    lastDispatchErrorSummary: "tool failed",
    metadata: { toolResult: { success: false, error: "boom" } },
  }).returning();
  return { stepRun, reqId };
}
