import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createAppWorkflowToolStepExecutor } from "../app.js";
import type { WorkflowToolStepExecutionRequest } from "../services/workflow/dag-engine.js";

const request: WorkflowToolStepExecutionRequest = {
  companyId: "company-1",
  workflowRunId: "run-1",
  workflowId: "workflow-1",
  stepId: "publish",
  stepRunId: "step-run-1",
  toolName: "publish",
  args: { value: 7 },
  requestId: "request-1",
  executionGeneration: 3,
  agentId: "agent-1",
  agentName: "Publisher",
};

const deferredBeforeStart = {
  kind: "deferred_before_start" as const,
  version: 1 as const,
  reasonCode: "runtime_shutting_down" as const,
  externalStarted: false as const,
  requestId: request.requestId,
  executionId: request.workflowRunId,
  attemptId: request.stepRunId,
  executionGeneration: 3,
};

function executor(options: {
  plugin?: boolean;
  executePlugin?: ReturnType<typeof vi.fn>;
  executeCore?: ReturnType<typeof vi.fn>;
  complete?: ReturnType<typeof vi.fn>;
  resolveEnv?: ReturnType<typeof vi.fn>;
}) {
  const executePlugin = options.executePlugin ?? vi.fn();
  const executeCore = options.executeCore ?? vi.fn();
  const complete = options.complete ?? vi.fn();
  const resolveEnv = options.resolveEnv ?? vi.fn().mockResolvedValue({ TOKEN: "safe" });
  const run = createAppWorkflowToolStepExecutor({
    db: {} as Db,
    toolDispatcher: {
      getTool: vi.fn().mockReturnValue(options.plugin ? {} : null),
      executeTool: executePlugin,
    } as never,
    executeCoreTool: executeCore,
    completeToolStep: complete,
    resolveStepEnv: resolveEnv,
  });
  return { run, executePlugin, executeCore, complete, resolveEnv };
}

describe("app workflow tool shutdown lifecycle", () => {
  it("returns a plugin deferral before reading its result or submitting completion", async () => {
    const execution = {
      pluginId: "plugin-1",
      toolName: request.toolName,
      deferredBeforeStart,
      get result(): never {
        throw new Error("plugin result must not be read for a deferral");
      },
    };
    const scenario = executor({
      plugin: true,
      executePlugin: vi.fn().mockResolvedValue(execution),
    });

    await expect(scenario.run(request)).resolves.toEqual({ deferredBeforeStart });
    expect(scenario.complete).not.toHaveBeenCalled();
    expect(scenario.executeCore).not.toHaveBeenCalled();
  });

  it("returns a core deferral before status conversion or submitting completion", async () => {
    const coreResult = {
      status: 503,
      deferredBeforeStart,
      get body(): never {
        throw new Error("core body must not be read for a deferral");
      },
    };
    const scenario = executor({ executeCore: vi.fn().mockResolvedValue(coreResult) });

    await expect(scenario.run(request)).resolves.toEqual({ deferredBeforeStart });
    expect(scenario.complete).not.toHaveBeenCalled();
    expect(scenario.resolveEnv).toHaveBeenCalledOnce();
  });

  it("preserves normal plugin result completion", async () => {
    const scenario = executor({
      plugin: true,
      executePlugin: vi.fn().mockResolvedValue({
        pluginId: "plugin-1",
        toolName: request.toolName,
        result: { content: "published", data: { id: 9 } },
      }),
    });

    await expect(scenario.run(request)).resolves.toEqual({ accepted: true });
    expect(scenario.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestId: request.requestId,
      success: true,
      stdout: "published",
      data: { id: 9 },
      exitCode: 0,
    }));
  });

  it("preserves core failures and thrown exceptions", async () => {
    const failed = executor({
      executeCore: vi.fn().mockResolvedValue({
        status: 500,
        body: { error: "tool failed", stderr: "diagnostic" },
      }),
    });
    await expect(failed.run(request)).resolves.toEqual({ accepted: true });
    expect(failed.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      success: false,
      stderr: "diagnostic",
      exitCode: 1,
      error: "tool failed",
    }));

    const thrown = executor({ executeCore: vi.fn().mockRejectedValue(new Error("spawn failed")) });
    await expect(thrown.run(request)).rejects.toThrow("spawn failed");
    expect(thrown.complete).not.toHaveBeenCalled();
  });
});
