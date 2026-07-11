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

export function renderMissionPlanQaUnitContractLines(
  units: Array<{ readonly title: string; readonly unit: PlanUnit }>,
): string[] {
  const lines = units.flatMap(({ title, unit }) => {
    const contract = renderMissionPlanUnitContractLines(unit);
    return contract.length > 0 ? [`- ${title}`, ...contract.map((line) => `  - ${line}`)] : [];
  });
  return lines.length > 0 ? ["Execution-unit outcome contracts:", ...lines] : [];
}
