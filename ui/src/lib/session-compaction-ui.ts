import { resolveSessionCompactionPolicy } from "@paperclipai/adapter-utils";

export function sessionTokenThresholdFieldValue(
  adapterType: string,
  sessionCompaction: Record<string, unknown>,
): number {
  const resolved = resolveSessionCompactionPolicy(adapterType, {
    heartbeat: { sessionCompaction },
  });
  return resolved.explicitOverride.maxRawInputTokens ?? resolved.policy.maxRawInputTokens;
}

export function updateSessionTokenThreshold(
  sessionCompaction: Record<string, unknown>,
  value: number,
  adapterDefault?: number,
): Record<string, unknown> {
  const normalizedValue = Number.isFinite(value) ? value : 0;
  const maxRawInputTokens = Math.max(0, Math.floor(normalizedValue));
  if (adapterDefault !== undefined && maxRawInputTokens === adapterDefault) {
    const next = { ...sessionCompaction };
    delete next.maxRawInputTokens;
    return next;
  }
  return {
    ...sessionCompaction,
    maxRawInputTokens,
  };
}
