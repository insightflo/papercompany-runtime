export type WorkflowRetryExhaustionSummary = {
  retryAttempts: number;
  retryMaxRetries: number;
};

/**
 * Retry history is capped and cannot prove exact attempts. Only the explicit
 * marker written for decision.reason === "exhausted" is authoritative.
 */
export function summarizeWorkflowRetryExhaustion(
  stepRuns: ReadonlyArray<{ status: string; metadata: unknown }>,
): WorkflowRetryExhaustionSummary | null {
  let totalAttempts = 0;
  let maxRetries = 0;
  let found = false;
  for (const stepRun of stepRuns) {
    if (stepRun.status !== "failed") continue;
    const metadata = stepRun.metadata as Record<string, unknown> | null;
    const marker = metadata?.workflowRetryExhaustion as
      | Record<string, unknown>
      | null
      | undefined;
    const attempts = marker?.attempts;
    const configuredMax = marker?.maxRetries;
    if (
      typeof attempts !== "number"
      || !Number.isFinite(attempts)
      || !Number.isInteger(attempts)
      || attempts < 1
      || typeof configuredMax !== "number"
      || !Number.isFinite(configuredMax)
      || !Number.isInteger(configuredMax)
      || configuredMax < 0
      || attempts !== configuredMax + 1
    ) continue;
    found = true;
    totalAttempts = Math.min(9999, totalAttempts + attempts);
    maxRetries = Math.max(maxRetries, configuredMax);
  }
  return found ? { retryAttempts: totalAttempts, retryMaxRetries: maxRetries } : null;
}
