import type { Db } from "@paperclipai/db";

const heartbeatExecutionsByDb = new WeakMap<Db, Set<Promise<void>>>();

export function trackHeartbeatExecution(db: Db, execution: Promise<void>): void {
  let executions = heartbeatExecutionsByDb.get(db);
  if (!executions) {
    executions = new Set();
    heartbeatExecutionsByDb.set(db, executions);
  }
  executions.add(execution);
  void execution.finally(() => {
    executions!.delete(execution);
    if (executions!.size === 0) heartbeatExecutionsByDb.delete(db);
  });
}

export async function waitForHeartbeatExecutionsToDrain(db: Db, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const executions = [...(heartbeatExecutionsByDb.get(db) ?? [])];
    if (executions.length === 0) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(timeoutMs);
    await waitForExecutions(executions, remainingMs, timeoutMs);
  }
}

async function waitForExecutions(executions: Promise<void>[], remainingMs: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(timeoutMs)), remainingMs);
    void Promise.allSettled(executions).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Timed out waiting for heartbeat executions to drain after ${timeoutMs}ms`);
}
