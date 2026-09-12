import type { RefinementCtx } from "zod";
import type { QualityTarget } from "./quality-automation.js";

/** Validate effect/target phase together; initial null IDs never authorize evaluation. */
export function refineQualityEffect(effect: {
  kind: string; target: QualityTarget; candidateVersionId?: string; requirementVersionId?: string;
}, ctx: RefinementCtx): void {
  const { target } = effect;
  const invalid = () => ctx.addIssue({ code: "custom", message: "quality_effect_target_mismatch" });
  if (effect.kind === "repair_supported_output" && target.kind !== "current_output") invalid();
  if (["evaluate_candidate", "select_candidate", "reevaluate_requirements"].includes(effect.kind)) {
    if (target.kind !== "qa_addendum") { invalid(); return; }
    if (effect.kind !== "reevaluate_requirements" && (!target.candidateVersionId || !target.evaluationId)) invalid();
    if (effect.kind === "select_candidate" && effect.candidateVersionId !== target.candidateVersionId) invalid();
    if (effect.kind === "reevaluate_requirements" && effect.requirementVersionId !== target.requirementVersionId) invalid();
  }
}
