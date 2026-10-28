import { isChildProcessStartRejectedError } from "@paperclipai/adapter-utils/server-utils";

export type ClaudeRetryAttempt<T> = {
  readonly attempt: T;
  readonly startBlocked: boolean;
};

/** Preserve the last real Claude result when shutdown blocks only a later child. */
export async function runClaudeRetryAttempt<T>(
  previous: T,
  retry: () => Promise<T>,
): Promise<ClaudeRetryAttempt<T>> {
  try {
    return { attempt: await retry(), startBlocked: false };
  } catch (error) {
    if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "additional_start_blocked") {
      throw error;
    }
    return { attempt: previous, startBlocked: true };
  }
}
