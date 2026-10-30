import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { heartbeatRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";

export async function seedLaterQaPass(db: Db, seed: {
  companyId: string;
  missionId: string;
  runId: string;
  qaIssueId: string;
  ownerId: string;
}) {
  const [qa] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-validate"),
  ));
  const [latest] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, seed.companyId), eq(workflowTransitionEvents.missionId, seed.missionId),
    eq(workflowTransitionEvents.workflowRunId, seed.runId), eq(workflowTransitionEvents.workflowStepRunId, qa!.id),
    eq(workflowTransitionEvents.issueId, seed.qaIssueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.layer, "workflow_validation"), eq(workflowTransitionEvents.reason, "workflow_api"),
    eq(workflowTransitionEvents.reasonCode, "workflow_api"),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  const heartbeatId = randomUUID(), createdAt = new Date(latest!.createdAt.getTime() + 1_000);
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: seed.companyId, agentId: seed.ownerId,
    issueId: seed.qaIssueId, status: "succeeded", startedAt: createdAt, finishedAt: createdAt });
  await db.insert(workflowTransitionEvents).values({ companyId: seed.companyId, missionId: seed.missionId,
    workflowRunId: seed.runId, workflowStepRunId: qa!.id, issueId: seed.qaIssueId, heartbeatRunId: heartbeatId,
    eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "pass", decision: "pass",
    reason: "workflow_api", reasonCode: "workflow_api", idempotencyKey: `later-pass:${randomUUID()}`, createdAt,
    payload: { kind: "workflow_validation_verdict", workflowRunId: seed.runId, stepRunId: qa!.id,
      issueId: seed.qaIssueId, verdict: "pass" } });
}
