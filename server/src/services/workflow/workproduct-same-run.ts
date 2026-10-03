import { and, eq, ne } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductProducerSchema, type WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";

/** Ordinary same-run selector: cross-run approval must never weaken these checks. */
export async function selectSameRunWorkProduct(db: Db, scope: { companyId: string; workflowRunId: string;
  stepId: string; selector: WorkProductSelectors[string]; pinnedId?: string }) {
  const [source] = await db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, scope.companyId), eq(workflowStepRuns.stepId, scope.stepId)));
  if (!source?.step.issueId || source.step.status !== "completed") throw new Error("workproduct_selector_producer_unavailable");
  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, scope.companyId), eq(issueWorkProducts.issueId, source.step.issueId),
    ...(scope.pinnedId ? [eq(issueWorkProducts.id, scope.pinnedId)] : [ne(issueWorkProducts.status, "archived")]),
    eq(issueWorkProducts.type, scope.selector.type), eq(issueWorkProducts.title, scope.selector.title)));
  if (products.length !== 1) throw new Error("workproduct_selector_not_exactly_one");
  const product = products[0];
  const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
  if (!parsed.success) throw new Error("workproduct_selector_provenance_missing");
  const p = parsed.data, s = source.step;
  if (workProductProducerMismatches(p, { ...scope, run: source.run, step: s, product }).length > 0) {
    throw new Error("workproduct_selector_stale_producer");
  }
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
  if (!heartbeat || heartbeat.companyId !== p.companyId || heartbeat.issueId !== s.issueId
    || heartbeat.workflowStepRunId !== s.id || heartbeat.workflowExecutionGeneration !== s.executionGeneration) {
    throw new Error("workproduct_selector_heartbeat_mismatch");
  }
  try {
    const attempt = await producerAttempt(db, heartbeat, s);
    if (attempt.retryCount !== p.retryCount || attempt.iterationIndex !== p.iterationIndex) throw new Error("attempt mismatch");
  } catch { throw new Error("workproduct_selector_stale_producer"); }
  const file = resolveWorkProductLocalFilePath(product);
  if (!file || !["local", "local_file"].includes(product.provider)) throw new Error("workproduct_selector_not_local");
  return { product, producer: p, file };
}
