import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  type createDb,
} from "@paperclipai/db";
import { syncWorkflowRunState } from "../../services/workflow/dag-engine.js";

export type TestDb = ReturnType<typeof createDb>;

export async function seedIssueBackedRetryWorkflow(
  db: TestDb,
  companyId: string,
  options: { maxRetries?: number; delaySeconds?: number; agentStatus?: "active" | "paused" } = {},
) {
  const maxRetries = options.maxRetries ?? 2;
  const agentId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const stepId = `agent-${randomUUID().slice(0, 6)}`;
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: `Agent-${stepId}`,
    role: "worker",
    status: options.agentStatus ?? "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: `WF-${stepId}`,
    stepsJson: [{
      id: stepId,
      name: "Worker",
      agentId,
      onFailure: "retry",
      maxRetries,
      ...(options.delaySeconds !== undefined ? { graphRetryDelaySeconds: options.delaySeconds } : {}),
    }],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId,
    companyId,
    workflowId,
    status: "running",
    triggeredBy: "test",
  });
  await syncWorkflowRunState(db, workflowRunId);
  const [stepRun] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, workflowRunId),
    eq(workflowStepRuns.stepId, stepId),
  ));
  if (!stepRun?.issueId) throw new Error("Expected issue-backed step run");
  return { agentId, workflowRunId, stepId, stepRunId: stepRun.id, issueId: stepRun.issueId };
}

export async function failIssueBackedAttempt(db: TestDb, companyId: string, stepRunId: string) {
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  if (!stepRun?.issueId) throw new Error("Expected issue-backed step run");
  const [issue] = await db.select().from(issues).where(eq(issues.id, stepRun.issueId));
  if (!issue?.assigneeAgentId) throw new Error("Expected assigned issue");
  const now = new Date();
  await db.update(agentWakeupRequests).set({
    status: "completed",
    finishedAt: now,
    updatedAt: now,
  }).where(eq(agentWakeupRequests.issueId, stepRun.issueId));
  await db.update(heartbeatRuns).set({
    status: "failed",
    finishedAt: now,
    error: "simulated failure",
  }).where(eq(heartbeatRuns.issueId, stepRun.issueId));
  await db.insert(heartbeatRuns).values({
    id: randomUUID(),
    companyId,
    agentId: issue.assigneeAgentId,
    issueId: stepRun.issueId,
    invocationSource: "test",
    status: "failed",
    startedAt: now,
    finishedAt: now,
    error: "simulated failure",
  });
  await db.update(issues).set({ status: "blocked", updatedAt: now }).where(eq(issues.id, stepRun.issueId));
}

export function retryKey(stepRunId: string, retryNumber: number) {
  return `workflow-step-retry:${stepRunId}:${retryNumber}`;
}
