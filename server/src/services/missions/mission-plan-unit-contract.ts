import type { WorkflowStepContract } from "@paperclipai/shared";
import { normalizeWorkflowStepContract } from "../workflow/step-contract.js";

type PlanUnit = Record<string, unknown>;

function formatContractValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const entries = value.map((entry) => entry.trim()).filter(Boolean);
    return entries.length > 0 ? entries.join("; ") : null;
  }
  if (value === null || value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded && encoded !== "[]" && encoded !== "{}" ? encoded : null;
  } catch {
    return null;
  }
}

export function renderMissionPlanUnitContractLines(unit: PlanUnit): string[] {
  const expectedOutput = formatContractValue(unit.expectedOutput);
  const acceptanceCriteria = formatContractValue(unit.acceptanceCriteria);
  const evidenceRequired = formatContractValue(unit.evidenceRequired);
  return [
    expectedOutput ? `Expected output: ${expectedOutput}` : null,
    acceptanceCriteria ? `Acceptance criteria: ${acceptanceCriteria}` : null,
    evidenceRequired ? `Evidence required: ${evidenceRequired}` : null,
  ].filter((line): line is string => line !== null);
}

// [규칙 8] 결과는 발주 계약(QA 채점·지침 입력)으로만 소비된다. 실행 통제 권위 아님.
function readContractSectionItems(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function deriveUnitPlanFieldPostconditions(unit: PlanUnit): string[] {
  const expectedOutput = formatContractValue(unit.expectedOutput);
  const acceptanceCriteria = formatContractValue(unit.acceptanceCriteria);
  const evidenceRequired = formatContractValue(unit.evidenceRequired);
  return [
    expectedOutput ? `Expected output: ${expectedOutput}` : null,
    acceptanceCriteria ? `Acceptance criteria: ${acceptanceCriteria}` : null,
    evidenceRequired ? `Evidence required: ${evidenceRequired}` : null,
  ].filter((line): line is string => line !== null);
}

export function buildMissionPlanUnitStepContract(unit: PlanUnit): WorkflowStepContract | null {
  const preconditions = readContractSectionItems(unit.preconditions);
  const explicitPostconditions = readContractSectionItems(unit.postconditions);
  const postconditions = explicitPostconditions ?? deriveUnitPlanFieldPostconditions(unit);
  const undefinedBehaviors = readContractSectionItems(unit.undefinedBehaviors);
  return normalizeWorkflowStepContract({
    ...(preconditions ? { preconditions } : {}),
    ...(postconditions.length > 0 ? { postconditions } : {}),
    ...(undefinedBehaviors ? { undefinedBehaviors } : {}),
  });
}

export function renderMissionPlanQaUnitContractLines(
  units: Array<{ readonly title: string; readonly unit: PlanUnit }>,
): string[] {
  const lines = units.flatMap(({ title, unit }) => {
    const contract = renderMissionPlanUnitContractLines(unit);
    return contract.length > 0 ? [`- ${title}`, ...contract.map((line) => `  - ${line}`)] : [];
  });
  return lines.length > 0 ? ["Execution-unit outcome contracts:", ...lines] : [];
}
