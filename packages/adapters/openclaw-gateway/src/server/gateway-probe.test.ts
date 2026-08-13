import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { probeGateway } from "./gateway-probe.js";

const servers: WebSocketServer[] = [];
const sockets = new Set<WebSocket>();

function listen(handler: (socket: WebSocket) => void): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${port}` });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      handler(socket);
    });
  });
}

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  for (const server of servers) server.close();
  servers.length = 0;
});

function sendJson(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

function connectChallenge(nonce: string): Record<string, unknown> {
  return { type: "event", event: "connect.challenge", payload: { nonce } };
}

type ProbeInput = {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  password: string | null;
  role: string;
  scopes: string[];
  protocol: { minProtocol: 3 | 4; maxProtocol: 3 | 4; fallbackProtocol: 3 | 4 | null };
  timeoutMs: number;
};

function baseInput(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    url: "",
    headers: {},
    authToken: null,
    password: null,
    role: "operator",
    scopes: ["operator.admin"],
    protocol: { minProtocol: 3, maxProtocol: 4, fallbackProtocol: 3 },
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("openclaw_gateway probeGateway", () => {
  it("answers a connect.challenge with the expected connect frame", async () => {
    const connectFrame = new Promise<Record<string, unknown>>((resolve) => {
      void listen((socket) => {
        sendJson(socket, connectChallenge("nonce-1"));
        socket.on("message", (raw) => {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
          resolve(frame);
          sendJson(socket, { type: "res", id: frame.id, ok: true });
        });
      }).then(({ url }) => {
        void probeGateway(
          baseInput({
            url,
            authToken: "token-1",
            password: "pass-1",
            scopes: ["admin", "read"],
          }),
        );
      });
    });

    const frame = await connectFrame;
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("connect");
    expect(typeof frame.id).toBe("string");

    const params = frame.params as Record<string, unknown>;
    expect(params.minProtocol).toBe(3);
    expect(params.maxProtocol).toBe(4);
    expect(params.role).toBe("operator");
    expect(params.scopes).toEqual(["admin", "read"]);

    const client = params.client as Record<string, unknown>;
    expect(client.id).toBe("gateway-client");
    expect(client.mode).toBe("probe");

    const auth = params.auth as Record<string, unknown>;
    expect(auth.token).toBe("token-1");
    expect(auth.password).toBe("pass-1");
  });

  it("returns ok when the connect request is accepted", async () => {
    const { url } = await listen((socket) => {
      sendJson(socket, connectChallenge("nonce-2"));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id?: unknown };
        sendJson(socket, { type: "res", id: frame.id, ok: true });
      });
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result).toEqual({ status: "ok", protocolMismatch: false });
  });

  it("returns challenge_only with protocolMismatch true on a structured protocol error", async () => {
    const { url } = await listen((socket) => {
      sendJson(socket, connectChallenge("nonce-3"));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id?: unknown };
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "PROTOCOL_UNSUPPORTED",
            message: "protocol 4 is not supported",
            details: { code: "PROTOCOL_UNSUPPORTED" },
          },
        });
      });
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result.status).toBe("challenge_only");
    expect(result.protocolMismatch).toBe(true);
  });

  it("does not mark a generic auth rejection as a protocol mismatch", async () => {
    const { url } = await listen((socket) => {
      sendJson(socket, connectChallenge("nonce-4"));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id?: unknown };
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "AUTH_REJECTED", message: "invalid credentials" },
        });
      });
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result.status).toBe("challenge_only");
    expect(result.protocolMismatch).toBe(false);
  });

  it("returns failed when the challenge carries no nonce", async () => {
    const { url } = await listen((socket) => {
      sendJson(socket, { type: "event", event: "connect.challenge", payload: {} });
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result).toEqual({ status: "failed", protocolMismatch: false });
  });

  it("returns failed when the socket closes before a response", async () => {
    const { url } = await listen((socket) => {
      sendJson(socket, connectChallenge("nonce-5"));
      socket.on("message", () => socket.close());
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result).toEqual({ status: "failed", protocolMismatch: false });
  });

  it("returns failed when the probe times out", async () => {
    const { url } = await listen(() => {
      // never respond
    });

    const result = await probeGateway(baseInput({ url, timeoutMs: 100 }));
    expect(result).toEqual({ status: "failed", protocolMismatch: false });
  });

  it("closes the client and server sockets after completion", async () => {
    let resolveClosed: (() => void) | null = null;
    const serverClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const { url } = await listen((socket) => {
      socket.once("close", () => resolveClosed?.());
      sendJson(socket, connectChallenge("nonce-6"));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { id?: unknown };
        sendJson(socket, { type: "res", id: frame.id, ok: true });
      });
    });

    const result = await probeGateway(baseInput({ url }));
    expect(result.status).toBe("ok");

    await expect(
      Promise.race([
        serverClosed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("client socket was not closed after probe")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});
