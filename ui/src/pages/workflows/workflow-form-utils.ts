export function normalizeMaxDailyRunsInput(value: string): { value: number | undefined; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: undefined };
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { value: undefined, error: "maxDailyRuns는 0 이상의 정수여야 합니다." };
  }

  return { value: parsed };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function formatJsonArrayForForm(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

export function parseJsonArrayField(value: string, label: string): { value: unknown[]; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { value: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return { value: [], error: `${label}는 JSON 배열이어야 합니다.` };
    }
    return { value: parsed };
  } catch (error) {
    return { value: [], error: `${label} JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function buildWorkflowInterfaceMetadata(
  currentLegacyMetadata: unknown,
  flowInputsText: string,
  flowEnvVariablesText: string,
  testInputPresetsText: string,
): { value: Record<string, unknown>; error?: string } {
  const parsedInputs = parseJsonArrayField(flowInputsText, "Flow inputs");
  if (parsedInputs.error) return { value: {}, error: parsedInputs.error };
  const parsedEnvVariables = parseJsonArrayField(flowEnvVariablesText, "Flow env variables");
  if (parsedEnvVariables.error) return { value: {}, error: parsedEnvVariables.error };
  const parsedTestInputPresets = parseJsonArrayField(testInputPresetsText, "Saved test inputs");
  if (parsedTestInputPresets.error) return { value: {}, error: parsedTestInputPresets.error };
  return {
    value: {
      ...(isRecord(currentLegacyMetadata) ? currentLegacyMetadata : {}),
      graphFlowInputs: parsedInputs.value,
      graphFlowEnvVariables: parsedEnvVariables.value,
      graphTestInputPresets: parsedTestInputPresets.value,
    },
  };
}
