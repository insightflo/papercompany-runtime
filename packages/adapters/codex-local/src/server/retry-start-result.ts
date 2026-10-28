import { isChildProcessStartRejectedError } from "@paperclipai/adapter-utils/server-utils";

export type CodexRetryAttempt<T> = {
  readonly attempt: T;
  readonly startBlocked: boolean;
};

/** Preserve the last real Codex result when shutdown blocks only a fresh-session retry. */
export async function runCodexRetryAttempt<T>(
  previous: T,
  retry: () => Promise<T>,
): Promise<CodexRetryAttempt<T>> {
  try {
    return { attempt: await retry(), startBlocked: false };
  } catch (error) {
    if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "additional_start_blocked") {
      throw error;
    }
    return { attempt: previous, startBlocked: true };
  }
}
