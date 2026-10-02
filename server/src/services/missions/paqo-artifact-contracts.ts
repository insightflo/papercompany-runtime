import { qaConfigSchema } from '@paperclipai/shared';
import { toolArtifactContractSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { PersistedWorkflowStep } from "../workflow/execution-steps.js";
import type { RevisionStep } from "../workflow/revision-step-config.js";
type WorkflowStep = PersistedWorkflowStep & RevisionStep;
import { rewriteStepToolArgs } from "./structural-materialization.js";

/** Preserve structured artifact authority when plan units become generated workflow steps. */
export function applyPaqoArtifactContracts(units: Record<string, unknown>[], selectedSteps: WorkflowStep[], steps: WorkflowStep[],
  ids: Map<string, string>) {
  const aliases = new Map(ids);
  for (const step of selectedSteps) {
    const source = step.sourceStepId;
    if (typeof source !== "string") continue;
    if (aliases.has(source) && aliases.get(source) !== step.id) throw new Error("paqo_artifact_reference_ambiguous");
    aliases.set(source, step.id);
  }
  const stepIds = new Set(steps.map(s => s.id));
  const remap = (id: string) => {
    const target = aliases.get(id) ?? id;
    if (!stepIds.has(target)) throw new Error("paqo_artifact_reference_missing");
    return target;
  };
  for (let i = 0; i < units.length; i++) {
    const unit = units[i], step = steps.find(s => s.id === selectedSteps[i].id)!;
    if (unit.qaConfig !== undefined) Object.assign(step, { qaConfig: qaConfigSchema.parse(unit.qaConfig) });
    if (unit.workProductSelectors !== undefined) {
      const selectors = workProductSelectorsSchema.parse(unit.workProductSelectors);
      const mapped: Record<string, (typeof selectors)[string]> = {};
      for (const [id, selector] of Object.entries(selectors)) {
        const target = remap(id);
        if (mapped[target]) throw new Error("paqo_artifact_reference_ambiguous");
        mapped[target] = selector;
      }
      step.workProductSelectors = mapped;
    }
    if (unit.toolArtifactContract !== undefined) {
      const contract = toolArtifactContractSchema.parse(unit.toolArtifactContract);
      const inputStepId = remap(contract.inputStepId);
      const selectors = workProductSelectorsSchema.parse(step.workProductSelectors);
      if (!selectors[inputStepId]) throw new Error("paqo_artifact_selector_required");
      step.toolArtifactContract = { ...contract, inputStepId };
    }
  }
  rewriteStepToolArgs(steps, aliases);
}
