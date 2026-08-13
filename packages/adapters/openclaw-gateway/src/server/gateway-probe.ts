import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  isGatewayProtocolMismatch,
  type GatewayProtocolSelection,
} from "./protocol.js";

export type GatewayProbeStatus = "ok" | "challenge_only" | "failed";

export type GatewayProbeInput = {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  password: string | null;
  role: string;
  scopes: string[];
  protocol: GatewayProtocolSelection;
  timeoutMs: number;
};

export type GatewayProbeResult = {
  status: GatewayProbeStatus;
  protocolMismatch: boolean;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

export async function probeGateway(input: GatewayProbeInput): Promise<GatewayProbeResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ status: "failed", protocolMismatch: false });
    }, input.timeoutMs);

    let completed = false;

    const finish = (status: GatewayProbeStatus) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ status, protocolMismatch: false });
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish("failed");
          return;
        }

        const connectId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: input.protocol.minProtocol,
              maxProtocol: input.protocol.maxProtocol,
              client: {
                id: "gateway-client",
                version: "paperclip-probe",
                platform: process.platform,
                mode: "probe",
              },
              role: input.role,
              scopes: input.scopes,
              ...(input.authToken || input.password
                ? {
                    auth: {
                      ...(input.authToken ? { token: input.authToken } : {}),
                      ...(input.password ? { password: input.password } : {}),
                    },
                  }
                : {}),
            },
          }),
        );
        return;
      }

      if (event?.type === "res") {
        if (event.ok === true) {
          finish("ok");
        } else {
          const errorRecord = asRecord(event.error);
          if (completed) return;
          completed = true;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {
            // ignore
          }
          resolve({
            status: "challenge_only",
            protocolMismatch: isGatewayProtocolMismatch({
              gatewayCode: errorRecord?.code,
              message: errorRecord?.message,
              gatewayDetails: errorRecord?.details,
            }),
          });
        }
      }
    });

    ws.on("error", () => {
      finish("failed");
    });

    ws.on("close", () => {
      if (!completed) finish("failed");
    });
  });
}
