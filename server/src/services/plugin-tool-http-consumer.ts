import type { Db } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { condenseDuplicateToolErrorBody } from "./tool-result-hygiene.js";
import { logger } from "../middleware/logger.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import {
  claimRetainedKeyedToolReceipt,
  completeRetainedToolReceipt,
  insertInternalToolReceipt,
  releaseRetainedHttpToolUnsentReceipt,
  stageRetainedToolOutcome,
  type RetainedResponse,
  type RetainedToolRequest,
} from "./plugin-tool-execution-receipt.js";
import type { ObservedToolExecution } from "./plugin-tool-observation.js";
import type { ToolOutcome } from "./plugin-job-rpc.js";

type Dispatcher = Pick<PluginToolDispatcher, "executeToolObserved">;
type HttpResponse = { status: number; body: unknown };
type HttpDecision = HttpResponse & { replay?: true };
type Finalization = { kind: "acknowledged"; response: RetainedResponse } | { kind: "held" };
const PERSIST_RETRY_MS = 1_000;
const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, PERSIST_RETRY_MS));
type RetainedConsumer = {
  owner: RetainedToolRequest;
  observation: Extract<ObservedToolExecution, { kind: "sent_or_unknown" }>["observation"];
  actual?: ToolOutcome;
  state: "awaiting_actual" | "persisting" | "retry_wait" | "held_unknown" | "held_ack" | "done";
  lastFailure?: unknown;
  firstAttempt: Promise<Finalization>;
  task: Promise<Finalization>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyError(error: unknown, runId: string, tool: string, condense = true): HttpResponse {
  const message = messageOf(error);
  const status = message.includes("not running") || message.includes("worker") ? 502 : 500;
  const body = { error: message };
  return {
    status,
    body: condense ? condenseDuplicateToolErrorBody({ runId, tool, status, body }).body : body,
  };
}

function responseForActual(owner: RetainedToolRequest, actual: Exclude<ToolOutcome, { kind: "unknown" }>, displayRunId: string): RetainedResponse {
  if (actual.kind === "error") {
    const error = new JsonRpcCallError(actual.error);
    const response = legacyError(error, displayRunId, owner.tool);
    return { status: response.status, body: response.body as RetainedResponse["body"] };
  }
  const body = { pluginId: owner.tool.slice(0, owner.tool.lastIndexOf(":")),
    toolName: owner.tool.slice(owner.tool.lastIndexOf(":") + 1), result: actual.result };
  return {
    status: 200,
    body: condenseDuplicateToolErrorBody({
      runId: displayRunId, tool: owner.tool, status: 200, body, errorPath: "result.error",
    }).body as RetainedResponse["body"],
  };
}

function timeoutError(error: unknown): boolean {
  return error instanceof JsonRpcCallError && error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT;
}

export function createPluginToolHttpConsumer(input: { db: Db; dispatcher: Dispatcher }) {
  const active = new Set<RetainedConsumer>();
  const log = logger.child({ service: "plugin-tool-http-consumer" });

  function retainActual(owner: RetainedToolRequest, displayRunId: string,
    observation: Extract<ObservedToolExecution, { kind: "sent_or_unknown" }>["observation"]): RetainedConsumer {
    let finishFirstAttempt!: (result: Finalization) => void;
    const firstAttempt = new Promise<Finalization>((resolve) => { finishFirstAttempt = resolve; });
    const retained: RetainedConsumer = {
      owner, observation, state: "awaiting_actual", firstAttempt, task: Promise.resolve({ kind: "held" }),
    };
    active.add(retained);
    retained.task = (async (): Promise<Finalization> => {
      let actual: ToolOutcome;
      try { actual = await observation.actual; }
      catch (error) {
        retained.state = "held_unknown";
        log.error({ error, receiptId: owner.receiptId }, "HTTP plugin actual-outcome observation rejected; retention remains held");
        finishFirstAttempt({ kind: "held" });
        return { kind: "held" };
      }
      retained.actual = actual;
      if (actual.kind === "unknown") {
        retained.state = "held_unknown";
        log.warn({ receiptId: owner.receiptId }, "HTTP plugin tool outcome is unknown; receipt and worker remain retained");
        finishFirstAttempt({ kind: "held" });
        return { kind: "held" };
      }
      const response = responseForActual(owner, actual, displayRunId);
      let first = true, staged = false;
      for (;;) {
        retained.state = "persisting";
        try {
          if (!staged) { await stageRetainedToolOutcome(input.db, owner, actual); staged = true; }
          await completeRetainedToolReceipt(input.db, owner, actual, { response });
        } catch (error) {
          retained.lastFailure = error;
          if (first) finishFirstAttempt({ kind: "held" });
          log.error({ error, receiptId: owner.receiptId }, "HTTP plugin tool persistence failed; retrying the same actual result");
          first = false;
          retained.state = "retry_wait";
          await retryDelay();
          continue;
        }

        let acknowledged: boolean;
        try { acknowledged = observation.acknowledge(); }
        catch (error) {
          retained.state = "held_ack"; retained.lastFailure = error;
          log.error({ error, receiptId: owner.receiptId }, "HTTP plugin result is durable but acknowledgement threw; retention remains held");
          if (first) finishFirstAttempt({ kind: "held" });
          return { kind: "held" };
        }
        if (!acknowledged) {
          retained.state = "held_ack";
          log.warn({ receiptId: owner.receiptId }, "HTTP plugin result is durable but its worker retention is still held");
          if (first) finishFirstAttempt({ kind: "held" });
          return { kind: "held" };
        }
        retained.state = "done";
        active.delete(retained);
        const result: Finalization = { kind: "acknowledged", response };
        if (first) finishFirstAttempt(result);
        return result;
      }
    })();
    return retained;
  }

  return async function execute(inputArgs: {
    tool: string; parameters: unknown; runContext: ToolRunContext; idempotencyKey: string | null;
  }): Promise<HttpDecision> {
    const displayRunId = String(inputArgs.runContext.runId);
    let owner: RetainedToolRequest;
    try {
      if (inputArgs.idempotencyKey !== null) {
        const claim = await claimRetainedKeyedToolReceipt(input.db, {
          companyId: inputArgs.runContext.companyId,
          runId: String(inputArgs.runContext.runId),
          tool: inputArgs.tool,
          idempotencyKey: inputArgs.idempotencyKey,
          parameters: inputArgs.parameters ?? {},
        });
        if (claim.kind === "replay") return { status: claim.status, body: claim.body, replay: true };
        if (claim.kind === "in-progress") return {
          status: 409, body: { error: "Tool execution already in progress for this idempotency key" },
        };
        owner = claim.owner;
      } else {
        owner = await insertInternalToolReceipt(input.db, {
          companyId: inputArgs.runContext.companyId, tool: inputArgs.tool,
          parameters: inputArgs.parameters ?? {}, consumer: "http-internal", httpRunId: displayRunId,
        });
      }
    } catch (error) {
      log.error({ error, tool: inputArgs.tool }, "Unable to claim HTTP plugin tool receipt before send");
      return { status: 500, body: { error: "Unable to record plugin tool execution before send" } };
    }

    const identity = {
      requestId: owner.receiptId,
      executionId: owner.identity.runId,
      attemptId: owner.receiptId,
      executionGeneration: 1,
    };
    const runContext = { ...inputArgs.runContext, companyId: owner.companyId, runId: identity.executionId };
    let observed: ObservedToolExecution;
    try {
      observed = input.dispatcher.executeToolObserved(inputArgs.tool, inputArgs.parameters ?? {}, runContext, identity);
    } catch (error) {
      return legacyError(error, displayRunId, owner.tool);
    }

    if (observed.kind === "definitely_unsent" || observed.kind === "deferred_before_start") {
      try {
        const release = await releaseRetainedHttpToolUnsentReceipt(input.db, owner, observed);
        if (release.kind !== "released" || release.receiptId !== owner.receiptId) {
          const reason = release.kind === "held" ? release.reason : "receipt_id_mismatch";
          log.warn({ receiptId: owner.receiptId, reason }, "Positive-unsent HTTP receipt release was held");
          return { status: 500, body: { error: "Could not safely release the unsent plugin tool receipt" } };
        }
      } catch (error) {
        log.error({ error, receiptId: owner.receiptId }, "Positive-unsent HTTP receipt release failed");
        return { status: 500, body: { error: "Could not safely release the unsent plugin tool receipt" } };
      }
      return observed.kind === "deferred_before_start"
        ? { status: 503, body: { deferredBeforeStart: observed.deferredBeforeStart } }
        : { status: 502, body: { error: `Cannot call "executeTool" — worker for "${observed.pluginId}" is not running` } };
    }

    const retained = retainActual(owner, displayRunId, observed.observation);
    const initial = observed.observation.initial.then(
      (result) => ({ kind: "result" as const, result, state: observed.observation.state() }),
      (error: unknown) => ({ kind: "error" as const, error, state: observed.observation.state() }),
    );
    const first = await initial;
    if (first.kind === "result" || first.state === "settled") {
      const final = await retained.firstAttempt;
      if (final.kind === "acknowledged") return final.response;
      return { status: 500, body: { error: "Plugin tool result could not be durably recorded" } };
    }

    // TIMEOUT is provisional: return the existing first-wait response verbatim and never emit again.
    return legacyError(first.error, displayRunId, owner.tool, !timeoutError(first.error));
  };
}
