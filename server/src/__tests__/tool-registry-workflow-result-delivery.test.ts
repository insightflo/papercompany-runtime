import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT } from "@paperclipai/shared";
import manifest from "../../../packages/plugins/tool-registry/src/manifest.js";
import plugin from "../../../packages/plugins/tool-registry/src/worker.js";
import { ACTION_KEYS } from "../../../packages/plugins/tool-registry/src/constants.js";

describe("tool-registry workflow result delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits native workflow tool results without invoking the workflow-engine bridge", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const fetchSpy = vi.fn(async () => {
      throw new Error("workflow-engine bridge should not be required");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const emittedResults: Array<Record<string, unknown>> = [];
    harness.ctx.events.on(
      "plugin.insightflo.tool-registry.tool-execution-result",
      async (event) => {
        emittedResults.push(event.payload as Record<string, unknown>);
      },
    );

    await harness.performAction(ACTION_KEYS.createTool, {
      companyId: "company-1",
      tool: {
        name: "echo-context",
        command: "/bin/echo native-event",
      },
    });

    await harness.performAction(ACTION_KEYS.executeWorkflowTool, {
      companyId: "company-1",
      requestId: "run-1:fetch-context:1",
      workflowRunId: "run-1",
      workflowId: "workflow-1",
      stepId: "fetch-context",
      stepRunId: "step-run-1",
      toolName: "echo-context",
      args: {},
    });

    await vi.waitFor(() => {
      expect(emittedResults).toHaveLength(1);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emittedResults[0]).toEqual(expect.objectContaining({
      requestId: "run-1:fetch-context:1",
      stepRunId: "step-run-1",
      stepId: "fetch-context",
      workflowRunId: "run-1",
      success: true,
      toolName: "echo-context",
      stdout: "native-event\n",
      exitCode: 0,
    }));
  });

  it("falls back to the workflow-engine bridge when native event delivery fails", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/plugins")) {
        return new Response(JSON.stringify([
          { id: "workflow-engine-install-1", pluginKey: "insightflo.workflow-engine" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (href.endsWith("/api/plugins/workflow-engine-install-1/bridge/action")) {
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${href} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    harness.ctx.events.on(
      "plugin.insightflo.tool-registry.tool-execution-result",
      async () => {
        throw new Error("native workflow handler failed");
      },
    );

    await harness.performAction(ACTION_KEYS.createTool, {
      companyId: "company-1",
      tool: {
        name: "echo-context",
        command: "/bin/echo fallback-event",
      },
    });

    await harness.performAction(ACTION_KEYS.executeWorkflowTool, {
      companyId: "company-1",
      requestId: "run-1:fetch-context:2",
      workflowRunId: "run-1",
      workflowId: "workflow-1",
      stepId: "fetch-context",
      stepRunId: "step-run-2",
      toolName: "echo-context",
      args: {},
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3200/api/plugins");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3200/api/plugins/workflow-engine-install-1/bridge/action",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("\"handle-tool-execution-result\""),
        }),
      );
    });
  });

  it("executes workflow tools from the core workflow tool request event", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const fetchSpy = vi.fn(async () => {
      throw new Error("workflow-engine bridge should not be required");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const emittedResults: Array<Record<string, unknown>> = [];
    harness.ctx.events.on(
      "plugin.insightflo.tool-registry.tool-execution-result",
      async (event) => {
        emittedResults.push(event.payload as Record<string, unknown>);
      },
    );

    await harness.performAction(ACTION_KEYS.createTool, {
      companyId: "company-1",
      tool: {
        name: "echo-context",
        command: "/bin/echo core-request",
      },
    });

    await harness.emit(WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT, {
      companyId: "company-1",
      requestId: "run-1:fetch-context:core",
      workflowRunId: "run-1",
      workflowId: "workflow-1",
      stepId: "fetch-context",
      stepRunId: "step-run-core",
      toolName: "echo-context",
      args: {},
    }, { companyId: "company-1" });

    await vi.waitFor(() => {
      expect(emittedResults).toHaveLength(1);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emittedResults[0]).toEqual(expect.objectContaining({
      requestId: "run-1:fetch-context:core",
      stepRunId: "step-run-core",
      stepId: "fetch-context",
      workflowRunId: "run-1",
      success: true,
      toolName: "echo-context",
      stdout: "core-request\n",
      exitCode: 0,
    }));
  });

  it("deduplicates duplicate workflow tool request events across core and legacy event names", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("workflow-engine bridge should not be required");
    }));

    const emittedResults: Array<Record<string, unknown>> = [];
    harness.ctx.events.on(
      "plugin.insightflo.tool-registry.tool-execution-result",
      async (event) => {
        emittedResults.push(event.payload as Record<string, unknown>);
      },
    );

    await harness.performAction(ACTION_KEYS.createTool, {
      companyId: "company-1",
      tool: {
        name: "slow-context",
        command: "/bin/sh -c 'sleep 0.2; echo once'",
      },
    });

    const payload = {
      companyId: "company-1",
      requestId: "run-1:fetch-context:dedupe",
      workflowRunId: "run-1",
      workflowId: "workflow-1",
      stepId: "fetch-context",
      stepRunId: "step-run-dedupe",
      toolName: "slow-context",
      args: {},
    };
    await Promise.all([
      harness.emit(WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT, payload, { companyId: "company-1" }),
      harness.emit("plugin.insightflo.workflow-engine.execute-tool-request", payload, { companyId: "company-1" }),
    ]);

    await vi.waitFor(() => {
      expect(emittedResults).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(emittedResults).toHaveLength(1);
    expect(emittedResults[0]).toEqual(expect.objectContaining({
      requestId: "run-1:fetch-context:dedupe",
      stepRunId: "step-run-dedupe",
      stdout: "once\n",
      success: true,
    }));
  });
});
