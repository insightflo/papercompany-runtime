import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import type { HttpWorkflowToolExecutionInput } from "./http-tool-adapter.js";

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function result(toolName: string, status: CoreWorkflowToolExecutionResult["status"], error?: string,
  extra?: CoreWorkflowToolExecutionResult["body"]): CoreWorkflowToolExecutionResult {
  return { status, body: { tool: toolName, source: "core", error, ...extra } };
}
type ResponseAssertion =
  | { field: string; kind: "equals"; expected: boolean | number | string }
  | { field: string; kind: "positiveNumber" | "existingFile" };
export type ResponseContract = {
  resultField: string; artifactField: string | null; artifactFileName: string; artifactPathResultField: string;
  assertions: ResponseAssertion[];
};
function resolveResponseAssertions(raw: unknown): ResponseAssertion[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const assertions: ResponseAssertion[] = [];
  for (const item of raw) {
    const entry = readObject(item);
    const field = nonEmptyString(entry.field);
    if (!field) return null;
    const hasEquals = "equals" in entry;
    const type = nonEmptyString(entry.type);
    if (hasEquals && type) return null;
    if (hasEquals) {
      const expected = entry.equals;
      if (typeof expected !== "boolean" && typeof expected !== "number" && typeof expected !== "string") return null;
      assertions.push({ field, kind: "equals", expected });
    } else if (type === "positiveNumber" || type === "existingFile") assertions.push({ field, kind: type });
    else return null;
  }
  return assertions;
}
export function resolveResponseContract(response: unknown): ResponseContract | null {
  const cfg = readObject(response);
  const resultField = nonEmptyString(cfg.resultField);
  const artifactField = nonEmptyString(cfg.artifactField);
  const artifactFileName = nonEmptyString(cfg.artifactFileName);
  const artifactPathResultField = nonEmptyString(cfg.artifactPathResultField);
  const assertions = resolveResponseAssertions(cfg.assertions);
  if (!resultField || assertions === null) return null;
  if (artifactField !== null) {
    if (!artifactFileName || !artifactPathResultField || path.basename(artifactFileName) !== artifactFileName || artifactFileName.includes(path.sep)) return null;
    return { resultField, artifactField, artifactFileName, artifactPathResultField, assertions };
  }
  if (artifactFileName || artifactPathResultField) return null;
  return { resultField, artifactField: null, artifactFileName: "", artifactPathResultField: "", assertions };
}
async function checkResponseAssertions(toolName: string, assertions: ResponseAssertion[], baseResult: Record<string, unknown>, requestId: string) {
  for (const assertion of assertions) {
    const actual = baseResult[assertion.field];
    let passed = false;
    let expectation: string;
    if (assertion.kind === "equals") {
      passed = actual === assertion.expected;
      expectation = `must equal ${JSON.stringify(assertion.expected)}`;
    } else if (assertion.kind === "positiveNumber") {
      passed = typeof actual === "number" && Number.isFinite(actual) && actual > 0;
      expectation = "must be a finite number > 0";
    } else {
      const candidate = nonEmptyString(actual);
      if (candidate && path.isAbsolute(candidate)) {
        try { const info = await stat(candidate); passed = info.isFile() && info.size > 0; } catch { /* missing file */ }
      }
      expectation = "must be an absolute path to an existing non-empty file";
    }
    if (!passed) return `Workflow tool "${toolName}" response contract violated: field "${assertion.field}" ${expectation} (request id: ${requestId})`;
  }
  return null;
}
export function redactSecret(value: string, secret: string): string {
  if (!secret || !value.includes(secret)) return value;
  return value.split(secret).join("");
}
export async function persistArtifact(stepOutputDir: string, fileName: string, artifactValue: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const dir = path.resolve(stepOutputDir);
  const finalPath = path.join(dir, fileName);
  const tempPath = path.join(dir, `.${fileName}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  signal?.throwIfAborted();
  try {
    await writeFile(tempPath, JSON.stringify(artifactValue), { mode: 0o600 });
    signal?.throwIfAborted();
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalPath;
}
export async function consumeHttpToolResponse(res: Response, input: HttpWorkflowToolExecutionInput,
  contract: ResponseContract, secrets: string[], signal: AbortSignal): Promise<CoreWorkflowToolExecutionResult> {
  const { toolName } = input;
  const failure = (message: string) => result(toolName, 500, message);
  if (res.status === 401 || res.status === 403) return result(toolName, 403, `Workflow tool "${toolName}" was rejected by the remote endpoint`);
  if (!res.ok) {
    let diagnostic = "";
    try { diagnostic = await res.text(); } catch { /* bounded timeout handled by caller */ }
    signal.throwIfAborted();
    for (const secret of secrets) diagnostic = redactSecret(diagnostic, secret);
    diagnostic = diagnostic.slice(0, 1000);
    return failure(`Workflow tool "${toolName}" remote endpoint returned status ${res.status}${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  let envelope: unknown;
  try { envelope = await res.json(); }
  catch {
    signal.throwIfAborted();
    return failure(`Workflow tool "${toolName}" remote endpoint returned a non-JSON response`);
  }
  signal.throwIfAborted();
  const envRecord = readObject(envelope);
  const resultValue = envRecord[contract.resultField];
  if (resultValue === undefined) return failure(`Workflow tool "${toolName}" remote response is missing required fields`);
  const baseResult = readObject(resultValue);
  let artifactPath: string | undefined;
  if (contract.artifactField !== null) {
    const artifactValue = envRecord[contract.artifactField];
    if (artifactValue === undefined) return failure(`Workflow tool "${toolName}" remote response is missing required fields`);
    const dir = typeof input.stepOutputDir === "string" ? input.stepOutputDir.trim() : "";
    if (!dir) return failure(`Workflow tool "${toolName}" could not resolve a step output directory for the artifact`);
    try { artifactPath = await persistArtifact(dir, contract.artifactFileName, artifactValue, signal); }
    catch {
      signal.throwIfAborted();
      return failure(`Workflow tool "${toolName}" could not persist the response artifact`);
    }
  }
  // Keep raw artifact evidence on assertion failure, without authorizing success.
  const violation = await checkResponseAssertions(toolName, contract.assertions, baseResult, input.requestId);
  signal.throwIfAborted();
  if (violation) return failure(`${violation}${artifactPath ? `; raw response retained at ${artifactPath}` : ""}`);
  const data = artifactPath ? { ...baseResult, [contract.artifactPathResultField]: artifactPath } : baseResult;
  return { status: 200, body: { content: JSON.stringify(data), data, tool: toolName, source: "core" } };
}
