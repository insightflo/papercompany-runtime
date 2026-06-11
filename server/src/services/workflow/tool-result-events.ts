import type { Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginEventBus } from "../plugin-event-bus.js";
import { completeWorkflowToolStepFromResult } from "./dag-engine.js";

const NATIVE_WORKFLOW_TOOL_RESULT_SUBSCRIBER_ID = "paperclip.native-workflow-engine";
const TOOL_REGISTRY_RESULT_EVENT = "plugin.insightflo.tool-registry.tool-execution-result";
const LEGACY_CORE_RESULT_EVENT = "tool-execution-result";

function eventPayload(event: PluginEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function registerNativeWorkflowToolResultEventHandlers(
  db: Db,
  eventBus: PluginEventBus,
): void {
  const scopedBus = eventBus.forPlugin(NATIVE_WORKFLOW_TOOL_RESULT_SUBSCRIBER_ID);

  const handleToolExecutionResult = async (event: PluginEvent) => {
    const payload = eventPayload(event);
    const stepRunId = optionalString(payload.stepRunId);
    if (!stepRunId) return;

    await completeWorkflowToolStepFromResult(db, {
      companyId: event.companyId,
      stepRunId,
      success: payload.success === true,
      requestId: optionalString(payload.requestId),
      workflowRunId: optionalString(payload.workflowRunId),
      stepId: optionalString(payload.stepId),
      toolName: optionalString(payload.toolName),
      stdout: typeof payload.stdout === "string" ? payload.stdout : undefined,
      stderr: typeof payload.stderr === "string" ? payload.stderr : undefined,
      exitCode: optionalExitCode(payload.exitCode),
      error: typeof payload.error === "string" ? payload.error : undefined,
    });
  };

  scopedBus.subscribe(TOOL_REGISTRY_RESULT_EVENT, handleToolExecutionResult);
  scopedBus.subscribe(LEGACY_CORE_RESULT_EVENT as never, handleToolExecutionResult);
}
