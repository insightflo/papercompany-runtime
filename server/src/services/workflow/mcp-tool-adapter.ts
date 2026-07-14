import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import { persistArtifact, redactSecret } from "./http-tool-adapter.js";

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_CHARS = 1_000;
// McpError code for RequestOptions timeout (ErrorCode.RequestTimeout).
const MCP_REQUEST_TIMEOUT_CODE = -32001;

export type McpWorkflowToolExecutionInput = {
  companyId: string;
  toolName: string;
  parameters: unknown;
  requestId: string;
  stepOutputDir?: string | null;
  adapterConfig: Record<string, unknown>;
};

export type McpWorkflowToolExecutionDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

type HeaderAuth = { headerName: string; secretId: string; version: number | "latest" };

function resolveHeaderAuth(auth: unknown): HeaderAuth | null {
  const cfg = readObject(auth);
  if (nonEmptyString(cfg.type) !== "header") return null;
  const headerName = nonEmptyString(cfg.headerName);
  if (!headerName || !HEADER_NAME_RE.test(headerName)) return null;
  const secretId = nonEmptyString(cfg.secretId);
  if (!secretId) return null;
  let version: number | "latest";
  if (cfg.version === "latest") {
    version = "latest";
  } else if (typeof cfg.version === "number" && Number.isInteger(cfg.version) && cfg.version > 0) {
    version = cfg.version;
  } else {
    return null;
  }
  return { headerName, secretId, version };
}

type ArtifactContract = {
  artifactField: string;
  artifactFileName: string;
  artifactPathResultField: string;
};

function resolveArtifactContract(response: unknown): ArtifactContract | null {
  const cfg = readObject(response);
  if (Object.keys(cfg).length === 0) return null;
  const artifactField = nonEmptyString(cfg.artifactField);
  const artifactFileName = nonEmptyString(cfg.artifactFileName);
  const artifactPathResultField = nonEmptyString(cfg.artifactPathResultField);
  if (!artifactField || !artifactFileName || !artifactPathResultField) return null;
  if (path.basename(artifactFileName) !== artifactFileName || artifactFileName.includes(path.sep)) {
    return null;
  }
  return { artifactField, artifactFileName, artifactPathResultField };
}

function joinText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

function boundDiagnostic(message: string): string {
  return message.slice(0, MAX_DIAGNOSTIC_CHARS);
}

export async function executeMcpWorkflowTool(
  input: McpWorkflowToolExecutionInput,
  deps: McpWorkflowToolExecutionDeps,
): Promise<CoreWorkflowToolExecutionResult> {
  const { toolName } = input;
  const config = readObject(input.adapterConfig);

  const url = nonEmptyString(config.url);
  if (!url || !isAbsoluteHttpsUrl(url)) {
    return { status: 422, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" requires an absolute https url` } };
  }

  const remoteToolName = nonEmptyString(config.toolName);
  if (!remoteToolName) {
    return { status: 422, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" requires a configured remote tool name` } };
  }

  const auth = resolveHeaderAuth(config.auth);
  if (!auth) {
    return { status: 422, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" has an invalid header auth configuration` } };
  }

  const rawTimeout = typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(rawTimeout)));

  const artifactContract = resolveArtifactContract(config.response);

  let headerValue: string;
  try {
    headerValue = await deps.resolveSecretValue(input.companyId, auth.secretId, auth.version);
  } catch {
    return { status: 403, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" auth secret could not be resolved` } };
  }
  if (!headerValue) {
    return { status: 403, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" auth secret could not be resolved` } };
  }

  const headers: Record<string, string> = {
    [auth.headerName]: headerValue,
    "X-Papercompany-Request-Id": input.requestId,
  };

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
  });
  const client = new Client({ name: "papercompany-runtime", version: "1.0.0" });

  let toolResult: { content?: unknown; structuredContent?: unknown; isError?: boolean };
  try {
    await client.connect(transport, { timeout: timeoutMs });
    toolResult = await client.callTool(
      { name: remoteToolName, arguments: readObject(input.parameters) },
      undefined,
      { timeout: timeoutMs },
    ) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  } catch (err) {
    const error = err as { name?: string; code?: number; message?: string };
    if (error?.name === "UnauthorizedError" || error?.code === 401 || error?.code === 403) {
      return { status: 403, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" was rejected by the remote endpoint` } };
    }
    if (
      error?.code === MCP_REQUEST_TIMEOUT_CODE
      || error?.name === "AbortError"
      || error?.name === "TimeoutError"
    ) {
      return { status: 500, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" request timed out (request id: ${input.requestId})` } };
    }
    const detail = boundDiagnostic(redactSecret(error?.message ?? String(err), headerValue));
    return {
      status: 500,
      body: {
        tool: toolName,
        source: "core",
        error: `Workflow tool "${toolName}" request failed (request id: ${input.requestId})${detail ? `: ${detail}` : ""}`,
      },
    };
  } finally {
    try {
      await client.close();
    } catch {
      /* close failures must not mask the real result */
    }
  }

  if (toolResult?.isError === true) {
    const text = boundDiagnostic(redactSecret(joinText(toolResult.content), headerValue));
    return { status: 500, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" reported an error${text ? `: ${text}` : ""}` } };
  }

  const structured = readObject(toolResult?.structuredContent);
  let data: Record<string, unknown>;
  if (Object.keys(structured).length > 0) {
    data = structured;
  } else {
    const text = joinText(toolResult?.content);
    if (!text) {
      return { status: 500, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" remote response had no content` } };
    }
    data = { text };
  }

  if (artifactContract) {
    const artifactValue = data[artifactContract.artifactField];
    const stepOutputDir = typeof input.stepOutputDir === "string" ? input.stepOutputDir.trim() : "";
    if (artifactValue !== undefined) {
      if (!stepOutputDir) {
        return { status: 500, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" could not resolve a step output directory for the artifact` } };
      }
      try {
        const artifactPath = await persistArtifact(stepOutputDir, artifactContract.artifactFileName, artifactValue);
        data = { ...data, [artifactContract.artifactPathResultField]: artifactPath };
      } catch {
        return { status: 500, body: { tool: toolName, source: "core", error: `Workflow tool "${toolName}" could not persist the response artifact` } };
      }
    }
  }

  return {
    status: 200,
    body: {
      content: JSON.stringify(data),
      data,
      tool: toolName,
      source: "core",
    },
  };
}

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
