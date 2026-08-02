import {
  asString,
  buildPaperclipEnv,
  ensurePathInEnv,
  parseObject,
  redactEnvForLogs,
} from "@paperclipai/adapter-utils/server-utils";

export interface ResolvedWorkspace {
  cwd: string;
  workspaceCwd: string;
  workspaceSource: string;
}

/**
 * Resolve the effective working directory. A configured `cwd` overrides the
 * agent-home fallback; otherwise the heartbeat-provided workspace cwd wins.
 */
export function resolveEffectiveCwd(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): ResolvedWorkspace {
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  return { cwd, workspaceCwd, workspaceSource };
}

export interface CommandCodeRunEnv {
  /** Env merged with the Paperclip runtime context (used to spawn the child). */
  runtimeEnv: Record<string, string>;
  /** Paperclip-owned env subset, with secrets redacted, for logging/meta. */
  redactedEnv: Record<string, string>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function firstNonEmpty(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export interface BuildRunEnvParams {
  runId: string;
  agent: { id: string; companyId: string };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  workspace: ResolvedWorkspace;
}

/**
 * Build the environment for the `cmd` child process. Secrets carried in adapter
 * `env` are applied to the child but redacted in the returned log view.
 */
export function buildCommandCodeRunEnv(params: BuildRunEnvParams): CommandCodeRunEnv {
  const { runId, agent, config, context, authToken, workspace } = params;
  const envConfig = parseObject(config.env);

  const env: Record<string, string> = { ...buildPaperclipEnv(agent, { context }) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId = firstNonEmpty(context.taskId, context.issueId);
  const wakeReason = firstNonEmpty(context.wakeReason);
  const wakeCommentId = firstNonEmpty(context.wakeCommentId, context.commentId);
  const approvalId = firstNonEmpty(context.approvalId);
  const approvalStatus = firstNonEmpty(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? (context.issueIds as unknown[]).filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspace.workspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = workspace.workspaceCwd;
  if (workspace.workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspace.workspaceSource;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return { runtimeEnv, redactedEnv: redactEnvForLogs(env) };
}

export function resolveExtraArgs(config: Record<string, unknown>): string[] {
  const fromExtraArgs = asStringArray(config.extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(config.args);
}

/**
 * Build the Command Code permission flags for a run.
 *
 * `--permission-mode auto-accept` is the safe default that accepts tool actions
 * automatically. When `dangerouslySkipPermissions` is set, the adapter passes
 * `--yolo` (full skip) instead and never sets the permission-mode, so the two
 * never combine into a contradictory invocation. Both flags stay reserved in
 * sanitizeCommandCodeExtraArgs so operator extraArgs can never override them.
 */
export function buildCommandCodePermissionArgs(dangerouslySkipPermissions: boolean): string[] {
  return dangerouslySkipPermissions ? ["--yolo"] : ["--permission-mode", "auto-accept"];
}

/**
 * Reserved Command Code flags that extraArgs must never override: enforced
 * output, automation/permissions, model/effort, max-turns, resume, and the
 * prompt itself. Value-taking flags consume their following arg.
 */
const RESERVED_VALUE_FLAGS = new Set([
  "--output-format",
  "--model",
  "-m",
  "--effort",
  "--max-turns",
  "--resume",
  "-r",
  "--session",
  "--permission-mode",
  "--config",
  "-p",
  "--print",
]);
const RESERVED_BOOL_FLAGS = new Set([
  "--",
  "--trust",
  "-t",
  "--skip-onboarding",
  "--no-auto-update",
  "--continue",
  "-c",
  "--no-session",
  "--yolo",
  "--auto-accept",
  "--dangerously-skip-permissions",
  "--plan",
  "--fork-session",
]);

export interface SanitizedExtraArgs {
  args: string[];
  dropped: string[];
}

/**
 * Drop reserved flags from operator-provided extraArgs so they cannot override
 * adapter-enforced output, automation, model, max-turns, or resume behavior.
 * Supports both `--flag value` and `--flag=value` forms.
 */
export function sanitizeCommandCodeExtraArgs(input: string[]): SanitizedExtraArgs {
  const out: string[] = [];
  const dropped: string[] = [];
  let i = 0;
  while (i < input.length) {
    const a = input[i];
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (RESERVED_BOOL_FLAGS.has(flag)) {
      dropped.push(a);
      i += 1;
      continue;
    }
    if (RESERVED_VALUE_FLAGS.has(flag)) {
      dropped.push(a);
      if (a.includes("=")) {
        i += 1;
        continue;
      }
      // Consume the value arg unless it is itself a flag.
      if (i + 1 < input.length && !input[i + 1].startsWith("-")) {
        dropped.push(input[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    out.push(a);
    i += 1;
  }
  return { args: out, dropped };
}
