import type { WorkflowStep } from "./dag-engine.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


export function isCacheEnabled(step: WorkflowStep): boolean {
  return step.executionControls?.cacheEnabled === true;
}


export function getCacheTtlSeconds(step: WorkflowStep): number | undefined {
  return typeof step.executionControls?.cacheTtlSeconds === "number" && step.executionControls.cacheTtlSeconds > 0
    ? step.executionControls.cacheTtlSeconds
    : undefined;
}

