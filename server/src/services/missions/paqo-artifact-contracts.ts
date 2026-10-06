import { qaConfigSchema } from '@paperclipai/shared';
import { toolArtifactContractSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { PersistedWorkflowStep } from "../workflow/execution-steps.js";
import type { RevisionStep } from "../workflow/revision-step-config.js";
type WorkflowStep = PersistedWorkflowStep & RevisionStep;
import { rewriteStepToolArgs } from "./structural-materialization.js";

/** Preserve structured artifact authority when plan units become generated workflow steps.
 *  [수정 재사용] copiedUnitIds 로 지정된 A 단위는 원본 스냅샷 구성이 이미 완전하므로 계약 적용/재작성에서
 *  제외한다(검증 대상 참조에는 A+B 전체가 그대로 쓰인다). 일반 계획은 기존 동작을 유지한다. */
export function applyPaqoArtifactContracts(units: Record<string, unknown>[], selectedSteps: WorkflowStep[], steps: WorkflowStep[],
  ids: Map<string, string>, copiedUnitIds?: ReadonlySet<string>) {
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
    if (copiedUnitIds?.has(selectedSteps[i].id)) continue; // A: 서버 복사본 — 저작 계약 적용 없음
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
