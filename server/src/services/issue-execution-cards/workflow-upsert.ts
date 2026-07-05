import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { buildWorkflowIssueExecutionCard } from "./builder.js";
import { upsertIssueExecutionCard, type IssueExecutionCardRow } from "./store.js";

type WorkflowCardStep = {
  id: string;
  dependencies: string[];
  graphWorkProductRequired?: boolean;
};

export async function upsertWorkflowIssueExecutionCard(input: {
  db: Db;
  companyId: string;
  issueId: string;
  title: string;
  description: string;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  workflowDefinitionId: string;
  workflowRunId: string;
  step: WorkflowCardStep;
  stepOutputDir?: string | null;
  qaRubricPath?: string | null;
}): Promise<IssueExecutionCardRow> {
  const workflowStepRunId = await input.db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.stepId, input.step.id),
    ))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
  return upsertIssueExecutionCard({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
    missionId: input.missionId ?? null,
    workflowRunId: input.workflowRunId,
    workflowStepRunId,
    card: buildWorkflowIssueExecutionCard({
      title: input.title,
      description: input.description,
      companyId: input.companyId,
      issueId: input.issueId,
      assigneeAgentId: input.assigneeAgentId ?? null,
      projectId: input.projectId ?? null,
      missionId: input.missionId ?? null,
      workflowDefinitionId: input.workflowDefinitionId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId,
      step: input.step,
      stepOutputDir: input.stepOutputDir ?? null,
      qaRubricPath: input.qaRubricPath ?? null,
      isQaStep: isQaLikeStep(input.step),
    }),
  });
}
