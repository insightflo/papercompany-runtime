import { and, eq, ne } from "drizzle-orm";
import { issueWorkProducts, workflowStepOutputBindings, workflowStepRuns, type Db, type workflowRuns } from "@paperclipai/db";
import { workProductProducerSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { workProductProducerMismatches } from "../workflow/workproduct-producer-comparison.js";

/** Read only: never invokes argument rendering (which pins), producerAttempt, or registration. */
export async function loadToolRecoveryProducerFacts(db: Db, run: typeof workflowRuns.$inferSelect,
  stepRunId: string, step: WorkflowStep | null) {
  const selectors = workProductSelectorsSchema.safeParse((step as (WorkflowStep & { workProductSelectors?: unknown }) | null)?.workProductSelectors);
  if (!selectors.success) return { status: "unavailable", reason: "no_valid_explicit_selectors" };
  const facts = [];
  for (const [stepId, selector] of Object.entries(selectors.data).slice(0, 12)) {
    const sources = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, run.id), eq(workflowStepRuns.stepId, stepId))).limit(2);
    const source = sources[0];
    if (sources.length !== 1 || !source?.issueId || source.status !== "completed") {
      facts.push({ stepId, status: "workproduct_selector_producer_unavailable" }); continue;
    }
    const [pin] = await db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, run.companyId), eq(workflowStepOutputBindings.workflowRunId, run.id),
      eq(workflowStepOutputBindings.consumerStepRunId, stepRunId), eq(workflowStepOutputBindings.referencedStepId, stepId))).limit(1);
    const products = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, run.companyId),
      eq(issueWorkProducts.issueId, source.issueId), eq(issueWorkProducts.type, selector.type), eq(issueWorkProducts.title, selector.title),
      ...(pin ? [eq(issueWorkProducts.id, pin.workProductId)] : [ne(issueWorkProducts.status, "archived")]))).limit(2);
    if (products.length !== 1) { facts.push({ stepId, status: "workproduct_selector_not_exactly_one" }); continue; }
    const product = products[0];
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success) { facts.push({ stepId, workProductId: product.id, status: "workproduct_selector_provenance_missing" }); continue; }
    const scope = { companyId: run.companyId, workflowRunId: run.id, run, step: source, product };
    const mismatches = workProductProducerMismatches(parsed.data, scope);
    const prospective = workProductProducerMismatches(parsed.data, { ...scope, step: { ...source, executionGeneration: source.executionGeneration + 1 } });
    facts.push({ stepId, stepRunId: source.id, workProductId: product.id,
      status: mismatches.length ? "workproduct_selector_stale_producer" : "field_comparison_only",
      mismatches, currentGeneration: source.executionGeneration, producerGeneration: parsed.data.executionGeneration,
      prospective: { condition: "if strict retry consumes authority, all run step generations increment; producer is not reset", mismatches: prospective },
      unchecked: ["original_heartbeat_wake_attempt", "ancestor_reference", "seed_authority", "local_provider_and_bytes"] });
  }
  return { status: "snapshot_only", scope: "declared selector candidates; actual referenced inputs and seed/pin execution policy not certified", facts,
    truncated: Object.keys(selectors.data).length > 12 };
}
