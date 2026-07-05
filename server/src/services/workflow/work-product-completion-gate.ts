import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues, workflowStepRuns } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import { completeLinkedWorkflowStepRunsForIssue } from "./issue-step-closeout.js";

type WorkflowIssueWorkProductDb = Pick<Db, "select" | "update">;
type IssueRow = typeof issues.$inferSelect;
type StepRunRow = Pick<typeof workflowStepRuns.$inferSelect, "id" | "stepId" | "metadata">;

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

function stepRunRequiresWorkProduct(stepRun: StepRunRow): boolean {
  return stepRun.metadata.graphWorkProductRequired === true ||
    stepRun.metadata.workProductRequired === true ||
    stepRun.metadata.requiresWorkProduct === true;
}

async function getActiveLinkedStepRuns(
  db: WorkflowIssueWorkProductDb,
  issueId: string,
): Promise<StepRunRow[]> {
  return db
    .select({
      id: workflowStepRuns.id,
      stepId: workflowStepRuns.stepId,
      metadata: workflowStepRuns.metadata,
    })
    .from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.issueId, issueId), ACTIVE_STEP_STATUS_CONDITION))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.id));
}

async function hasRegisteredWorkProduct(
  db: WorkflowIssueWorkProductDb,
  issue: Pick<IssueRow, "companyId" | "id">,
): Promise<boolean> {
  const row = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      ne(issueWorkProducts.status, "archived"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row != null;
}

function issueLabel(issue: Pick<IssueRow, "id" | "identifier">): string {
  return issue.identifier ?? issue.id;
}

export async function assertWorkflowIssueWorkProductReadyForDone(input: {
  readonly db: WorkflowIssueWorkProductDb;
  readonly issue: IssueRow;
}): Promise<void> {
  if (input.issue.originKind !== "workflow_execution") return;

  const linkedStepRuns = await getActiveLinkedStepRuns(input.db, input.issue.id);
  const requiredStepRun = linkedStepRuns.find(stepRunRequiresWorkProduct);
  if (!requiredStepRun) return;
  if (await hasRegisteredWorkProduct(input.db, input.issue)) return;

  throw unprocessable(
    `Cannot complete workflow execution issue ${issueLabel(input.issue)} while step ${requiredStepRun.stepId} requires a registered workProduct. Register the artifact in issue_work_products before marking the issue done; transcript claims or [ARTIFACT] comments alone are not sufficient.`,
  );
}

export async function completeWorkflowIssueStepRunsAfterDone(input: {
  readonly db: WorkflowIssueWorkProductDb;
  readonly issue: IssueRow;
  readonly completedAt: Date;
}): Promise<string[]> {
  if (input.issue.originKind !== "workflow_execution") return [];
  return completeLinkedWorkflowStepRunsForIssue({
    db: input.db,
    issueId: input.issue.id,
    completedAt: input.completedAt,
  });
}
