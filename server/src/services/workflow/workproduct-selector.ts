import type { Db } from "@paperclipai/db";
import { workProductSelectorsSchema, type WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { selectSameRunWorkProduct } from "./workproduct-same-run.js";
import { readSeededStepProducts, seedError } from "./workflow-seed-evidence.js";

export async function selectOfficialWorkProduct(db: Db, scope: { companyId: string; workflowRunId: string;
  stepId: string; selector: WorkProductSelectors[string]; pinnedId?: string }) {
  const seeded = await readSeededStepProducts(db, scope);
  if (!seeded) return selectSameRunWorkProduct(db, scope);
  const matches = seeded.filter(s => s.product.type === scope.selector.type && s.product.title === scope.selector.title
    && (!scope.pinnedId || s.product.id === scope.pinnedId));
  if (matches.length !== 1) throw seedError("selector_not_exactly_one");
  return matches[0];
}

export async function resolveSelectedPaths(db: Db, input: { companyId: string; workflowRunId: string;
  selectors: unknown; references: Set<string>; pins: Map<string, string> }) {
  const selectors = workProductSelectorsSchema.parse(input.selectors ?? {});
  const result = new Map<string, Awaited<ReturnType<typeof selectOfficialWorkProduct>>>();
  for (const [stepId, selector] of Object.entries(selectors)) {
    if (!input.references.has(stepId)) throw new Error("workproduct_selector_unused_reference");
    result.set(stepId, await selectOfficialWorkProduct(db, { companyId: input.companyId,
      workflowRunId: input.workflowRunId, stepId, selector, pinnedId: input.pins.get(stepId) }));
  }
  // A seed is never consumed through the legacy latest-product/metadata fallback.
  for (const stepId of input.references) {
    if (selectors[stepId]) continue;
    if (await readSeededStepProducts(db, { ...input, stepId })) throw seedError("explicit_selector_required", { stepId });
  }
  return result;
}
