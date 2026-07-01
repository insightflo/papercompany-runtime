import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, heartbeatRuns, issues, toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";

const execFile = promisify(execFileCallback);

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parameterKeyToCliFlag(key: string): string {
  return `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`).replace(/_/g, "-")}`;
}

export function parametersToCliArgs(parameters: unknown): string[] {
  if (Array.isArray(parameters)) {
    return parameters.map((item) => String(item));
  }

  const args = readObject(parameters);
  const cliArgs: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!key.trim() || value === undefined || value === null || value === false) continue;
    if (key === "_" || key === "positional") {
      if (Array.isArray(value)) {
        cliArgs.push(...value.map((entry) => String(entry)));
      }
      continue;
    }
    const flag = parameterKeyToCliFlag(key);
    if (value === true) {
      cliArgs.push(flag);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry === undefined || entry === null || entry === false) continue;
      cliArgs.push(flag, typeof entry === "object" ? JSON.stringify(entry) : String(entry));
    }
  }
  return cliArgs;
}

function normalizeCommandParts(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(command)) !== null) {
    const part = match[1] ?? match[2] ?? match[3] ?? "";
    if (part.length > 0) parts.push(part);
  }

  return parts;
}

export async function resolveRunStepEnv(db: Db, runId: string): Promise<Record<string, string>> {
  const run = await db
    .select({ issueId: heartbeatRuns.issueId, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run?.issueId) return {};

  const issue = await db
    .select({ missionId: issues.missionId, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, run.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue?.missionId) return {};

  const stepRun = await db
    .select({ workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, run.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!stepRun) return {};

  const paths = await resolveMissionWorkProductPaths(db, {
    companyId: run.companyId,
    missionId: issue.missionId,
    projectId: issue.projectId,
    workflowRunId: stepRun.workflowRunId,
    stepId: stepRun.stepId,
  });
  const env: Record<string, string> = {
    PAPERCLIP_WORKFLOW_RUN_ID: stepRun.workflowRunId,
    PAPERCLIP_WORKFLOW_STEP_ID: stepRun.stepId,
    PAPERCLIP_MISSION_ID: issue.missionId,
  };
  if (paths?.stepOutputDir) env.PAPERCLIP_STEP_OUTPUT_DIR = paths.stepOutputDir;
  return env;
}

export type CoreWorkflowToolExecutionResult = {
  status: 200 | 403 | 404 | 422 | 500 | 501;
  body: {
    content?: string;
    data?: unknown;
    stderr?: string;
    tool?: string;
    source?: "core";
    error?: string;
  };
};

export async function checkCoreWorkflowToolsAvailable(
  db: Db,
  input: { companyId: string; toolNames: string[] },
): Promise<{ available: true } | { available: false; reason: string }> {
  const requested = Array.from(new Set(input.toolNames.map((toolName) => toolName.trim()).filter(Boolean)));
  if (requested.length === 0) return { available: true };

  const rows = await db
    .select({
      name: toolDefinitions.name,
      enabled: toolDefinitions.enabled,
    })
    .from(toolDefinitions)
    .where(eq(toolDefinitions.companyId, input.companyId));
  const byName = new Map(rows.map((row) => [row.name, row]));
  const missing = requested.find((toolName) => !byName.has(toolName));
  if (missing) {
    return { available: false, reason: `Core workflow tool "${missing}" is not registered.` };
  }
  const disabled = requested.find((toolName) => byName.get(toolName)?.enabled === false);
  if (disabled) {
    return { available: false, reason: `Core workflow tool "${disabled}" is disabled.` };
  }

  return { available: true };
}

export async function executeCoreBuiltinWorkflowTool(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  agentName?: string | null;
  issueId?: string | null;
  toolName: string;
  parameters: unknown;
  stepEnv?: Record<string, string>;
}): Promise<CoreWorkflowToolExecutionResult> {
  const [tool] = await input.db
    .select({
      id: toolDefinitions.id,
      name: toolDefinitions.name,
      enabled: toolDefinitions.enabled,
      adapterType: toolDefinitions.adapterType,
      adapterConfig: toolDefinitions.adapterConfig,
    })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, input.companyId),
      eq(toolDefinitions.name, input.toolName),
    ))
    .limit(1);

  if (!tool) {
    return { status: 404, body: { error: `Tool "${input.toolName}" not found` } };
  }
  if (!tool.enabled) {
    return { status: 403, body: { error: `Tool "${input.toolName}" is disabled` } };
  }

  let agentId = input.agentId?.trim() || "";
  if (!agentId && input.agentName?.trim()) {
    const [agent] = await input.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.name, input.agentName.trim())))
      .limit(1);
    agentId = agent?.id ?? "";
  }

  if (agentId) {
    const [grant] = await input.db
      .select({ id: agentToolGrants.id })
      .from(agentToolGrants)
      .where(and(
        eq(agentToolGrants.companyId, input.companyId),
        eq(agentToolGrants.agentId, agentId),
        eq(agentToolGrants.toolId, tool.id),
      ))
      .limit(1);
    if (!grant) {
      return { status: 403, body: { error: `Agent is not granted workflow tool "${input.toolName}"` } };
    }
  }

  if (tool.adapterType !== "builtin") {
    return {
      status: 501,
      body: { error: `Core workflow tool "${input.toolName}" uses unsupported adapter type "${tool.adapterType}"` },
    };
  }

  const adapterConfig = readObject(tool.adapterConfig);
  const command = typeof adapterConfig.command === "string" ? adapterConfig.command.trim() : "";
  const commandParts = normalizeCommandParts(command);
  if (commandParts.length === 0) {
    return { status: 422, body: { error: `Core workflow tool "${input.toolName}" has no command configured` } };
  }
  if (adapterConfig.requiresApproval === true) {
    return { status: 403, body: { error: `Core workflow tool "${input.toolName}" requires approval` } };
  }

  const cwd = typeof adapterConfig.workingDirectory === "string" && adapterConfig.workingDirectory.trim()
    ? adapterConfig.workingDirectory.trim()
    : process.cwd();
  const envConfig = readObject(adapterConfig.env);
  const timeoutMs = typeof adapterConfig.timeoutMs === "number" && Number.isFinite(adapterConfig.timeoutMs)
    ? Math.max(1, Math.trunc(adapterConfig.timeoutMs))
    : 120_000;
  const executable = commandParts[0]!;
  const allArgs = [...commandParts.slice(1), ...parametersToCliArgs(input.parameters)];

  try {
    const { stdout, stderr } = await execFile(executable, allArgs, {
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(envConfig).map(([key, value]) => [key, String(value)])),
        PAPERCLIP_COMPANY_ID: input.companyId,
        ...(agentId ? { PAPERCLIP_AGENT_ID: agentId } : {}),
        ...(input.issueId ? { PAPERCLIP_TASK_ID: input.issueId } : {}),
        ...(input.stepEnv ?? {}),
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const trimmedStdout = stdout.trim();
    const trimmedStderr = stderr.trim();
    let parsed: unknown = undefined;
    if (trimmedStdout) {
      try {
        parsed = JSON.parse(trimmedStdout);
      } catch {
        parsed = undefined;
      }
    }

    return {
      status: 200,
      body: {
        content: trimmedStdout,
        data: parsed ?? { stdout: trimmedStdout },
        stderr: trimmedStderr,
        tool: input.toolName,
        source: "core",
      },
    };
  } catch (error) {
    const typed = error as Error & { code?: string | number; stdout?: unknown; stderr?: unknown };
    const stdout = typeof typed.stdout === "string" ? typed.stdout.trim() : "";
    const stderr = typeof typed.stderr === "string" ? typed.stderr.trim() : "";
    const code = typed.code === undefined ? "" : ` (exit: ${String(typed.code)})`;
    return {
      status: 500,
      body: {
        error: `${typed.message}${code}`,
        data: { stdout },
        stderr,
        tool: input.toolName,
        source: "core",
      },
    };
  }
}
