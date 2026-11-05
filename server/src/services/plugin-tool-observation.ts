import type { ExecuteToolParams, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ObservedTool } from "./plugin-job-rpc.js";
import type { RegisteredTool } from "./plugin-tool-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type {
  DeferredBeforeStart, RuntimeExecutionIdentity, RuntimeExecutionLifecycle,
} from "./runtime-execution-lifecycle.js";

type ToolLookup = {
  namespacedName: string;
  parseName(name: string): { pluginId: string; toolName: string } | null;
  byNamespace: Map<string, RegisteredTool>;
  workerManager?: PluginWorkerManager;
};

/** Keep ordinary and observed execution on the same name and registration checks. */
export function resolvePluginTool(input: ToolLookup) {
  const { namespacedName, workerManager } = input;
  const parsed = input.parseName(namespacedName);
  if (!parsed) {
    throw new Error(
      `Invalid tool name "${namespacedName}". Expected format: "<pluginId>:<toolName>"`,
    );
  }
  const tool = input.byNamespace.get(namespacedName);
  if (!tool) {
    throw new Error(
      `Tool "${namespacedName}" is not registered. ` +
      `The plugin may not be installed or its worker may not be running.`,
    );
  }
  if (!workerManager) {
    throw new Error(
      `Cannot execute tool "${namespacedName}" — no worker manager configured. ` +
      `Tool execution requires a PluginWorkerManager.`,
    );
  }
  return { ...parsed, dbId: tool.pluginDbId, workerManager };
}

type ObservedRouting = {
  pluginId: string;
  toolName: string;
  identity: RuntimeExecutionIdentity;
};

/** The retained observation is owned by the future durable-result consumer. */
export type ObservedToolExecution = ObservedRouting & (
  | { kind: "deferred_before_start"; deferredBeforeStart: DeferredBeforeStart }
  | { kind: "definitely_unsent" }
  | { kind: "sent_or_unknown"; observation: Extract<ObservedTool, { kind: "sent_or_unknown" }> }
);

export function observePluginTool(input: ToolLookup & {
  parameters: unknown;
  runContext: ToolRunContext;
  identity: RuntimeExecutionIdentity;
  runtimeLifecycle: RuntimeExecutionLifecycle;
}): ObservedToolExecution {
  const { pluginId, toolName, dbId, workerManager } = resolvePluginTool(input);
  const scope = input.runtimeLifecycle.createScope(input.identity);
  if (scope.identity.requestId !== input.identity.requestId ||
    scope.identity.executionId !== input.identity.executionId ||
    scope.identity.attemptId !== input.identity.attemptId) {
    throw new Error("Tool execution identity must use canonical values");
  }
  if (scope.identity.executionId !== input.runContext.runId) {
    throw new Error("Tool execution identity does not match run context");
  }
  const rpcParams: ExecuteToolParams = {
    toolName, parameters: input.parameters, runContext: input.runContext,
  };
  const decision = scope.start(() => workerManager.observeTool(dbId, rpcParams));
  const routing = { pluginId, toolName, identity: scope.identity };
  if (decision.kind === "deferred_before_start") {
    return { ...routing, kind: "deferred_before_start", deferredBeforeStart: decision.deferred };
  }
  if (decision.kind === "additional_start_blocked") {
    throw new Error("runtime_additional_start_blocked");
  }
  const observation = decision.value;
  if (observation.kind === "definitely_unsent") return { ...routing, kind: "definitely_unsent" };
  return { ...routing, kind: "sent_or_unknown", observation };
}
