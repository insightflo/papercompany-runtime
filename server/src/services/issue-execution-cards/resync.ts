import { and, eq } from "drizzle-orm";
import type { Db, issues } from "@paperclipai/db";
import { activityLog, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { getIssueExecutionCard } from "./store.js";
import { upsertWorkflowIssueExecutionCard } from "./workflow-upsert.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";

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

  // [Task5a2c] definition 단독 조회 대신 run-definition identity join 으로 scope 를 확정한다:
  //   run.id === workflowRunId, run.companyId === issue.companyId, run.workflowId ===
  //   workflowDefinitionId, definition.id === workflowDefinitionId, definition.companyId ===
  //   issue.companyId. 한 run 을 로드하고 다른 definition 정체성으로 카드를 쓰는 오류를 원천
  //   차단하고, malformed legacy card 참조는 더 이상 resync 되지 않는다.
  const [run] = await input.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.id, workflowRunId),
      eq(workflowRuns.companyId, input.issue.companyId),
      eq(workflowRuns.workflowId, workflowDefinitionId),
      eq(workflowDefinitions.id, workflowDefinitionId),
      eq(workflowDefinitions.companyId, input.issue.companyId),
    ))
    .limit(1);
  if (!run) return null;
  const execution = await loadExecutionDefinition(input.db, run.id, { requireHistorical: false });
  const step = execution.steps.find((candidate) => candidate.id === stepId) ?? null;
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
    evidenceRefs: existingCard.cardJson.evidenceRefs,
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

function findQaRubricPath(refs: Array<{ type: string; path?: string }>): string | null {
  return refs.find((ref) => ref.type === "qa_rubric" && typeof ref.path === "string")?.path ?? null;
}
