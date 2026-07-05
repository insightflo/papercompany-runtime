import { and, eq } from "drizzle-orm";
import type { Db, issues } from "@paperclipai/db";
import { activityLog, workflowDefinitions } from "@paperclipai/db";
import { getIssueExecutionCard } from "./store.js";
import { upsertWorkflowIssueExecutionCard } from "./workflow-upsert.js";

type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "title" | "description" | "assigneeAgentId" | "projectId" | "missionId"
>;

type ActorContext = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

type WorkflowCardStep = {
  id: string;
  dependencies: string[];
  graphWorkProductRequired?: boolean;
} & Record<string, unknown>;

export async function resyncIssueExecutionCardAfterIssueUpdate(input: {
  db: Db;
  issue: IssueRow;
  actor?: ActorContext;
}): Promise<{ previousHash: string; nextHash: string } | null> {
  const existingCard = await getIssueExecutionCard({
    db: input.db,
    companyId: input.issue.companyId,
    issueId: input.issue.id,
  });
  const workflowRunId = existingCard?.workflowRunId ?? existingCard?.cardJson.workflow?.runId ?? null;
  const workflowDefinitionId = existingCard?.cardJson.workflow?.definitionId ?? null;
  const stepId = existingCard?.cardJson.workflow?.stepId ?? null;
  if (!existingCard || !workflowRunId || !workflowDefinitionId || !stepId) return null;

  const [definition] = await input.db
    .select({ stepsJson: workflowDefinitions.stepsJson })
    .from(workflowDefinitions)
    .where(and(
      eq(workflowDefinitions.companyId, input.issue.companyId),
      eq(workflowDefinitions.id, workflowDefinitionId),
    ))
    .limit(1);
  const step = readWorkflowCardStep(definition?.stepsJson, stepId);
  if (!step) return null;

  const nextCard = await upsertWorkflowIssueExecutionCard({
    db: input.db,
    companyId: input.issue.companyId,
    issueId: input.issue.id,
    title: input.issue.title,
    description: input.issue.description ?? "",
    assigneeAgentId: input.issue.assigneeAgentId,
    projectId: input.issue.projectId,
    missionId: input.issue.missionId,
    workflowDefinitionId,
    workflowRunId,
    step,
    stepOutputDir: existingCard.cardJson.requiredOutputs.workProduct.outputDir ?? null,
    qaRubricPath: findQaRubricPath(existingCard.cardJson.evidenceRefs),
  });
  if (nextCard.contentHash === existingCard.contentHash) return null;

  await input.db.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: input.actor?.actorType ?? "system",
    actorId: input.actor?.actorId ?? "issue_execution_card.resync",
    agentId: input.actor?.agentId ?? null,
    runId: input.actor?.runId ?? null,
    action: "issue_execution_card.resynced",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      previousHash: existingCard.contentHash,
      nextHash: nextCard.contentHash,
      workflowRunId,
      workflowDefinitionId,
      stepId,
    },
  });
  return { previousHash: existingCard.contentHash, nextHash: nextCard.contentHash };
}

function readWorkflowCardStep(rawSteps: unknown, stepId: string): WorkflowCardStep | null {
  if (!Array.isArray(rawSteps)) return null;
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || rawStep.id !== stepId) continue;
    return {
      ...rawStep,
      id: stepId,
      dependencies: readStringArray(rawStep.dependencies),
      graphWorkProductRequired: rawStep.graphWorkProductRequired === true,
    };
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findQaRubricPath(refs: Array<{ type: string; path?: string }>): string | null {
  return refs.find((ref) => ref.type === "qa_rubric" && typeof ref.path === "string")?.path ?? null;
}
