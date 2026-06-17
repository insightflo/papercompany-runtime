import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaperclipRuntimeBrief, joinPromptSections, renderTemplate, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
async function buildSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(
    resolveClaudeDesiredSkillNames(
      config,
      availableEntries,
    ),
  );
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(
      entry.source,
      path.join(target, entry.runtimeName),
    );
  }
  return tmp;
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

function resolvePyenvShimLockPath(env: Record<string, string>): string {
  const pyenvRoot = env.PYENV_ROOT?.trim();
  if (pyenvRoot) return path.join(pyenvRoot, "shims", ".pyenv-shim");
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".pyenv", "shims", ".pyenv-shim");
}

async function clearStalePyenvShimLock(input: {
  env: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const disable = input.env.PAPERCLIP_DISABLE_PYENV_SHIM_LOCK_PREFLIGHT?.trim();
  if (disable === "1" || disable === "true") return;

  const rawStaleMs = Number(input.env.PAPERCLIP_PYENV_SHIM_LOCK_STALE_MS ?? "90000");
  const staleMs = Number.isFinite(rawStaleMs) && rawStaleMs >= 0 ? rawStaleMs : 90000;
  const lockPath = resolvePyenvShimLockPath(input.env);
  const nowMs = input.nowMs ?? Date.now();

  try {
    const stat = await fs.stat(lockPath);
    const ageMs = nowMs - stat.mtimeMs;
    if (ageMs < staleMs) return;
    await fs.rm(lockPath, { force: true });
    await input.onLog(
      "stderr",
      `[paperclip] Removed stale pyenv shim lock before Claude launch: ${lockPath} ageMs=${Math.round(ageMs)}\n`,
    );
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ENOENT") return;
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Warning: pyenv shim lock preflight failed for ${lockPath}: ${reason}\n`);
  }
}

const DEFAULT_PLANNING_RUN_DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task"];

function hasClaudeToolFlag(args: string[], flagNames: string[]): boolean {
  return args.some((arg) => flagNames.some((flagName) => arg === flagName || arg.startsWith(`${flagName}=`)));
}

function resolveMissionOwnerPlanningContext(context: Record<string, unknown>): Record<string, unknown> | null {
  const manifest = parseObject(context.paperclipStepInputManifest);
  const manifestInputs = parseObject(manifest.inputs);
  const manifestPlanningContext = parseObject(manifestInputs.missionOwnerPlanningContext);
  if (manifestPlanningContext.available === true) return manifestPlanningContext;

  const directPlanningContext = parseObject(context.paperclipMissionOwnerPlanningContext);
  return Object.keys(directPlanningContext).length > 0 ? directPlanningContext : null;
}

function resolvePlanningRunDisallowedTools(config: Record<string, unknown>): string[] {
  const configured = asStringArray(config.planningRunDisallowedTools)
    .map((tool) => tool.trim())
    .filter(Boolean);
  const tools = configured.length > 0 ? configured : DEFAULT_PLANNING_RUN_DISALLOWED_TOOLS;
  return Array.from(new Set(tools));
}

function shouldApplyPlanningRunToolRestrictions(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
}): boolean {
  if (asBoolean(input.config.planningRunToolRestrictions, true) !== true) return false;
  return resolveMissionOwnerPlanningContext(input.context) !== null;
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // papercompany: Support isolated agent config directory when explicitly configured.
  // Do not set CLAUDE_CONFIG_DIR by default: Claude Code's subscription login is tied
  // to its default config resolution, and pointing CLAUDE_CONFIG_DIR at either an empty
  // value or ~/.claude makes the CLI report "Not logged in" on this host.
  const agentConfigDir =
    asString(config.claudeConfigDir, "") ||
    process.env.PAPERCLIP_AGENT_CLAUDE_CONFIG_DIR ||
    "";
  if (agentConfigDir) {
    env.CLAUDE_CONFIG_DIR = agentConfigDir;
  }

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. Use the local runtime from the PAPERCLIP_API_URL environment variable as the only API base URL, and include Authorization: Bearer $PAPERCLIP_API_KEY when the key is present. Never use https://runtime.paperclip.ai or any other legacy remote runtime during a local Papercompany heartbeat. For assignments, call GET $PAPERCLIP_API_URL/api/agents/me/inbox-lite first. Fall back only to GET $PAPERCLIP_API_URL/api/companies/{{agent.companyId}}/issues?assigneeAgentId={{agent.id}}&status=todo,in_progress,blocked when you need full issue objects. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. Never claim work by PATCHing an issue to in_progress; only POST $PAPERCLIP_API_URL/api/issues/{issueId}/checkout may move work into in_progress. Do not invent alternate completion routes such as mark-done; use PATCH $PAPERCLIP_API_URL/api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"} for done updates, PATCH with {\"status\":\"blocked\",\"comment\":\"blocker details\"} for blocked updates, and POST $PAPERCLIP_API_URL/api/issues/{issueId}/release only to give work back. If no assignments are returned from the local runtime, exit the heartbeat.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const configuredVisionCommand = asString(config.visionCommand, "").trim();
  const configuredVisionModel = asString(config.visionModel, "").trim();
  const dangerouslySkipPermissions = asBoolean(
    config.dangerouslySkipPermissions,
    config.dangerouslySkipPermissions !== false,
  );
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  await clearStalePyenvShimLock({ env: effectiveEnv, onLog });
  const skillsDir = await buildSkillsDir(config);
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsFileDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  const commandNotes = resolvedInstructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${resolvedInstructionsFilePath} (with path directive appended)`,
      ]
    : [];
  const shouldRestrictPlanningTools = shouldApplyPlanningRunToolRestrictions({ config, context });
  const extraArgsHaveDisallowedTools = hasClaudeToolFlag(extraArgs, ["--disallowedTools", "--disallowed-tools"]);
  const planningRunDisallowedTools = shouldRestrictPlanningTools && !extraArgsHaveDisallowedTools
    ? resolvePlanningRunDisallowedTools(config)
    : [];
  if (planningRunDisallowedTools.length > 0) {
    commandNotes.push(
      `Director/mission-owner planning run tool restriction: --disallowedTools ${planningRunDisallowedTools.join(",")}`,
    );
  } else if (shouldRestrictPlanningTools && extraArgsHaveDisallowedTools) {
    commandNotes.push("Director/mission-owner planning run tool restriction skipped because extraArgs already define --disallowedTools.");
  }

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath: string | undefined = resolvedInstructionsFilePath || undefined;
  if (resolvedInstructionsFilePath) {
    try {
      const loadedInstructions = await loadInstructionsWithInlinedReferences(resolvedInstructionsFilePath);
      const instructionsContent = loadedInstructions.content;
      const pathDirective = `\nThe above agent instructions were loaded from ${resolvedInstructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
      const combinedPath = path.join(skillsDir, "agent-instructions.md");
      await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
      effectiveInstructionsFilePath = combinedPath;
      await onLog("stderr", `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`);
      for (const includedPath of loadedInstructions.includedPaths) {
        await onLog("stderr", `[paperclip] Inlined referenced agent instructions file: ${includedPath}\n`);
      }
      for (const warning of loadedInstructions.warnings) {
        await onLog("stderr", `[paperclip] Warning: ${warning}\n`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
      effectiveInstructionsFilePath = undefined;
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const runtimeBrief = buildPaperclipRuntimeBrief(context);
  const visionHelperCommand = configuredVisionCommand || "$PAPERCLIP_VISION_COMMAND";
  const visionDelegationBrief = joinPromptSections([
    "Paperclip vision delegation (CRITICAL):",
    "- Keep your main reasoning on the configured primary model.",
    "- The primary model may be text-only. For image artifacts, using the Read tool sends image input to the primary model and can fail the run.",
    "- If a path ends in .png, .jpg, .jpeg, .webp, or .gif, DO NOT use the Read tool on that path.",
    "- Instead delegate only the visual inspection to the vision helper command via Bash, then continue from the helper's text result.",
    `- Helper command format: ${visionHelperCommand} <image-path> "<specific visual question>"`,
    `- Example: ${visionHelperCommand} "/absolute/path/to/artifact.png" "Validate visible text, claims, layout, and obvious rendering errors; return PASS or issues."`,
    `- Vision model hint: ${configuredVisionModel || "$PAPERCLIP_VISION_MODEL" || "vision-capable model"}.`,
    "- If the helper command is unavailable, block with a clear setup error instead of attempting image input on the primary model.",
  ]);
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    runtimeBrief,
    visionDelegationBrief,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: runtimeBrief.length,
    visionDelegationPromptChars: visionDelegationBrief.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    if (planningRunDisallowedTools.length > 0) {
      args.push("--disallowedTools", planningRunDisallowedTools.join(","));
    }
    args.push("--add-dir", skillsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (
    proc: RunProcessResult,
    parsedStream: ReturnType<typeof parseClaudeStreamJson>,
  ) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      if (parsedStream.sessionId || parsedStream.model) {
        return "Claude stream-json ended without a result event or assistant text";
      }
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const emitSessionUpdate = (() => {
    const seen = new Set<string>();
    return async (sessionId: string | null) => {
      if (!sessionId || seen.has(sessionId) || !ctx.onSessionUpdate) return;
      seen.add(sessionId);
      await ctx.onSessionUpdate({
        sessionId,
        sessionParams: {
          sessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        },
        sessionDisplayId: sessionId,
        source: "stdout",
        confidence: "provider_reported",
        observedAt: new Date().toISOString(),
      });
    };
  })();

  const maybeEmitSessionUpdateFromStdoutLine = async (line: string) => {
    const event = parseJson(line);
    if (!event) return;
    const type = asString(event.type, "");
    const subtype = asString(event.subtype, "");
    if (type !== "system" || subtype !== "init") return;
    const reportedSessionId = asString(event.session_id, "").trim();
    if (!reportedSessionId) return;
    await emitSessionUpdate(reportedSessionId);
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    let stdoutBuffer = "";
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      fatalOnLogError: true,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            await maybeEmitSessionUpdateFromStdoutLine(line);
            await onLog(stream, `${line}\n`);
          }
          return;
        }
        await onLog(stream, chunk);
      },
    });
    if (stdoutBuffer) {
      await maybeEmitSessionUpdateFromStdoutLine(stdoutBuffer);
      await onLog("stdout", stdoutBuffer);
    }

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc, parsedStream),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
