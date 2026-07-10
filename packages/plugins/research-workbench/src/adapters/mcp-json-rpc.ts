import { readBoundedResponseText } from "./direct-web-provider.js";

export interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export async function parseJsonRpcEnvelope(
  response: Response,
  expectedId: string | number,
): Promise<JsonRpcEnvelope> {
  const body = await readBoundedResponseText(response);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const payloads = contentType.includes("text/event-stream")
    ? extractSseDataPayloads(body)
    : [body.trim()];

  for (const payload of payloads) {
    const envelope = parseEnvelopePayload(payload);
    if (envelope.id !== expectedId) continue;
    if (envelope.jsonrpc !== "2.0") {
      throw new McpProtocolError(`JSON-RPC id ${expectedId} omitted jsonrpc 2.0`);
    }
    return envelope;
  }

  throw new McpProtocolError(`MCP response did not contain JSON-RPC id ${expectedId}`);
}

function extractSseDataPayloads(body: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) => event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim())
    .filter((payload) => payload && payload !== "[DONE]");
}

function parseEnvelopePayload(payload: string): JsonRpcEnvelope {
  if (!payload) throw new McpProtocolError("MCP response body was empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new McpProtocolError("MCP response contained invalid JSON");
  }
  if (!isRecord(parsed)) {
    throw new McpProtocolError("MCP response was not a JSON object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
