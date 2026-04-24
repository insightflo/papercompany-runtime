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
  id: "paperclipai.rpc-status-test",
  apiVersion: 1,
  version: "0.0.0-test",
  displayName: "RPC Status Test",
  description: "Exercises SDK issue creation through the worker RPC transport.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["issues.create"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
} as const;

describe("plugin SDK RPC issues.create status forwarding", () => {
  const hosts: Array<{ stop: () => void }> = [];

  afterEach(() => {
    while (hosts.length > 0) {
      hosts.pop()?.stop();
    }
  });

  it("forwards status through the worker RPC transport", async () => {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("issue.created", async () => {
          await ctx.issues.create({
            companyId: "company-1",
            title: "Mirror request",
            status: "blocked",
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

    const seenStatuses: string[] = [];
    const responses = new Map<string | number, (message: unknown) => void>();
    let buffer = "";

    const handleLine = (line: string) => {
      const message = parseMessage(line);
      if (isJsonRpcRequest(message)) {
        if (message.method === "events.subscribe") {
          workerInput.write(serializeMessage(createSuccessResponse(message.id, null)));
          return;
        }
        if (message.method === "issues.create") {
          const params = message.params as { status?: string };
          seenStatuses.push(params.status ?? "");
          workerInput.write(serializeMessage(createSuccessResponse(message.id, {
            id: "issue-1",
            companyId: "company-1",
            projectId: null,
            projectWorkspaceId: null,
            goalId: null,
            parentId: null,
            title: "Mirror request",
            description: null,
            status: params.status ?? "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            createdByAgentId: null,
            createdByUserId: null,
            issueNumber: 1,
            identifier: "RPC-1",
            originKind: "manual",
            originId: null,
            originRunId: null,
            requestDepth: 0,
            billingCode: null,
            assigneeAdapterOverrides: null,
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
            startedAt: null,
            completedAt: null,
            cancelledAt: null,
            hiddenAt: null,
            createdAt: new Date("2026-04-09T00:00:00.000Z"),
            updatedAt: new Date("2026-04-09T00:00:00.000Z"),
          })));
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
        eventId: "evt-1",
        eventType: "issue.created",
        companyId: "company-1",
        occurredAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
        entityId: "source-1",
        entityType: "issue",
        payload: {
          companyId: "company-1",
          issueId: "source-1",
          title: "Source request",
        },
      },
    });

    expect(seenStatuses).toEqual(["blocked"]);

    await sendRequest("shutdown", null);
  });
});
