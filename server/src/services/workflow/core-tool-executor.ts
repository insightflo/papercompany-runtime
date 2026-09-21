import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, toolDefinitions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { executeRemoteWorkflowTool, type CoreWorkflowToolRemoteDeps } from "./remote-tool-executor.js";
import { resolveWorkflowRunStepOutputDir } from "./remote-tool-context.js";
import { normalizeCommandParts, parametersToCliArgs, readObject } from "./core-tool-context.js";
import { readToolProgressPolicy, ToolProgressError } from "../tools/progress-policy.js";
import { executeLocalToolWithProgress } from "./local-tool-progress-executor.js";
import { executeAgentJudgmentTool } from "../judgment/agent-judgment-tool-executor.js";
import type { JudgmentService } from "../judgment/judgment-service.js";
export { parametersToCliArgs, resolveRunStepEnv, resolveWorkflowRunStepEnv } from "./core-tool-context.js";

const execFile = promisify(execFileCallback);
export type CoreWorkflowToolExecutionResult = {
  status: 200 | 403 | 404 | 422 | 500 | 501 | 503;
  artifactPath?: string;
  body: { content?: string; data?: unknown; stderr?: string; tool?: string; source?: "core"; error?: string };
};
export async function checkCoreWorkflowToolsAvailable(db: Db, input: { companyId: string; toolNames: string[] }): Promise<
  { available: true } | { available: false; reason: string }
> {
  const requested = Array.from(new Set(input.toolNames.map((name) => name.trim()).filter(Boolean)));
  if (requested.length === 0) return { available: true };
  const rows = await db.select({ name: toolDefinitions.name, enabled: toolDefinitions.enabled }).from(toolDefinitions)
    .where(eq(toolDefinitions.companyId, input.companyId));
  const byName = new Map(rows.map((row) => [row.name, row]));
  const missing = requested.find((name) => !byName.has(name));
  if (missing) return { available: false, reason: `Core workflow tool "${missing}" is not registered.` };
  const disabled = requested.find((name) => byName.get(name)?.enabled === false);
  if (disabled) return { available: false, reason: `Core workflow tool "${disabled}" is disabled.` };
  return { available: true };
}
export async function executeCoreWorkflowTool(input: {
  db: Db; companyId: string; agentId?: string | null; agentName?: string | null; issueId?: string | null;
  toolName: string; parameters: unknown; requestId: string; workflowRunId?: string | null; stepRunId?: string | null; stepId?: string | null;
  stepEnv?: Record<string, string>; remoteDeps?: CoreWorkflowToolRemoteDeps; judgmentService?: JudgmentService;
}): Promise<CoreWorkflowToolExecutionResult> {
  const [tool] = await input.db.select({ id: toolDefinitions.id, name: toolDefinitions.name,
    enabled: toolDefinitions.enabled, adapterType: toolDefinitions.adapterType, adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions).where(and(eq(toolDefinitions.companyId, input.companyId), eq(toolDefinitions.name, input.toolName))).limit(1);
  if (!tool) return { status: 404, body: { error: `Tool "${input.toolName}" not found` } };
  if (!tool.enabled) return { status: 403, body: { error: `Tool "${input.toolName}" is disabled` } };
  const adapterConfig = readObject(tool.adapterConfig);
  const isJudgmentTool = tool.adapterType === "builtin" && adapterConfig.kind === "judgment";
  let agentId = input.agentId?.trim() || "";
  if (!agentId && input.agentName?.trim()) {
    const [agent] = await input.db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.name, input.agentName.trim()))).limit(1);
    agentId = agent?.id ?? "";
  }
  const hasWorkflowStepContext = Boolean(input.workflowRunId?.trim() && input.stepId?.trim());
  if (isJudgmentTool && !agentId && !hasWorkflowStepContext) {
    return { status: 403, body: { error: `Agent identity is required for workflow tool "${input.toolName}"` } };
  }
  if (agentId) {
    const [grant] = await input.db.select({ id: agentToolGrants.id }).from(agentToolGrants).where(and(
      eq(agentToolGrants.companyId, input.companyId), eq(agentToolGrants.agentId, agentId), eq(agentToolGrants.toolId, tool.id),
    )).limit(1);
    if (!grant) return { status: 403, body: { error: `Agent is not granted workflow tool "${input.toolName}"` } };
  }
  if (isJudgmentTool) {
    // [봇 bug·medium 교정] 디렉토리 해석 실패(일시 DB 오류 포함)가 판단 실행 자체를
    //   실패시키지 않게 한다 — 산출물 없이 판단만 수행한다(observe 소프트 성공 계약).
    let stepOutputDir: string | null = null;
    if (hasWorkflowStepContext) {
      try {
        stepOutputDir = await resolveWorkflowRunStepOutputDir(input.db, {
          companyId: input.companyId,
          workflowRunId: input.workflowRunId,
          stepId: input.stepId,
        });
      } catch {
        stepOutputDir = null;
      }
    }
    return executeAgentJudgmentTool({
      db: input.db,
      companyId: input.companyId,
      toolName: input.toolName,
      parameters: input.parameters,
      requestId: input.requestId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      stepOutputDir,
      judgmentService: input.judgmentService,
    });
  }
  const remoteResult = await executeRemoteWorkflowTool({ db: input.db, companyId: input.companyId,
    toolId: tool.id, toolName: input.toolName, parameters: input.parameters, requestId: input.requestId,
    workflowRunId: input.workflowRunId, stepId: input.stepId, adapterType: tool.adapterType,
    adapterConfig: tool.adapterConfig, remoteDeps: input.remoteDeps });
  if (remoteResult) return remoteResult;
  if (tool.adapterType !== "builtin") return { status: 501,
    body: { error: `Core workflow tool "${input.toolName}" uses unsupported adapter type "${tool.adapterType}"` } };
  const command = typeof adapterConfig.command === "string" ? adapterConfig.command.trim() : "";
  const commandParts = normalizeCommandParts(command);
  if (commandParts.length === 0) return { status: 422, body: { error: `Core workflow tool "${input.toolName}" has no command configured` } };
  if (adapterConfig.requiresApproval === true) return { status: 403, body: { error: `Core workflow tool "${input.toolName}" requires approval` } };
  const cwd = typeof adapterConfig.workingDirectory === "string" && adapterConfig.workingDirectory.trim()
    ? adapterConfig.workingDirectory.trim() : process.cwd();
  const envConfig = readObject(adapterConfig.env);
  const timeoutMs = typeof adapterConfig.timeoutMs === "number" && Number.isFinite(adapterConfig.timeoutMs)
    ? Math.max(1, Math.trunc(adapterConfig.timeoutMs)) : 120_000;
  const executable = commandParts[0]!;
  const allArgs = [...commandParts.slice(1), ...parametersToCliArgs(input.parameters)];
  try {
    const policy = readToolProgressPolicy(adapterConfig);
    const env = { ...process.env,
      ...Object.fromEntries(Object.entries(envConfig).map(([key, value]) => [key, String(value)])),
      PAPERCLIP_COMPANY_ID: input.companyId,
      ...(agentId ? { PAPERCLIP_AGENT_ID: agentId } : {}),
      ...(input.issueId ? { PAPERCLIP_TASK_ID: input.issueId } : {}), ...(input.stepEnv ?? {}),
    };
    const { stdout, stderr } = policy
      ? await executeLocalToolWithProgress({ db: input.db, scope: { companyId: input.companyId, toolId: tool.id,
          requestId: input.requestId, adapterType: "builtin", workflowRunId: input.workflowRunId, stepId: input.stepId },
        policy, executable, args: allArgs, cwd, env })
      : await execFile(executable, allArgs, { cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs });
    const trimmedStdout = stdout.trim();
    const trimmedStderr = stderr.trim();
    let parsed: unknown;
    if (trimmedStdout) {
      try { parsed = JSON.parse(trimmedStdout); } catch { parsed = undefined; }
    }
    return { status: 200, body: { content: trimmedStdout, data: parsed ?? { stdout: trimmedStdout },
      stderr: trimmedStderr, tool: input.toolName, source: "core" } };
  } catch (error) {
    const typed = error as Error & { code?: string | number; stdout?: unknown; stderr?: unknown };
    const stdout = typeof typed.stdout === "string" ? typed.stdout.trim() : "";
    const stderr = typeof typed.stderr === "string" ? typed.stderr.trim() : "";
    const code = typed.code === undefined ? "" : ` (exit: ${String(typed.code)})`;
    const status = error instanceof ToolProgressError && error.status === 422 ? 422 : 500;
    const message = adapterConfig.progress !== undefined && !(error instanceof ToolProgressError)
      ? "tool_progress_execution_failed" : typed.message;
    return { status, body: { error: `${message}${code}`, data: { stdout }, stderr, tool: input.toolName, source: "core" } };
  }
}
