import { isChildProcessStartRejectedError } from "@paperclipai/adapter-utils/server-utils";

export type OpenCodeRetryAttempt<T> = {
  readonly attempt: T;
  readonly startBlocked: boolean;
};

/** Preserve the last real OpenCode result when shutdown blocks only a later child. */
export async function runOpenCodeRetryAttempt<T>(
  previous: T,
  retry: () => Promise<T>,
): Promise<OpenCodeRetryAttempt<T>> {
  try {
    return { attempt: await retry(), startBlocked: false };
  } catch (error) {
    if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "additional_start_blocked") {
      throw error;
    }
    return { attempt: previous, startBlocked: true };
  }
}
