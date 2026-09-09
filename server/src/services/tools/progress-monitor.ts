import { ToolProgressError } from "./progress-policy.js";
import type { ToolProgressHeartbeat, ToolProgressStore } from "./progress-store.js";

/** Reject even if an operation ignores AbortSignal. Its continuation must check the
 * signal before publishing artifacts; abort does not prove remote work stopped. */
export async function withToolProgress<T>(input: {
  store: ToolProgressStore; heartbeat: ToolProgressHeartbeat;
  operation: (signal: AbortSignal) => Promise<T>; succeeded: (value: T) => boolean;
  cleanup?: () => Promise<void>;
}): Promise<T> {
  const { store, heartbeat } = input;
  const controller = new AbortController();
  let stopped = false;
  let timerCleanup: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const fail = (error: Error) => { controller.abort(error); rejectDeadline(error); };
  const totalTimer = setTimeout(() => fail(new ToolProgressError(409, "tool_progress_max_timeout")), heartbeat.policy.maxDurationMs);
  totalTimer.unref?.();
  const poll = async () => {
    try {
      const row = await store.check(heartbeat.companyId, heartbeat.id);
      if (stopped) return;
      if (row.state !== "active") fail(new ToolProgressError(409, row.reason ?? "tool_progress_terminal"));
      else pollTimer = setTimeout(() => void poll(), 1000);
    } catch {
      if (!stopped) fail(new ToolProgressError(500, "tool_progress_db_failure"));
    }
  };
  pollTimer = setTimeout(() => void poll(), Math.min(1000, heartbeat.policy.idleTimeoutMs));
  const operation = (async () => {
    const result = await input.operation(controller.signal);
    controller.signal.throwIfAborted();
    const outcome = input.succeeded(result) ? "succeeded" : "failed";
    const row = await store.finish(heartbeat.companyId, heartbeat.id, outcome, outcome === "failed" ? "tool_progress_execution_failed" : undefined);
    controller.signal.throwIfAborted();
    if (row.state !== outcome) throw new ToolProgressError(409, row.reason ?? "tool_progress_terminal");
    return result;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    controller.abort(error);
    // A failed DB write is deliberately not represented as successful persistence.
    await Promise.race([
      store.finish(heartbeat.companyId, heartbeat.id, "failed",
        error instanceof ToolProgressError ? error.reason : "tool_progress_execution_failed").catch(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2500); timer.unref?.(); timerCleanup = () => clearTimeout(timer); }),
    ]);
    throw error;
  } finally {
    stopped = true;
    clearTimeout(totalTimer);
    clearTimeout(pollTimer);
    timerCleanup?.();
    await input.cleanup?.();
  }
}
