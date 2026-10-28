import { AsyncLocalStorage } from "node:async_hooks";

export type ChildProcessDeferredBeforeStart = {
  readonly kind: "deferred_before_start";
  readonly deferred: {
    readonly kind: "deferred_before_start";
    readonly version: 1;
    readonly reasonCode: "runtime_shutting_down";
    readonly externalStarted: false;
  } & ChildProcessExecutionIdentity;
};

export type ChildProcessAdditionalStartBlocked = {
  readonly kind: "additional_start_blocked";
  readonly reasonCode: "runtime_shutting_down";
  readonly externalStarted: true;
};

export type ChildProcessExecutionIdentity = {
  readonly requestId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly executionGeneration: number;
};

export type ChildProcessStartDecision<T> =
  | { readonly kind: "started"; readonly value: T; readonly externalStarted: true }
  | ChildProcessDeferredBeforeStart
  | ChildProcessAdditionalStartBlocked;

export interface ChildProcessStartScope {
  readonly identity: ChildProcessExecutionIdentity;
  hasExternalStart(): boolean;
  start<T>(startExternal: () => T): ChildProcessStartDecision<T>;
}

export type ChildProcessStartRejection =
  | ChildProcessDeferredBeforeStart
  | ChildProcessAdditionalStartBlocked;

export class ChildProcessStartRejectedError extends Error {
  readonly code = "child_process_start_rejected";

  constructor(readonly decision: ChildProcessStartRejection) {
    super("Child process start was rejected by the runtime boundary");
    this.name = "ChildProcessStartRejectedError";
  }
}

const activeChildProcessStartScope = new AsyncLocalStorage<ChildProcessStartScope>();

/**
 * Carries one runtime execution scope across adapter awaits without changing
 * the public adapter execute or runChildProcess signatures.
 */
export function withChildProcessStartBoundary<T>(scope: ChildProcessStartScope, run: () => T): T {
  return activeChildProcessStartScope.run(scope, run);
}

/**
 * Synchronously checks the active scope and initiates the child in the same
 * call stack. Production spawn sites opt into this only after all retry
 * consumers understand ChildProcessStartRejectedError.
 */
export function startChildProcessAtBoundary<T>(start: () => T): T {
  const scope = activeChildProcessStartScope.getStore();
  if (!scope) return start();
  const decision = scope.start(start);
  if (decision.kind === "started") return decision.value;
  throw new ChildProcessStartRejectedError(decision);
}

export function isChildProcessStartRejectedError(value: unknown): value is ChildProcessStartRejectedError {
  return value instanceof ChildProcessStartRejectedError;
}
