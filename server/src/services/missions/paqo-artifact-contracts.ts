import { qaConfigSchema } from '@paperclipai/shared';
import type { z } from "zod";
import { toolArtifactContractSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { PersistedWorkflowStep } from "../workflow/execution-steps.js";
import type { RevisionStep } from "../workflow/revision-step-config.js";
type WorkflowStep = PersistedWorkflowStep & RevisionStep;
import { rewriteStepToolArgs } from "./structural-materialization.js";

type ArtifactField = "qaConfig" | "workProductSelectors" | "toolArtifactContract" | "sourceStepId";
type ArtifactErrorCode = "paqo_artifact_schema_invalid" | "paqo_artifact_reference_ambiguous"
  | "paqo_artifact_reference_missing" | "paqo_artifact_selector_required";

/** Machine-produced validation failure; callers must not classify Error.message. */
export class PaqoArtifactContractError extends Error {
  readonly diagnostic;
  constructor(code: ArtifactErrorCode, details: { unitId: string; field: ArtifactField;
    reference?: string; schemaIssues?: Array<Pick<z.ZodIssue, "code" | "path" | "message">> }) {
    super(code);
    this.name = "PaqoArtifactContractError";
    this.diagnostic = { code, message: `Unit "${details.unitId}" has an invalid ${details.field} (${code}).`,
      severity: "invalid" as const, details };
  }
}

function parseArtifactField<S extends z.ZodTypeAny>(schema: S, value: unknown, unitId: string, field: ArtifactField): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PaqoArtifactContractError("paqo_artifact_schema_invalid", { unitId, field,
    schemaIssues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })) });
  return parsed.data;
}

/** Preserve structured artifact authority when plan units become generated workflow steps.
 *  [수정 재사용] copiedUnitIds 로 지정된 A 단위는 원본 스냅샷 구성이 이미 완전하므로 계약 적용/재작성에서
 *  제외한다(검증 대상 참조에는 A+B 전체가 그대로 쓰인다). 일반 계획은 기존 동작을 유지한다. */
export function applyPaqoArtifactContracts(units: Record<string, unknown>[], selectedSteps: WorkflowStep[], steps: WorkflowStep[],
  ids: Map<string, string>, copiedUnitIds?: ReadonlySet<string>) {
  const aliases = new Map(ids);
  const unitIdAt = (index: number) => typeof units[index].id === "string" ? units[index].id as string : selectedSteps[index].id;
  for (const [index, step] of selectedSteps.entries()) {
    const source = step.sourceStepId;
    if (typeof source !== "string") continue;
    if (aliases.has(source) && aliases.get(source) !== step.id) throw new PaqoArtifactContractError("paqo_artifact_reference_ambiguous",
      { unitId: unitIdAt(index), field: "sourceStepId", reference: source });
    aliases.set(source, step.id);
  }
  const stepIds = new Set(steps.map(s => s.id));
  const remap = (id: string, unitId: string, field: ArtifactField) => {
    const target = aliases.get(id) ?? id;
    if (!stepIds.has(target)) throw new PaqoArtifactContractError("paqo_artifact_reference_missing", { unitId, field, reference: id });
    return target;
  };
  for (let i = 0; i < units.length; i++) {
    const unit = units[i], step = steps.find(s => s.id === selectedSteps[i].id)!;
    if (copiedUnitIds?.has(selectedSteps[i].id)) continue; // A: 서버 복사본 — 저작 계약 적용 없음
    const unitId = unitIdAt(i);
    if (unit.qaConfig !== undefined) Object.assign(step, { qaConfig: parseArtifactField(qaConfigSchema, unit.qaConfig, unitId, "qaConfig") });
    if (unit.workProductSelectors !== undefined) {
      const selectors = parseArtifactField(workProductSelectorsSchema, unit.workProductSelectors, unitId, "workProductSelectors");
      const mapped: Record<string, (typeof selectors)[string]> = {};
      for (const [id, selector] of Object.entries(selectors)) {
        const target = remap(id, unitId, "workProductSelectors");
        if (mapped[target]) throw new PaqoArtifactContractError("paqo_artifact_reference_ambiguous", { unitId, field: "workProductSelectors", reference: id });
        mapped[target] = selector;
      }
      step.workProductSelectors = mapped;
    }
    if (unit.toolArtifactContract !== undefined) {
      const contract = parseArtifactField(toolArtifactContractSchema, unit.toolArtifactContract, unitId, "toolArtifactContract");
      const inputStepId = remap(contract.inputStepId, unitId, "toolArtifactContract");
      const selectors = parseArtifactField(workProductSelectorsSchema, step.workProductSelectors, unitId, "workProductSelectors");
      if (!selectors[inputStepId]) throw new PaqoArtifactContractError("paqo_artifact_selector_required",
        { unitId, field: "workProductSelectors", reference: contract.inputStepId });
      step.toolArtifactContract = { ...contract, inputStepId };
    }
  }
  rewriteStepToolArgs(steps, aliases);
}
