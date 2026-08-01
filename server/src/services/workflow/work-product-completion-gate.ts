import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueWorkProducts, issues, workflowStepRuns } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import { resolveWorkProductRequirement } from "../issue-execution-cards/gate-contract.js";
import { cardDescriptionDrift, getIssueExecutionCard } from "../issue-execution-cards/store.js";
import { completeLinkedWorkflowStepRunsForIssue } from "./issue-step-closeout.js";
import type { WorkflowSyncSource } from "./workflow-sync-source.js";

type WorkflowIssueWorkProductDb = Pick<Db, "select" | "update" | "insert" | "transaction">;
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
    `Cannot complete workflow execution issue ${issueLabel(input.issue)} while step ${decision.stepId ?? "unknown"} requires a registered workProduct. Use POST /api/issues/:id/workflow/artifacts with either an existing absolute local path or type=preview_url plus an HTTP(S) url. Do not emit an \`[ARTIFACT]\` marker, comment text, or stdout — only the Workflow API registers a work product. Do not POST /api/issues/:id/work-products manually or rely on transcript claims.${decision.cardHash ? ` issueExecutionCardHash=${decision.cardHash}` : ""}`,
  );
}

export async function completeWorkflowIssueStepRunsAfterDone(input: {
  readonly db: WorkflowIssueWorkProductDb;
  readonly issue: IssueRow;
  readonly completedAt: Date;
  readonly source?: WorkflowSyncSource;
}): Promise<string[]> {
  if (input.issue.originKind !== "workflow_execution") return [];
  return completeLinkedWorkflowStepRunsForIssue({
    db: input.db,
    issueId: input.issue.id,
    completedAt: input.completedAt,
    source: input.source,
  });
}
