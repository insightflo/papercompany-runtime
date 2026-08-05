import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
} from "../../../packages/plugins/sdk/src/protocol.js";
import { runWorker } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";

const manifest = {
  id: "paperclipai.rpc-invoke-context-test",
  apiVersion: 1,
  version: "0.0.0-test",
  displayName: "RPC Invoke Context Test",
  description: "Exercises agents.invoke context forwarding through the worker RPC transport.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["agents.invoke"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
} as const;

describe("plugin SDK RPC agents.invoke context forwarding", () => {
  const hosts: Array<{ stop: () => void }> = [];

  afterEach(() => {
    while (hosts.length > 0) {
      hosts.pop()?.stop();
    }
  });

  it("forwards issue/comment/taskKey context through the worker RPC transport", async () => {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("plugin.invoke-test", async () => {
          await ctx.agents.invoke("agent-1", "company-1", {
            prompt: "Review the plan",
            reason: "review-requested",
            context: {
              issueId: "issue-1",
              commentId: "comment-1",
              taskKey: "task-1",
            },
          });
        });
      },
    });

    const workerInput = new PassThrough();
    const workerOutput = new PassThrough();
    const workerHost = runWorker(plugin, import.meta.url, {
      stdin: workerInput,
      stdout: workerOutput,
    });

    if (!workerHost) {
      throw new Error("Worker RPC host did not start");
    }

    hosts.push(workerHost);

    const seenInvokes: Array<Record<string, unknown>> = [];
    const responses = new Map<string | number, (message: unknown) => void>();
    let buffer = "";

    const handleLine = (line: string) => {
      const message = parseMessage(line);
      if (isJsonRpcRequest(message)) {
        if (message.method === "events.subscribe") {
          workerInput.write(serializeMessage(createSuccessResponse(message.id, null)));
          return;
        }
        if (message.method === "agents.invoke") {
          seenInvokes.push(message.params as Record<string, unknown>);
          workerInput.write(serializeMessage(createSuccessResponse(message.id, { runId: "run-1" })));
          return;
        }
        throw new Error(`Unexpected worker->host request: ${message.method}`);
      }

      if (isJsonRpcResponse(message)) {
        if (message.id == null) {
          throw new Error("Expected response id");
        }
        responses.get(message.id)?.(message);
      }
    };

    workerOutput.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          handleLine(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    const sendRequest = async (method: string, params: unknown) => {
      const request = createRequest(method, params);
      const responsePromise = new Promise<unknown>((resolve) => {
        responses.set(request.id, resolve);
      });
      workerInput.write(serializeMessage(request));
      const response = await responsePromise;
      responses.delete(request.id);
      if (!isJsonRpcResponse(response)) {
        throw new Error("Expected JSON-RPC response");
      }
      if ("error" in response && response.error) {
        throw new Error(response.error.message);
      }
      return response;
    };

    await new Promise<void>((resolve) => setImmediate(resolve));

    await sendRequest("initialize", {
      manifest,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "test",
      },
      apiVersion: 1,
    });

    await sendRequest("onEvent", {
      event: {
        eventId: "evt-2",
        eventType: "plugin.invoke-test",
        companyId: "company-1",
        occurredAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
        entityId: "plugin-1",
        entityType: "plugin",
        payload: {},
      },
    });

    expect(seenInvokes).toEqual([
      {
        agentId: "agent-1",
        companyId: "company-1",
        prompt: "Review the plan",
        reason: "review-requested",
        context: {
          issueId: "issue-1",
          commentId: "comment-1",
          taskKey: "task-1",
        },
      },
    ]);

    await sendRequest("shutdown", null);
  });
});
