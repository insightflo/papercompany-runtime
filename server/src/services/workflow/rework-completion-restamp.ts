import { and, count, eq, inArray, ne } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueWorkProducts, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { conflict } from "../../errors.js";
import { workProductService } from "../work-products.js";
import { loadExecutionDefinition } from "./execution-definition.js";

type ReworkContract = { kind: "workflow_qa_rework"; producerStepId: string };

function readReworkContract(value: unknown): ReworkContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contract = value as Record<string, unknown>;
  return contract.kind === "workflow_qa_rework"
    && typeof contract.producerStepId === "string"
    && contract.producerStepId.length > 0
    ? { kind: contract.kind, producerStepId: contract.producerStepId }
    : null;
}

function hasReworkContractKind(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "workflow_qa_rework");
}

/**
 * A structured rework completion is the producer's final assertion that its declared output is ready.
 * Re-seal only products selected by the frozen downstream contract, under the authenticated current
 * heartbeat. Explicit registration remains valid; this closes the comment-only completion gap.
 */
export async function restampReworkProductsOnCompletion(input: {
  db: Db;
  companyId: string;
  issueId: string;
  heartbeatRunId: string;
}): Promise<number> {
  const [heartbeat] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.heartbeatRunId),
    eq(heartbeatRuns.companyId, input.companyId),
  )).limit(1);
  const context = heartbeat?.contextSnapshot && typeof heartbeat.contextSnapshot === "object"
    ? heartbeat.contextSnapshot as Record<string, unknown>
    : null;
  const contract = readReworkContract(context?.paperclipWorkflowReworkContract);
  if (!contract) return 0;
  if (heartbeat.issueId !== input.issueId || !heartbeat.workflowStepRunId
    || heartbeat.workflowExecutionGeneration === null) {
    throw conflict("rework_completion_producer_unlinked");
  }

  const [step] = await input.db.select().from(workflowStepRuns).where(eq(
    workflowStepRuns.id,
    heartbeat.workflowStepRunId,
  )).limit(1);
  if (!step || step.issueId !== input.issueId || step.stepId !== contract.producerStepId
    || step.executionGeneration !== heartbeat.workflowExecutionGeneration) {
    throw conflict("rework_completion_producer_stale");
  }

  const definition = await loadExecutionDefinition(input.db, step.workflowRunId, { requireHistorical: false });
  const selectors = new Map<string, { type: string; title: string }>();
  for (const candidate of definition.steps) {
    const parsed = workProductSelectorsSchema.safeParse(
      (candidate as typeof candidate & { workProductSelectors?: unknown }).workProductSelectors,
    );
    if (!parsed.success) continue;
    const selector = parsed.data[contract.producerStepId];
    if (selector) selectors.set(`${selector.type}\u0000${selector.title}`, selector);
  }
  if (selectors.size === 0) return 0;

  const productIds = new Set<string>();
  for (const selector of selectors.values()) {
    const products = await input.db.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, input.issueId),
      eq(issueWorkProducts.type, selector.type),
      eq(issueWorkProducts.title, selector.title),
      ne(issueWorkProducts.status, "archived"),
    )).orderBy(issueWorkProducts.id);
    if (products.length !== 1) throw conflict("rework_completion_product_selection_unproven", {
      producerStepId: contract.producerStepId,
      type: selector.type,
      title: selector.title,
      matches: products.length,
    });
    productIds.add(products[0].id);
  }

  for (const productId of productIds) {
    const updated = await workProductService(input.db).restampProducer(productId, input.heartbeatRunId, {
      registeredVia: "workflow_completion",
      registeredByRunId: input.heartbeatRunId,
    });
    if (!updated) throw conflict("rework_completion_product_missing", { workProductId: productId });
  }
  return productIds.size;
}

export async function isWorkflowReworkRun(db: Db, runId: string): Promise<boolean> {
  const [run] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
  const context = run?.contextSnapshot && typeof run.contextSnapshot === "object"
    ? run.contextSnapshot as Record<string, unknown>
    : null;
  return hasReworkContractKind(context?.paperclipWorkflowReworkContract);
}

export async function runMadeObservableProgress(db: Db, runId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(activityLog).where(and(
    eq(activityLog.runId, runId),
    inArray(activityLog.action, [
      "issue.workflow_artifact_registered",
      "issue.work_product_progress_accepted",
      "issue.comment_added",
    ]),
  ));
  return Number(row?.n ?? 0) > 0;
}

export async function assertReworkCompletionReady(input: {
  db: Db;
  companyId: string;
  issueId: string;
  heartbeatRunId: string | null;
}): Promise<void> {
  if (!input.heartbeatRunId || !await isWorkflowReworkRun(input.db, input.heartbeatRunId)) return;
  await restampReworkProductsOnCompletion({ ...input, heartbeatRunId: input.heartbeatRunId });
  if (!await runMadeObservableProgress(input.db, input.heartbeatRunId)) {
    throw conflict(
      "QA rework run made no observable progress; resolve the REQUEST_CHANGES and update or register the artifact before completing the workflow issue.",
    );
  }
}
