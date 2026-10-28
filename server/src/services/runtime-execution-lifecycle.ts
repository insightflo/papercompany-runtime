import { z } from "zod";

export const runtimeExecutionIdentitySchema = z.object({
  requestId: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  executionGeneration: z.number().int().nonnegative(),
}).strict();

export type RuntimeExecutionIdentity = z.infer<typeof runtimeExecutionIdentitySchema>;

export const deferredBeforeStartSchema = runtimeExecutionIdentitySchema.extend({
  kind: z.literal("deferred_before_start"),
  version: z.literal(1),
  reasonCode: z.literal("runtime_shutting_down"),
  externalStarted: z.literal(false),
}).strict();

export type DeferredBeforeStart = z.infer<typeof deferredBeforeStartSchema>;

export type RuntimeStartDecision<T> =
  | { kind: "started"; value: T; externalStarted: true }
  | { kind: "deferred_before_start"; deferred: DeferredBeforeStart }
  | {
      kind: "additional_start_blocked";
      reasonCode: "runtime_shutting_down";
      externalStarted: true;
    };

export type RuntimeShutdownState = {
  signal: "SIGINT" | "SIGTERM";
  startedAt: Date;
};

export interface RuntimeExecutionScope {
  readonly identity: RuntimeExecutionIdentity;
  hasExternalStart(): boolean;
  start<T>(startExternal: () => T): RuntimeStartDecision<T>;
}

export interface RuntimeExecutionLifecycle {
  createScope(identity: RuntimeExecutionIdentity): RuntimeExecutionScope;
  beginShutdown(signal: RuntimeShutdownState["signal"]): {
    changed: boolean;
    state: RuntimeShutdownState;
  };
  shutdownState(): RuntimeShutdownState | null;
}

/**
 * Process-local fence for new external work. A scope that crossed the fence may
 * still settle after shutdown begins; only a later independent start is denied.
 * The callback must synchronously initiate the external effect, leaving no await
 * between the final lifecycle check and spawn/fetch/RPC initiation.
 */
export function createRuntimeExecutionLifecycle(
  now: () => Date = () => new Date(),
): RuntimeExecutionLifecycle {
  let shutdown: RuntimeShutdownState | null = null;

  return {
    createScope(rawIdentity) {
      const identity = runtimeExecutionIdentitySchema.parse(rawIdentity);
      let externalStartCount = 0;

      return {
        identity,
        hasExternalStart: () => externalStartCount > 0,
        start<T>(startExternal: () => T): RuntimeStartDecision<T> {
          if (shutdown) {
            if (externalStartCount > 0) {
              return {
                kind: "additional_start_blocked",
                reasonCode: "runtime_shutting_down",
                externalStarted: true,
              };
            }
            return {
              kind: "deferred_before_start",
              deferred: {
                kind: "deferred_before_start",
                version: 1,
                reasonCode: "runtime_shutting_down",
                externalStarted: false,
                ...identity,
              },
            };
          }

          const value = startExternal();
          externalStartCount += 1;
          return { kind: "started", value, externalStarted: true };
        },
      };
    },

    beginShutdown(signal) {
      if (shutdown) return { changed: false, state: shutdown };
      shutdown = { signal, startedAt: now() };
      return { changed: true, state: shutdown };
    },

    shutdownState() {
      return shutdown;
    },
  };
}

export const runtimeExecutionLifecycle = createRuntimeExecutionLifecycle();
