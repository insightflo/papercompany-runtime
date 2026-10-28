import { isChildProcessStartRejectedError } from "@paperclipai/adapter-utils/server-utils";

export type CursorRetryAttempt<T> = {
  readonly attempt: T;
  readonly startBlocked: boolean;
};

/** Preserve the last real Cursor result when shutdown blocks only a fresh-session retry. */
export async function runCursorRetryAttempt<T>(
  previous: T,
  retry: () => Promise<T>,
): Promise<CursorRetryAttempt<T>> {
  try {
    return { attempt: await retry(), startBlocked: false };
  } catch (error) {
    if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "additional_start_blocked") {
      throw error;
    }
    return { attempt: previous, startBlocked: true };
  }
}
