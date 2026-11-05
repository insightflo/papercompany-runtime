import type { Db } from "@paperclipai/db";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { logger } from "../middleware/logger.js";
import { jsonEqual } from "./plugin-tool-receipt-envelope.js";
import type { RetainedToolRequest } from "./plugin-tool-execution-receipt.js";
import type { ObservedToolExecution } from "./plugin-tool-observation.js";
import type { ToolOutcome } from "./plugin-job-rpc.js";
import {
  bindRetainedWorkflowTool,
  finalizeRetainedWorkflowTool,
  releaseRetainedWorkflowToolUnsent,
  type WorkflowToolStepExecutionRequest,
  type WorkflowToolStepExecutionResult,
} from "./workflow/dag-engine.js";

type Dispatcher = Pick<PluginToolDispatcher, "executeToolObserved">;
type Authority = NonNullable<WorkflowToolStepExecutionRequest["originalAuthority"]>;
type UnsentProof = Extract<ObservedToolExecution, { kind: "definitely_unsent" | "deferred_before_start" }>;
type SentObservation = Extract<ObservedToolExecution, { kind: "sent_or_unknown" }>["observation"];
type UnsentResult = NonNullable<WorkflowToolStepExecutionResult["retainedUnsentRelease"]>;
type ConsumerState = "awaiting_actual" | "persisting" | "retry_wait" | "held_unknown" | "held_ack" | "done";
type RetainedActualConsumer = {
  owner: RetainedToolRequest;
  observation: SentObservation;
  actual?: ToolOutcome;
  state: ConsumerState;
  lastFailure?: unknown;
  task?: Promise<void>;
};
const PERSISTENCE_RETRY_MS = 1_000;
const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, PERSISTENCE_RETRY_MS));

function sameOriginalClaim(request: WorkflowToolStepExecutionRequest, authority: Authority | undefined): authority is Authority {
  return !!authority && authority.runStatus === "running" && authority.stepStatus === "running" &&
    authority.workflowRunId === request.workflowRunId && authority.stepRunId === request.stepRunId &&
    authority.stepId === request.stepId && authority.requestId === request.requestId;
}

function heldRelease(owner: RetainedToolRequest): UnsentResult {
  return { kind: "held", receiptId: owner.receiptId, workflow: owner.workflow!, reason: "release_failed" };
}

function releaseMatchesOwner(result: UnsentResult, owner: RetainedToolRequest): boolean {
  return (result.kind === "released" || result.kind === "held") &&
    result.receiptId === owner.receiptId && jsonEqual(result.workflow, owner.workflow);
}

function positiveUnsent(observation: ObservedToolExecution): observation is UnsentProof {
  return observation.kind === "definitely_unsent" || observation.kind === "deferred_before_start";
}

export function createPluginToolConsumer(input: {
  db: Db;
  dispatcher: Dispatcher;
}): (request: WorkflowToolStepExecutionRequest) => Promise<WorkflowToolStepExecutionResult> {
  const activeConsumers = new Set<RetainedActualConsumer>();
  const log = logger.child({ service: "plugin-tool-consumer" });

  const consumeActual = async (record: RetainedActualConsumer): Promise<void> => {
    let actual: ToolOutcome;
    try {
      actual = await record.observation.actual;
      record.actual = actual;
    } catch (error) {
      record.state = "held_unknown";
      record.lastFailure = error;
      log.warn({ error, receiptId: record.owner.receiptId, requestId: record.owner.workflow?.requestId },
        "Plugin workflow actual outcome could not be read; retained ownership remains held");
      return;
    }
    if (actual.kind === "unknown") {
      record.state = "held_unknown";
      record.lastFailure = new Error("actual_outcome_unknown");
      log.warn({ receiptId: record.owner.receiptId, requestId: record.owner.workflow?.requestId },
          "Plugin workflow tool outcome is unknown; retained ownership remains unacknowledged");
      return;
    }

    for (;;) {
      record.state = "persisting";
      try {
        const disposition = await finalizeRetainedWorkflowTool(input.db, record.owner, actual);
        if (disposition.kind !== "applied" && disposition.kind !== "superseded") {
          record.lastFailure = new Error("unexpected_finalizer_disposition");
          record.state = "retry_wait";
          log.warn({ receiptId: record.owner.receiptId, requestId: record.owner.workflow?.requestId },
            "Plugin workflow finalizer returned no committed disposition; retrying the same actual");
          await retryDelay();
          continue;
        }
        let acknowledged = false;
        try { acknowledged = record.observation.acknowledge(); }
        catch (error) { record.lastFailure = error; }
        if (!acknowledged) {
          record.state = "held_ack";
          record.lastFailure ??= new Error("worker_acknowledgement_refused");
          log.warn({ error: record.lastFailure, receiptId: record.owner.receiptId,
            requestId: record.owner.workflow?.requestId },
          "Plugin workflow result is durable but worker acknowledgement was refused");
          return;
        }
        record.state = "done";
        activeConsumers.delete(record);
        return;
      } catch (error) {
        record.state = "retry_wait";
        record.lastFailure = error;
        log.warn({ error, receiptId: record.owner.receiptId, requestId: record.owner.workflow?.requestId },
          "Plugin workflow finalization failed; retrying the same actual");
        await retryDelay();
      }
    }
  };

  return async (request) => {
    if (!sameOriginalClaim(request, request.originalAuthority)) {
      throw new Error("workflow_tool_claim_authority_missing");
    }
    const authority = request.originalAuthority;
    const parameters = request.args ?? {};
    const bound = await bindRetainedWorkflowTool(input.db, {
      companyId: request.companyId, tool: request.toolName, parameters,
      workflow: authority,
    });
    if (bound.kind !== "claim") return { accepted: true };

    let observed: ObservedToolExecution;
    try {
      observed = input.dispatcher.executeToolObserved(request.toolName, parameters, {
        agentId: "workflow-tool-step", runId: request.workflowRunId,
        companyId: request.companyId, projectId: "",
      }, {
        requestId: authority.requestId, executionId: authority.workflowRunId,
        attemptId: authority.stepRunId, executionGeneration: authority.executionGeneration,
      });
    } catch (error) {
      log.warn({ error, receiptId: bound.owner.receiptId, requestId: authority.requestId },
        "Plugin workflow observation failed after retained ownership was bound");
      return { accepted: true };
    }

    if (positiveUnsent(observed)) {
      let result: UnsentResult;
      try {
        result = await releaseRetainedWorkflowToolUnsent(input.db, bound.owner, observed);
        if (!releaseMatchesOwner(result, bound.owner)) result = heldRelease(bound.owner);
      } catch (error) {
        log.warn({ error, receiptId: bound.owner.receiptId, requestId: authority.requestId },
          "Proven-unsent workflow claim release failed; retained ownership remains held");
        result = heldRelease(bound.owner);
      }
      return { accepted: true, retainedUnsentRelease: result };
    }

    if (observed.kind !== "sent_or_unknown") return { accepted: true };
    const record: RetainedActualConsumer = {
      owner: bound.owner, observation: observed.observation, state: "awaiting_actual",
    };
    activeConsumers.add(record);
    record.task = consumeActual(record).catch((error) => {
      record.lastFailure = error;
      record.state = record.actual ? "retry_wait" : "held_unknown";
      log.error({ error, receiptId: record.owner.receiptId, requestId: record.owner.workflow?.requestId },
        "Plugin workflow actual consumer stopped unexpectedly; retained record remains held");
    });
    try {
      await observed.observation.initial;
    } catch (error) {
      log.debug({ error, receiptId: bound.owner.receiptId, requestId: authority.requestId },
        "Initial plugin workflow tool wait ended; the retained actual-result consumer remains active");
    }
    return { accepted: true };
  };
}
