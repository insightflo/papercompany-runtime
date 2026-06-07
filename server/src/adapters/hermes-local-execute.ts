import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipRuntimeBrief,
  joinPromptSections,
  renderTemplate,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const HERMES_CLI = "hermes";
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_GRACE_SEC = 10;
const DEFAULT_IDLE_TIMEOUT_SEC = 0;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "mimo",
  "xiaomi-mimo",
];

function cfgString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cfgNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function cfgBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function cfgStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export function buildHermesChatArgs(input: {
  prompt: string;
  model: string;
  provider?: string;
  toolsets?: string;
  worktreeMode?: boolean;
  checkpoints?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  persistSession?: boolean;
  prevSessionId?: string;
  extraArgs?: string[];
}): string[] {
  const args = ["chat", "-q", input.prompt];

  // Paperclip needs Hermes' live terminal output in the run transcript.  Keep
  // quiet mode opt-in only; the old default (`-Q`) hid tool/progress previews
  // and made long Hermes turns look idle to the process supervisor.
  if (input.quiet === true) args.push("-Q");

  args.push("-m", input.model);
  if (input.provider && VALID_PROVIDERS.includes(input.provider))
    args.push("--provider", input.provider);
  if (input.toolsets) args.push("-t", input.toolsets);
  if (input.worktreeMode === true) args.push("-w");
  if (input.checkpoints === true) args.push("--checkpoints");
  if (input.verbose !== false && input.quiet !== true) args.push("-v");
  if (input.persistSession !== false && input.prevSessionId)
    args.push("--resume", input.prevSessionId);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  return args;
}

export function formatHermesTimeoutLabel(input: {
  timeoutSec: number;
  idleTimeoutSec: number;
}): string {
  return input.idleTimeoutSec > 0
    ? `timeout=${input.timeoutSec}s, idleTimeout=${input.idleTimeoutSec}s`
    : `timeout=${input.timeoutSec}s, idleTimeout=disabled`;
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
) {
  const template =
    cfgString(config.promptTemplate) ??
    `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls.

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools.
2. When done, mark the issue as completed.
3. Report what you did.
{{/taskId}}

{{#noTask}}
## Heartbeat Wake

Check your assigned todo issues. If none exist, report briefly and exit.
{{/noTask}}`;

  const taskId = cfgString(ctx.config?.taskId);
  const agentName = ctx.agent?.name || "Hermes Agent";
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }
  const runtimeBrief = buildPaperclipRuntimeBrief(ctx.context);

  const vars = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName: cfgString(ctx.config?.companyName) || "",
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle: cfgString(ctx.config?.taskTitle) || "",
    taskBody: cfgString(ctx.config?.taskBody) || "",
    projectName: cfgString(ctx.config?.projectName) || "",
    paperclipApiUrl,
  };

  let rendered = template;
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );
  return joinPromptSections([runtimeBrief, renderTemplate(rendered, vars)]);
}

const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
const SESSION_ID_REGEX_LEGACY =
  /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

function parseHermesOutput(stdout: string, stderr: string) {
  const combined = `${stdout}\n${stderr}`;
  const result: {
    sessionId?: string;
    response?: string;
    usage?: { inputTokens: number; outputTokens: number };
    costUsd?: number;
    errorMessage?: string;
  } = {};

  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch[1];
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0)
      result.response = stdout.slice(0, sessionLineIdx).trim();
  } else {
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) result.sessionId = legacyMatch[1];
  }

  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: Number.parseInt(usageMatch[1] ?? "0", 10) || 0,
      outputTokens: Number.parseInt(usageMatch[2] ?? "0", 10) || 0,
    };
  }

  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) result.costUsd = Number.parseFloat(costMatch[1]);

  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) =>
        /error|exception|traceback|failed|No process output/i.test(line),
      )
      .filter((line) => !/INFO|DEBUG/i.test(line));
    if (errorLines.length > 0)
      result.errorMessage = errorLines.slice(0, 5).join("\n");
  }

  return result;
}

export async function executeHermesLocal(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const provider = cfgString(config.provider);
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const idleTimeoutSec =
    cfgNumber(config.idleTimeoutSec) ?? DEFAULT_IDLE_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const toolsets =
    cfgString(config.toolsets) ||
    cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const prompt = buildPrompt(ctx, config);

  const prevSessionId = cfgString(ctx.runtime?.sessionParams?.sessionId);
  const args = buildHermesChatArgs({
    prompt,
    model,
    provider,
    toolsets,
    worktreeMode: cfgBoolean(config.worktreeMode),
    checkpoints: cfgBoolean(config.checkpoints),
    quiet: cfgBoolean(config.quiet),
    verbose: cfgBoolean(config.verbose),
    persistSession,
    prevSessionId,
    extraArgs,
  });

  const rawEnv: Record<string, unknown> = {
    ...process.env,
    ...buildPaperclipEnv(ctx.agent),
  };
  if (ctx.runId) rawEnv.PAPERCLIP_RUN_ID = ctx.runId;
  const taskId = cfgString(ctx.config?.taskId);
  if (taskId) rawEnv.PAPERCLIP_TASK_ID = taskId;
  if (config.env && typeof config.env === "object")
    Object.assign(rawEnv, config.env);
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal; runChildProcess will report a precise launch error if needed.
  }

  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, ${formatHermesTimeoutLabel({ timeoutSec, idleTimeoutSec })})\n`,
  );
  if (prevSessionId)
    await ctx.onLog("stdout", `[hermes] Resuming session: ${prevSessionId}\n`);

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    idleTimeoutSec,
    graceSec,
    onLog: ctx.onLog,
    onSpawn: ctx.onSpawn,
  });

  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}, idle timed out: ${result.idleTimedOut === true}\n`,
  );
  if (parsed.sessionId)
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);

  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: provider || null,
    model,
  };
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };
  if (result.idleTimedOut)
    executionResult.errorMessage = `No process output for ${idleTimeoutSec}s`;
  if (parsed.errorMessage) executionResult.errorMessage = parsed.errorMessage;
  if (parsed.usage) executionResult.usage = parsed.usage;
  if (parsed.costUsd !== undefined) executionResult.costUsd = parsed.costUsd;
  if (parsed.response) executionResult.summary = parsed.response.slice(0, 2000);
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }
  return executionResult;
}
