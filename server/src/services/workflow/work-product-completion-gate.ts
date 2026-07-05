import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueWorkProducts, issues, workflowStepRuns } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import { resolveWorkProductRequirement } from "../issue-execution-cards/gate-contract.js";
import { cardDescriptionDrift, getIssueExecutionCard } from "../issue-execution-cards/store.js";
import { completeLinkedWorkflowStepRunsForIssue } from "./issue-step-closeout.js";

type WorkflowIssueWorkProductDb = Pick<Db, "select" | "update" | "insert">;
type IssueRow = typeof issues.$inferSelect;
type StepRunRow = Pick<typeof workflowStepRuns.$inferSelect, "id" | "stepId" | "metadata">;

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

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

async function recordWorkProductGateDecision(input: {
  db: WorkflowIssueWorkProductDb;
  issue: IssueRow;
  outcome: "passed" | "blocked";
  source: string;
  stepId: string | null;
  cardHash: string | null;
  descriptionDrift: boolean;
}) {
  if (!input.cardHash) return;
  await input.db.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "workflow-work-product-completion-gate",
    action: `issue_execution_card.work_product_gate_${input.outcome}`,
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      source: input.source,
      stepId: input.stepId,
      cardHash: input.cardHash,
      descriptionDrift: input.descriptionDrift,
    },
  });
}

export async function assertWorkflowIssueWorkProductReadyForDone(input: {
  readonly db: WorkflowIssueWorkProductDb;
  readonly issue: IssueRow;
}): Promise<void> {
  if (input.issue.originKind !== "workflow_execution") return;

  const linkedStepRuns = await getActiveLinkedStepRuns(input.db, input.issue.id);
  const card = await getIssueExecutionCard({
    db: input.db,
    companyId: input.issue.companyId,
    issueId: input.issue.id,
  });
  const decision = resolveWorkProductRequirement({
    card,
    linkedStepRuns,
    issueDescription: input.issue.description,
  });
  if (!decision.required) return;

  const descriptionDrift = cardDescriptionDrift({ issue: input.issue, card });
  if (await hasRegisteredWorkProduct(input.db, input.issue)) {
    await recordWorkProductGateDecision({
      db: input.db,
      issue: input.issue,
      outcome: "passed",
      source: decision.source,
      stepId: decision.stepId,
      cardHash: decision.cardHash,
      descriptionDrift,
    });
    return;
  }

  await recordWorkProductGateDecision({
    db: input.db,
    issue: input.issue,
    outcome: "blocked",
    source: decision.source,
    stepId: decision.stepId,
    cardHash: decision.cardHash,
    descriptionDrift,
  });
  throw unprocessable(
    `Cannot complete workflow execution issue ${issueLabel(input.issue)} while step ${decision.stepId ?? "unknown"} requires a registered workProduct. Register the artifact in issue_work_products before marking the issue done; transcript claims or [ARTIFACT] comments alone are not sufficient.${decision.cardHash ? ` issueExecutionCardHash=${decision.cardHash}` : ""}`,
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
