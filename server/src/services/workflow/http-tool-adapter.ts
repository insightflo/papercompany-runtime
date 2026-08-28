import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REMOTE_DIAGNOSTIC_CHARS = 1_000;

export type HttpWorkflowToolExecutionInput = {
  companyId: string;
  toolName: string;
  parameters: unknown;
  requestId: string;
  stepOutputDir?: string | null;
  adapterConfig: Record<string, unknown>;
};

export type HttpWorkflowToolExecutionDeps = {
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

function result(
  toolName: string,
  status: CoreWorkflowToolExecutionResult["status"],
  error?: string,
  extra?: CoreWorkflowToolExecutionResult["body"],
): CoreWorkflowToolExecutionResult {
  return { status, body: { tool: toolName, source: "core", error, ...extra } };
}

function invalidConfig(toolName: string, message: string): CoreWorkflowToolExecutionResult {
  return result(toolName, 422, message);
}

function authFailure(toolName: string, message: string): CoreWorkflowToolExecutionResult {
  return result(toolName, 403, message);
}

function remoteFailure(toolName: string, message: string): CoreWorkflowToolExecutionResult {
  return result(toolName, 500, message);
}

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

type ResponseContract = {
  resultField: string;
  artifactField: string;
  artifactFileName: string;
  artifactPathResultField: string;
};

function resolveResponseContract(response: unknown): ResponseContract | null {
  const cfg = readObject(response);
  const resultField = nonEmptyString(cfg.resultField);
  const artifactField = nonEmptyString(cfg.artifactField);
  const artifactFileName = nonEmptyString(cfg.artifactFileName);
  const artifactPathResultField = nonEmptyString(cfg.artifactPathResultField);
  if (
    !resultField ||
    !artifactField ||
    !artifactFileName ||
    !artifactPathResultField ||
    path.basename(artifactFileName) !== artifactFileName ||
    artifactFileName.includes(path.sep)
  ) {
    return null;
  }
  return { resultField, artifactField, artifactFileName, artifactPathResultField };
}

export async function executeHttpWorkflowTool(
  input: HttpWorkflowToolExecutionInput,
  deps: HttpWorkflowToolExecutionDeps,
): Promise<CoreWorkflowToolExecutionResult> {
  const { toolName } = input;
  const config = readObject(input.adapterConfig);

  const url = nonEmptyString(config.url);
  if (!url || !isAbsoluteHttpUrl(url)) {
    return invalidConfig(toolName, `Workflow tool "${toolName}" requires an absolute http(s) url`);
  }
  // allowInsecureUrl is an explicit operator opt-in recorded in the tool's adapterConfig:
  // the tool definition author must set it to true to permit plain http targets.
  if (config.allowInsecureUrl !== true && !isAbsoluteHttpsUrl(url)) {
    return invalidConfig(
      toolName,
      `Workflow tool "${toolName}" requires an absolute https url (set adapterConfig "allowInsecureUrl" to true to allow http)`,
    );
  }

  const method = nonEmptyString(config.method)?.toUpperCase();
  if (method !== "POST") {
    return invalidConfig(toolName, `Workflow tool "${toolName}" only supports POST requests`);
  }

  const auth = resolveHeaderAuth(config.auth);
  if (!auth) {
    return invalidConfig(toolName, `Workflow tool "${toolName}" has an invalid header auth configuration`);
  }

  const responseContract = resolveResponseContract(config.response);
  if (!responseContract) {
    return invalidConfig(toolName, `Workflow tool "${toolName}" has an invalid response configuration`);
  }

  const rawTimeout = typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(rawTimeout)));

  let headerValue: string;
  try {
    headerValue = await deps.resolveSecretValue(input.companyId, auth.secretId, auth.version);
  } catch {
    return authFailure(toolName, `Workflow tool "${toolName}" auth secret could not be resolved`);
  }
  if (!headerValue) {
    return authFailure(toolName, `Workflow tool "${toolName}" auth secret could not be resolved`);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        [auth.headerName]: headerValue,
        "X-Papercompany-Request-Id": input.requestId,
      },
      body: JSON.stringify(input.parameters ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    const errorName = (err as { name?: string } | null)?.name;
    const isTimeout = errorName === "TimeoutError" || errorName === "AbortError";
    const detail = isTimeout
      ? `request timed out`
      : `request failed`;
    return remoteFailure(
      toolName,
      `Workflow tool "${toolName}" ${detail} (request id: ${input.requestId})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return authFailure(toolName, `Workflow tool "${toolName}" was rejected by the remote endpoint`);
  }
  if (!res.ok) {
    const remoteText = await readRemoteDiagnostic(res, headerValue);
    return remoteFailure(
      toolName,
      `Workflow tool "${toolName}" remote endpoint returned status ${res.status}${remoteText ? `: ${remoteText}` : ""}`,
    );
  }

  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    return remoteFailure(toolName, `Workflow tool "${toolName}" remote endpoint returned a non-JSON response`);
  }

  const envRecord = readObject(envelope);
  const resultValue = envRecord[responseContract.resultField];
  const artifactValue = envRecord[responseContract.artifactField];
  if (resultValue === undefined || artifactValue === undefined) {
    return remoteFailure(toolName, `Workflow tool "${toolName}" remote response is missing required fields`);
  }

  const stepOutputDir = typeof input.stepOutputDir === "string" ? input.stepOutputDir.trim() : "";
  if (!stepOutputDir) {
    return remoteFailure(
      toolName,
      `Workflow tool "${toolName}" could not resolve a step output directory for the artifact`,
    );
  }

  let artifactPath: string;
  try {
    artifactPath = await persistArtifact(stepOutputDir, responseContract.artifactFileName, artifactValue);
  } catch {
    return remoteFailure(
      toolName,
      `Workflow tool "${toolName}" could not persist the response artifact`,
    );
  }

  const baseResult = readObject(resultValue);
  const data = { ...baseResult, [responseContract.artifactPathResultField]: artifactPath };
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

export function redactSecret(value: string, secret: string): string {
  if (!secret || secret.length === 0 || !value.includes(secret)) return value;
  return value.split(secret).join("");
}

export async function persistArtifact(stepOutputDir: string, fileName: string, artifactValue: unknown): Promise<string> {
  const dir = path.resolve(stepOutputDir);
  const finalPath = path.join(dir, fileName);
  const tempPath = path.join(dir, `.${fileName}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, JSON.stringify(artifactValue), { mode: 0o600 });
  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return finalPath;
}

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

async function readRemoteDiagnostic(res: Response, secret: string): Promise<string> {
  try {
    const text = await res.text();
    return redactSecret(text, secret).slice(0, MAX_REMOTE_DIAGNOSTIC_CHARS);
  } catch {
    return "";
  }
}
