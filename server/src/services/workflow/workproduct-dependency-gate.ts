import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepRuns } from "@paperclipai/db";

export type WorkProductGateStatus = "pending" | "running" | "completed" | "failed";

export type WorkProductGateStepRun = {
  readonly stepId: string;
  readonly issueId: string | null;
};

export type WorkProductGateStep = {
  readonly id: string;
  readonly graphWorkProductRequired?: boolean;
};

export type WorkProductDependencyGate = {
  readonly issueIdsRequiringRegisteredWorkProduct: ReadonlySet<string>;
  readonly issueIdsWithRegisteredWorkProducts: ReadonlySet<string>;
};

export function collectIssueIdsRequiringRegisteredWorkProduct(
  stepRuns: readonly WorkProductGateStepRun[],
  steps: readonly WorkProductGateStep[],
): Set<string> {
  const requiredStepIds = new Set(
    steps
      .filter((step) => step.graphWorkProductRequired === true)
      .map((step) => step.id),
  );
  const issueIds = new Set<string>();
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId || !requiredStepIds.has(stepRun.stepId)) continue;
    issueIds.add(stepRun.issueId);
  }
  return issueIds;
}

export function collectUniqueStepRunIssueIds(stepRuns: readonly WorkProductGateStepRun[]): string[] {
  const issueIds = stepRuns
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => typeof issueId === "string");
  return issueIds.filter((issueId, index, all) => all.indexOf(issueId) === index);
}

export async function loadWorkProductDependencyGate(
  db: Db,
  stepRuns: readonly WorkProductGateStepRun[],
  steps: readonly WorkProductGateStep[],
): Promise<WorkProductDependencyGate> {
  const issueIdsRequiringRegisteredWorkProduct = collectIssueIdsRequiringRegisteredWorkProduct(stepRuns, steps);
  const issueIdsWithRegisteredWorkProducts = await loadIssueIdsWithRegisteredWorkProducts(
    db,
    issueIdsRequiringRegisteredWorkProduct,
  );
  return { issueIdsRequiringRegisteredWorkProduct, issueIdsWithRegisteredWorkProducts };
}

export function applyWorkProductDependencyGate(input: {
  readonly issueId: string;
  readonly status: WorkProductGateStatus;
  readonly gate: WorkProductDependencyGate;
}): WorkProductGateStatus {
  if (
    input.status === "completed"
    && input.gate.issueIdsRequiringRegisteredWorkProduct.has(input.issueId)
    && !input.gate.issueIdsWithRegisteredWorkProducts.has(input.issueId)
  ) {
    return "running";
  }
  return input.status;
}

export async function loadIssueIdsWithRegisteredWorkProducts(
  db: Db,
  issueIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const ids = Array.from(issueIds);
  if (ids.length === 0) return new Set();

  const rows = await db
    .select({ issueId: issueWorkProducts.issueId })
    .from(issueWorkProducts)
    .where(inArray(issueWorkProducts.issueId, ids));
  return new Set(rows.map((row) => row.issueId));
}

export async function reloadWorkflowStepRunsForSameRun(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const workflowRunId = stepRuns[0]?.workflowRunId;
  if (!workflowRunId) return stepRuns;
  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
}
