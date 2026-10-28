import { isChildProcessStartRejectedError } from "@paperclipai/adapter-utils/server-utils";

export type GeminiRetryAttempt<T> = {
  readonly attempt: T;
  readonly startBlocked: boolean;
};

/** Preserve the last real Gemini result when shutdown blocks only a fresh-session retry. */
export async function runGeminiRetryAttempt<T>(
  previous: T,
  retry: () => Promise<T>,
): Promise<GeminiRetryAttempt<T>> {
  try {
    return { attempt: await retry(), startBlocked: false };
  } catch (error) {
    if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "additional_start_blocked") {
      throw error;
    }
    return { attempt: previous, startBlocked: true };
  }
}
