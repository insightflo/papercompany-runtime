import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import { consumeHttpToolResponse, nonEmptyString, readObject, redactSecret, resolveResponseContract, result } from "./http-tool-response.js";
import { fixedHttpTimeout, progressCallbackBase, progressTokenHash, readToolProgressPolicy, ToolProgressError } from "../tools/progress-policy.js";
import { createToolProgressStore } from "../tools/progress-store.js";
import { withToolProgress } from "../tools/progress-monitor.js";
export { redactSecret, persistArtifact } from "./http-tool-response.js";

export type HttpWorkflowToolExecutionInput = {
  companyId: string; toolName: string; parameters: unknown; requestId: string;
  stepOutputDir?: string | null; adapterConfig: Record<string, unknown>;
};
export type HttpWorkflowToolExecutionDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue: (companyId: string, secretId: string, version: number | "latest") => Promise<string>;
  progress?: { db: Db; toolId: string; workflowRunId?: string | null; stepId?: string | null; callbackBaseUrl?: string };
};
function resolveHeaderAuth(auth: unknown): { headerName: string; secretId: string; version: number | "latest" } | null {
  const cfg = readObject(auth);
  const headerName = nonEmptyString(cfg.headerName);
  const secretId = nonEmptyString(cfg.secretId);
  if (cfg.type !== "header" || !headerName || !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(headerName) || !secretId) return null;
  const version = cfg.version;
  if (version !== "latest" && !(typeof version === "number" && Number.isInteger(version) && version > 0)) return null;
  return { headerName, secretId, version };
}
async function withFixedDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolProgressError(500, "tool_http_timeout");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer!); }
}
export async function executeHttpWorkflowTool(input: HttpWorkflowToolExecutionInput, deps: HttpWorkflowToolExecutionDeps): Promise<CoreWorkflowToolExecutionResult> {
  const { toolName } = input;
  const config = readObject(input.adapterConfig);
  const invalid = (message: string) => result(toolName, 422, message);
  const url = nonEmptyString(config.url);
  let protocol: string;
  try { protocol = url ? new URL(url).protocol : ""; } catch { protocol = ""; }
  if (!url || !["http:", "https:"].includes(protocol)) return invalid(`Workflow tool "${toolName}" requires an absolute http(s) url`);
  if (config.allowInsecureUrl !== true && protocol !== "https:") {
    return invalid(`Workflow tool "${toolName}" requires an absolute https url (set adapterConfig "allowInsecureUrl" to true to allow http)`);
  }
  if (nonEmptyString(config.method)?.toUpperCase() !== "POST") return invalid(`Workflow tool "${toolName}" only supports POST requests`);
  const auth = resolveHeaderAuth(config.auth);
  if (!auth) return invalid(`Workflow tool "${toolName}" has an invalid header auth configuration`);
  const responseContract = resolveResponseContract(config.response);
  if (!responseContract) return invalid(`Workflow tool "${toolName}" has an invalid response configuration`);
  let token = "";
  let headerValue = "";
  try {
    const policy = readToolProgressPolicy(config);
    const timeoutMs = fixedHttpTimeout(config.timeoutMs);
    if (policy && !deps.progress) throw new ToolProgressError(422, "tool_progress_missing_context");
    const callbackBase = policy ? progressCallbackBase(deps.progress?.callbackBaseUrl) : undefined;
    try { headerValue = await deps.resolveSecretValue(input.companyId, auth.secretId, auth.version); }
    catch { /* same bounded auth failure for unavailable/empty secrets */ }
    if (!headerValue) return result(toolName, 403, `Workflow tool "${toolName}" auth secret could not be resolved`);
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json",
      [auth.headerName]: headerValue, "X-Papercompany-Request-Id": input.requestId };
    // Serialize/validate transport input before creating a durable execution record.
    const body = JSON.stringify(input.parameters ?? {});
    const operation = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const res = await (deps.fetchImpl ?? fetch)(url, { method: "POST", headers, body, signal, ...(policy ? { redirect: "error" as const } : {}) });
      signal.throwIfAborted();
      const response = await consumeHttpToolResponse(res, input, responseContract, [headerValue, token], signal);
      if (response.body.error) response.body.error = redactSecret(redactSecret(response.body.error, token), headerValue);
      return response;
    };
    if (!policy) return await withFixedDeadline(timeoutMs, operation);
    const context = deps.progress!;
    const store = createToolProgressStore(context.db);
    token = randomBytes(32).toString("hex");
    const heartbeat = await store.start({ companyId: input.companyId, toolId: context.toolId, requestId: input.requestId,
      adapterType: "http", workflowRunId: context.workflowRunId, stepId: context.stepId }, policy, progressTokenHash(token));
    headers["X-Papercompany-Progress-Version"] = "1";
    headers["X-Papercompany-Execution-Id"] = heartbeat.id;
    headers["X-Papercompany-Progress-Url"] = `${callbackBase}/api/companies/${input.companyId}/tool-executions/${heartbeat.id}/progress`;
    headers["X-Papercompany-Progress-Token"] = token;
    return await withToolProgress({ store, heartbeat, operation, succeeded: (value) => value.status === 200 });
  } catch (error) {
    if (error instanceof ToolProgressError && error.status === 422) return invalid(error.reason);
    const timeout = error instanceof ToolProgressError && error.reason === "tool_http_timeout" ||
      error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
    const detail = error instanceof ToolProgressError && error.reason.startsWith("tool_progress_")
      ? error.reason : timeout ? "request timed out" : "request failed";
    return result(toolName, 500, `Workflow tool "${toolName}" ${detail} (request id: ${input.requestId})`);
  }
}
