import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentParams, execute, resolveClaimedApiKeyPath, resolveSessionKey } from "./execute.js";

type Frame = {
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
};

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startGateway(options: { rejectFirstProtocol?: boolean }): Promise<{
  url: string;
  frames: Frame[];
  connectRanges: Array<[number, number]>;
}> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  const frames: Frame[] = [];
  const connectRanges: Array<[number, number]> = [];
  let connectionNumber = 0;

  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    connectionNumber += 1;
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: `nonce-${connectionNumber}` },
      }),
    );

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      if (frame.method === "connect") {
        const minProtocol = Number(frame.params?.minProtocol);
        const maxProtocol = Number(frame.params?.maxProtocol);
        connectRanges.push([minProtocol, maxProtocol]);
        if (options.rejectFirstProtocol && connectionNumber === 1) {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "UNSUPPORTED_PROTOCOL", message: "protocol range rejected" },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { protocol: maxProtocol },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId: "run-1",
                state: "delta",
                deltaText: "hello",
                seq: 1,
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId: "run-1",
                state: "final",
                message: { content: "hello world" },
                seq: 2,
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { status: "ok", result: { text: "payload result" } },
            }),
          );
        }, 10);
      }
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  return { url: `ws://127.0.0.1:${address.port}`, frames, connectRanges };
}

function buildContext(url: string): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gateway worker",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url,
      disableDeviceAuth: true,
      timeoutSec: 5,
      agentId: "agent-1",
      payloadTemplate: { customField: "custom-value" },
      claimedApiKeyPath: "~/.openclaw/workspace/keys/meridian.json",
    },
    context: {
      issueId: "issue-1",
      paperclipWorkspace: {
        cwd: "/tmp/workspace",
        workspaceId: "workspace-1",
      },
      paperclipRuntimeServiceIntents: [
        { serviceName: "preview", lifecycle: "ephemeral", desired: true },
      ],
    },
    onLog: async () => {},
  };
}

describe("openclaw_gateway execute", () => {
  it("sends the negotiated range, standardized workspace payload, and agent-scoped session", async () => {
    const gateway = await startGateway({});
    const result = await execute(buildContext(gateway.url));
    const connect = gateway.frames.find((frame) => frame.method === "connect");
    const agent = gateway.frames.find((frame) => frame.method === "agent");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello world");
    expect(connect?.params).toMatchObject({ minProtocol: 3, maxProtocol: 4 });
    expect(agent?.params).toMatchObject({
      sessionKey: "agent:agent-1:paperclip:issue:issue-1",
    });
    expect(agent?.params).not.toHaveProperty("customField");
    expect(agent?.params).not.toHaveProperty("paperclip");
    expect(String(agent?.params?.message)).toContain('"unsupportedPayloadTemplate":{"customField":"custom-value"}');
    expect(String(agent?.params?.message)).toContain('"workspaceRuntime"');
    expect(String(agent?.params?.message)).toContain("~/.openclaw/workspace/keys/meridian.json");
  });

  it("uses a payload-template agentId for both routing and session scope", async () => {
    const gateway = await startGateway({});
    const context = buildContext(gateway.url);
    context.config.payloadTemplate = { agentId: "agent-override" };

    const result = await execute(context);
    const agent = gateway.frames.find((frame) => frame.method === "agent");

    expect(result.exitCode).toBe(0);
    expect(agent?.params).toMatchObject({
      agentId: "agent-override",
      sessionKey: "agent:agent-override:paperclip:issue:issue-1",
    });
  });

  it("falls back once to v3 only after a structured protocol rejection", async () => {
    const gateway = await startGateway({ rejectFirstProtocol: true });
    const result = await execute(buildContext(gateway.url));

    expect(result.exitCode).toBe(0);
    expect(gateway.connectRanges).toEqual([
      [3, 4],
      [3, 3],
    ]);
  });
});

describe("openclaw_gateway package contracts", () => {
  it("prefixes configured session keys without double-routing", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-1",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-1",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("uses a configured claimed API-key path and strips unsupported paperclip roots", () => {
    expect(resolveClaimedApiKeyPath("~/.openclaw/workspace/keys/meridian.json")).toBe(
      "~/.openclaw/workspace/keys/meridian.json",
    );
    expect(resolveClaimedApiKeyPath(" ")).toBe("~/.openclaw/workspace/paperclip-claimed-api-key.json");
    const params = buildAgentParams({
      payloadTemplate: { paperclip: { stale: true }, text: "old", keep: "value" },
      message: "wake",
      sessionKey: "agent:meridian:paperclip",
      runId: "run-1",
      configuredAgentId: "meridian",
      waitTimeoutMs: 30_000,
    });
    expect(params).toEqual({
      message: "wake",
      sessionKey: "agent:meridian:paperclip",
      idempotencyKey: "run-1",
      agentId: "meridian",
      timeout: 30_000,
    });
    expect(params).not.toHaveProperty("keep");
  });
});
