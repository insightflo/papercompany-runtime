import {
  createRequest, isJsonRpcSuccessResponse, JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES, serializeMessage,
} from "@paperclipai/plugin-sdk";
import type { HostToWorkerMethodName, HostToWorkerMethods, JsonRpcId, JsonRpcResponse } from "@paperclipai/plugin-sdk";

export type JobOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; error: string }
  | { kind: "unknown" };

export type ObservedJob =
  | { kind: "definitely_unsent" }
  | {
      kind: "sent_or_unknown";
      initial: Promise<"settled" | "timeout" | "unknown">;
      actual: Promise<JobOutcome>;
      state(): "pending" | "settled" | "unknown";
      release(): void;
    };

export interface PendingRequest {
  id: JsonRpcId;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: JsonRpcResponse): void;
  fail(error: Error): void;
}

/** Retains a particular worker until its caller acknowledges durable finalization. */
export function createJobRetention() {
  const retained = new Set<Promise<void>>();
  return {
    retain() {
      let release!: () => void;
      const done = new Promise<void>((resolve) => { release = resolve; });
      retained.add(done);
      return () => { retained.delete(done); release(); };
    },
    count: () => retained.size,
    async drain() {
      while (retained.size) await Promise.all([...retained]);
    },
  };
}

export function createWorkerRpc(input: {
  pluginId: string;
  pending: Map<string | number, PendingRequest>;
  canSend(): boolean;
  send(serialized: string): void;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  retention: ReturnType<typeof createJobRetention>;
}) {
  let nextRequestId = 1;
  const timeoutFor = (timeout?: number) => Math.min(timeout ?? input.defaultTimeoutMs, input.maxTimeoutMs);

  function call<M extends HostToWorkerMethodName>(
    method: M, params: HostToWorkerMethods[M][0], timeoutMs?: number,
  ): Promise<HostToWorkerMethods[M][1]> {
    return new Promise((resolve, reject) => {
      if (!input.canSend()) {
        reject(new Error(`Cannot call "${method}" — worker for "${input.pluginId}" is not running`));
        return;
      }
      const id = nextRequestId++;
      const timeout = timeoutFor(timeoutMs);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.pending.delete(id);
        fn();
      };
      const timer = setTimeout(() => settle(() => reject(new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: `RPC call "${method}" timed out after ${timeout}ms`,
      }))), timeout);
      input.pending.set(id, {
        id, timer,
        resolve(response) {
          if (isJsonRpcSuccessResponse(response)) settle(() => resolve(response.result as HostToWorkerMethods[M][1]));
          else if ("error" in response && response.error) settle(() => reject(new JsonRpcCallError(response.error)));
          else settle(() => reject(new Error(`Unexpected response format for "${method}"`)));
        },
        fail(error) { settle(() => reject(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE, message: error.message }))); },
      });
      try {
        input.send(serializeMessage(createRequest(method, params, id)));
      } catch (error) {
        settle(() => reject(new Error(`Failed to send "${method}" to worker: ${error instanceof Error ? error.message : String(error)}`)));
      }
    });
  }

  function observeJob(params: HostToWorkerMethods["runJob"][0], timeoutMs?: number): ObservedJob {
    if (!input.canSend()) return { kind: "definitely_unsent" };
    const id = nextRequestId++;
    let serialized: string;
    try { serialized = serializeMessage(createRequest("runJob", params, id)); }
    catch { return { kind: "definitely_unsent" }; }

    const release = input.retention.retain();
    let state: "pending" | "settled" | "unknown" = "pending";
    let resolveInitial!: (value: "settled" | "timeout" | "unknown") => void;
    let resolveActual!: (value: JobOutcome) => void;
    const initial = new Promise<"settled" | "timeout" | "unknown">((resolve) => { resolveInitial = resolve; });
    const actual = new Promise<JobOutcome>((resolve) => { resolveActual = resolve; });
    const timer = setTimeout(() => resolveInitial("timeout"), timeoutFor(timeoutMs));
    input.pending.set(id, {
      id, timer,
      resolve(response) {
        state = "settled";
        if (isJsonRpcSuccessResponse(response)) resolveActual({ kind: "succeeded" });
        else if ("error" in response && response.error) resolveActual({ kind: "failed", error: response.error.message });
        else { state = "unknown"; resolveActual({ kind: "unknown" }); }
        resolveInitial(state);
      },
      fail() { state = "unknown"; resolveActual({ kind: "unknown" }); resolveInitial("unknown"); },
    });
    // An exception from write may occur after bytes were accepted. Keep correlation.
    try { input.send(serialized); } catch { resolveInitial("unknown"); }
    return { kind: "sent_or_unknown", initial, actual, state: () => state, release };
  }
  return { call, observeJob };
}
