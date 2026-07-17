import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";

export type QaCapTestDb = ReturnType<typeof createDb>;

export interface QaCapBase {
  companyId: string;
  agentId: string;
  missionId: string;
}

export async function seedQaCapBase(db: QaCapTestDb): Promise<QaCapBase> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Cap Co", status: "active" });
  await db.insert(agents).values({
    id: agentId, companyId, name: "Owner", role: "mission_owner",
    status: "active", adapterType: "process", adapterConfig: {},
  });
  await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId,
    title: "Cap Mission", status: "active",
  });
  return { companyId, agentId, missionId };
}

export interface QaEdgeSpec {
  stepId?: string;
  maxIterations: number;
  structural?: boolean;
  /** Override QA step-run status (default "failed"). Use "running" for barrier tests. */
  qaStatus?: string;
}

export interface QaSeedRow {
  stepId: string;
  stepRunId: string;
  issueId: string;
}

export interface QaCapSeed {
  runId: string;
  producerStepId: string;
  producerStepRunId: string;
  producerIssueId: string;
  producerCompletedAt: Date | null;
  qas: QaSeedRow[];
}

export async function seedQaCapWorkflow(
  db: QaCapTestDb,
  base: QaCapBase,
  input: {
    iteration: number;
    edges?: QaEdgeSpec[];
    producerStepId?: string;
    producerCompletedAt?: Date | null;
    runStatus?: string;
  },
): Promise<QaCapSeed> {
  const wfId = randomUUID();
  const runId = randomUUID();
  const producerStepId = input.producerStepId ?? `producer-${randomUUID().slice(0, 8)}`;
  const edges = input.edges ?? [{ maxIterations: 2 }];
  const qaDefs = edges.map((edge, index) => {
    const id = edge.stepId ?? `qa-${index}-${randomUUID().slice(0, 8)}`;
    return edge.structural
      ? { id, name: "[QA] Structural gate", type: "tool", qaType: "structural", agentId: "", toolNames: ["validate"], dependencies: [producerStepId] }
      : { id, name: "[QA] Semantic review", agentId: base.agentId, dependencies: [producerStepId] };
  });
  await db.insert(workflowDefinitions).values({
    id: wfId, companyId: base.companyId, name: "Cap WF",
    stepsJson: [
      {
        id: producerStepId, name: "[ACTION] Produce", agentId: base.agentId,
        dependencies: [], graphWorkProductRequired: true,
        conditionalDependencies: qaDefs.map((qa, index) => ({
          stepId: qa.id, when: "qa_request_changes", isBackEdge: true,
          maxIterations: edges[index]!.maxIterations,
        })),
      },
      ...qaDefs,
    ],
  });
  await db.insert(workflowRuns).values({
    id: runId, companyId: base.companyId, workflowId: wfId,
    missionId: base.missionId, status: input.runStatus ?? "running", triggeredBy: "test",
  });

  const producerIssue = await db.insert(issues).values({
    companyId: base.companyId, missionId: base.missionId,
    title: "Producer issue", status: "done", originKind: "workflow_execution",
    assigneeAgentId: base.agentId,
  }).returning();
  const producerCompletedAt = input.producerCompletedAt === undefined
    ? new Date(Date.now() - 60_000)
    : input.producerCompletedAt;
  const producerRun = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: producerStepId, status: "completed",
    issueId: producerIssue[0]!.id, iterationIndex: input.iteration,
    completedAt: producerCompletedAt,
  }).returning();

  const qas: QaSeedRow[] = [];
  for (const [index, qa] of qaDefs.entries()) {
    const qaIssue = await db.insert(issues).values({
      companyId: base.companyId, missionId: base.missionId,
      title: `QA ${qa.id}`, status: "blocked", originKind: "workflow_execution",
      assigneeAgentId: base.agentId,
    }).returning();
    const qaRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: qa.id,
      status: edges[index]!.qaStatus ?? "failed",
      issueId: qaIssue[0]!.id, iterationIndex: 0,
      completedAt: new Date(Date.now() - 30_000),
    }).returning();
    qas.push({ stepId: qa.id, stepRunId: qaRun[0]!.id, issueId: qaIssue[0]!.id });
  }
  return {
    runId, producerStepId, producerStepRunId: producerRun[0]!.id,
    producerIssueId: producerIssue[0]!.id, producerCompletedAt, qas,
  };
}

export async function seedStepHeartbeat(
  db: QaCapTestDb,
  base: QaCapBase,
  input: {
    workflowRunId: string; workflowStepRunId: string; issueId: string;
    createdAt?: Date;
  },
): Promise<string> {
  const createdAt = input.createdAt ?? new Date();
  const wake = await db.insert(agentWakeupRequests).values({
    companyId: base.companyId, agentId: base.agentId,
    source: "automation", status: "queued", reason: "workflow_step_runnable",
    requestKind: "workflow_resume", issueId: input.issueId,
    missionId: base.missionId, workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    requestedAt: createdAt, createdAt, updatedAt: createdAt,
  }).returning();
  const run = await db.insert(heartbeatRuns).values({
    companyId: base.companyId, agentId: base.agentId,
    issueId: input.issueId, status: "succeeded", wakeupRequestId: wake[0]!.id,
    finishedAt: createdAt, createdAt, updatedAt: createdAt,
  }).returning();
  return run[0]!.id;
}

export async function seedWorkflowVerdict(
  db: QaCapTestDb,
  base: QaCapBase,
  input: {
    workflowRunId: string; workflowStepRunId: string; issueId: string;
    heartbeatRunId: string | null; verdict?: "request_changes" | "pass";
    reason?: string; createdAt?: Date;
  },
): Promise<void> {
  const verdict = input.verdict ?? "request_changes";
  await db.insert(workflowTransitionEvents).values({
    companyId: base.companyId, missionId: base.missionId,
    workflowRunId: input.workflowRunId, workflowStepRunId: input.workflowStepRunId,
    issueId: input.issueId, heartbeatRunId: input.heartbeatRunId,
    eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict, decision: verdict, reason: input.reason ?? "workflow_api",
    reasonCode: input.reason ?? "workflow_api",
    idempotencyKey: `verdict:${input.workflowStepRunId}:${randomUUID()}`,
    payload: { kind: "workflow_validation_verdict", verdict },
    createdAt: input.createdAt ?? new Date(),
  });
}

export async function loadQaCapStepRows(db: QaCapTestDb, base: QaCapBase) {
  return db.select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, base.companyId), eq(workflowRuns.missionId, base.missionId)));
}

export async function cleanQaCapFixture(db: QaCapTestDb): Promise<void> {
  await db.delete(workflowTransitionEvents);
  await db.delete(issueComments);
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(issues);
  await db.delete(missions);
  await db.delete(agents);
  await db.delete(companies);
}
