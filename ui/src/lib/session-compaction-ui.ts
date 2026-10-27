import { resolveSessionCompactionPolicy } from "@paperclipai/adapter-utils";

export function sessionTokenThresholdFieldValue(
  adapterType: string,
  sessionCompaction: Record<string, unknown>,
): number {
  const explicit = sessionCompaction.maxRawInputTokens;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return resolveSessionCompactionPolicy(adapterType, {}).policy.maxRawInputTokens;
}

export function updateSessionTokenThreshold(
  sessionCompaction: Record<string, unknown>,
  value: number,
): Record<string, unknown> {
  return {
    ...sessionCompaction,
    maxRawInputTokens: Math.max(0, Math.floor(value)),
  };
}
