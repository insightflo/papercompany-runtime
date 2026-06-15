import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  imagePaths?: string[];
  worktreeMode?: boolean;
  checkpoints?: boolean;
  yolo?: boolean;
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
  for (const imagePath of input.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  if (input.toolsets) args.push("-t", input.toolsets);
  if (input.worktreeMode === true) args.push("-w");
  if (input.checkpoints === true) args.push("--checkpoints");
  if (input.yolo === true) args.push("--yolo");
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
  return joinPromptSections([
    isHermesOperationsLiaisonAgent(ctx) ? HERMES_OPERATIONS_LIAISON_BRIEF : null,
    runtimeBrief,
    renderTemplate(rendered, vars),
  ]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isHermesOperationsLiaisonAgent(ctx: AdapterExecutionContext) {
  const agent = ctx.agent as AdapterExecutionContext["agent"] & {
    runtimeConfig?: unknown;
    metadata?: unknown;
  };
  const runtimeConfig = asRecord(agent.runtimeConfig);
  const metadata = asRecord(agent.metadata);
  const domain = cfgString(runtimeConfig?.domain);
  const operatingMode = cfgString(runtimeConfig?.operatingMode);
  const purpose = cfgString(metadata?.purpose);
  return (
    agent.name === "Hermes Operations Manager" ||
    agent.name === "Hermes Ops Manager" ||
    domain === "operations" ||
    purpose === "research-company-hermes-management" ||
    purpose === "gazua-hermes-management" ||
    operatingMode === "chief_of_staff_liaison" ||
    operatingMode === "independent_management_operator"
  );
}

const HERMES_OPERATIONS_LIAISON_BRIEF = `## Hermes Ops Role

You are the chief of staff for the chairman/operator. Your job is to report clearly to the chairman and relay the chairman's intent to the organization.

Allowed:
- Monitor company, mission, workflow, and agent state.
- Summarize findings, risks, blockers, and recommended next actions.
- Relay user instructions to the proper mission main executor or responsible agent.
- Use Authorization: Bearer $PAPERCLIP_API_KEY for Paperclip API calls when the key is present; do not rely on local implicit board authority.

Not allowed:
- Do not directly perform mission work without explicit user instruction.
- Do not directly mutate mission issues, workflow runs, artifacts, or delivery state as a substitute for the mission main executor.
- If action is needed on a mission, signal the mission main executor and let that executor judge and coordinate recovery.`;

function dataUrlToImage(value: string): { mime: string; bytes: Buffer } | null {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match?.[1] || !match?.[2]) return null;
  return { mime: match[1], bytes: Buffer.from(match[2].replace(/\s+/g, ""), "base64") };
}

function extensionForImageMime(mime: string) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".img";
}

async function materializeHermesChatImages(context: Record<string, unknown>) {
  const chat = asRecord(context.paperclipHermesChat);
  const attachments = Array.isArray(chat?.attachments)
    ? chat.attachments.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const images = attachments
    .filter((attachment) =>
      attachment.kind === "image" &&
      typeof attachment.dataUrl === "string" &&
      attachment.dataUrl.startsWith("data:image/"))
    .slice(0, 4);
  if (images.length === 0) return [];

  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-hermes-chat-images-"));
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const decoded = dataUrlToImage(image.dataUrl as string);
    if (!decoded) continue;
    const filePath = path.join(dir, `attachment-${index + 1}${extensionForImageMime(decoded.mime)}`);
    await writeFile(filePath, decoded.bytes);
    paths.push(filePath);
  }
  return paths;
}

const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
const SESSION_LINE_REGEX = /^Session:\s*(\S+)/m;
const RESUME_SESSION_REGEX = /Resume this session with:\s*\n\s*hermes --resume\s+(\S+)/i;
const SESSION_ID_REGEX_LEGACY =
  /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function cleanHermesDisplayLine(line: string) {
  return line
    .replace(/^[\s│┊╭╰╮╯┌└┐┘├┤─━═]+/, "")
    .replace(/[\s│┊╭╰╮╯┌└┐┘├┤─━═]+$/, "")
    .trim();
}

function hermesDisplayLines(body: string) {
  return body
    .split(/\r?\n/)
    .map(cleanHermesDisplayLine)
    .filter(Boolean)
    .filter((line) => !/^Hermes\b/i.test(line))
    .filter((line) => !/^AI Agent initialized/i.test(line))
    .filter((line) => !/^Conversation completed after/i.test(line));
}

function isHermesSpeakerLabel(line: string) {
  return line.length <= 48 && /(?:^|\s)Hermes\s*$/i.test(line.replace(/[^\w\s-]/g, " ").trim());
}

function isHermesCliChromeLine(line: string) {
  return (
    /^✅ Tool \d+ completed\b/.test(line) ||
    /^📞 Tool \d+:/u.test(line) ||
    /^Args:\s*\{?/.test(line) ||
    /^Result:\s*/.test(line) ||
    /^💻\s*\$/.test(line) ||
    /^Tool \d+ completed\b/.test(line) ||
    /^Resume this session with:/i.test(line) ||
    /^Session:\s*/i.test(line) ||
    /^Duration:\s*/i.test(line) ||
    /^Messages:\s*/i.test(line)
  );
}

function looksLikeToolContinuation(line: string) {
  return (
    /^[{}\[\]",]/.test(line) ||
    /^["']?(?:command|timeout|workdir|output|exit_code|error)["']?\s*:/.test(line) ||
    /^\w+:\s*\{/.test(line) ||
    /^null[},]?$/.test(line)
  );
}

function responseFromDisplayLines(lines: string[]) {
  const speakerIdx = lines.findLastIndex(isHermesSpeakerLabel);
  const candidateLines = speakerIdx >= 0 && speakerIdx < lines.length - 1
    ? lines.slice(speakerIdx + 1)
    : lines.filter((line) => !isHermesSpeakerLabel(line));
  const lastToolChromeIdx = candidateLines.findLastIndex(isHermesCliChromeLine);
  const afterToolChrome = lastToolChromeIdx >= 0 ? candidateLines.slice(lastToolChromeIdx + 1) : candidateLines;
  const responseLines = afterToolChrome
    .filter((line) => !isHermesCliChromeLine(line))
    .filter((line) => !looksLikeToolContinuation(line));
  return responseLines.length > 0 ? responseLines.join("\n").trim() : null;
}

function parseHermesConversationResponse(stdout: string) {
  const clean = stripAnsi(stdout);
  const marker = "Conversation completed after";
  const markerIdx = clean.indexOf(marker);

  const beforeMarker = markerIdx >= 0 ? clean.slice(0, markerIdx) : clean;
  const hermesBlockStart = Math.max(
    beforeMarker.lastIndexOf("⚕ Hermes"),
    beforeMarker.lastIndexOf("🤖 Hermes"),
    beforeMarker.lastIndexOf("Hermes ─"),
  );
  if (hermesBlockStart >= 0) {
    const response = responseFromDisplayLines(hermesDisplayLines(beforeMarker.slice(hermesBlockStart)));
    if (response) return response;
  }

  if (markerIdx < 0) return null;
  const afterMarkerLine = clean.slice(markerIdx).split(/\r?\n/).slice(1).join("\n");
  const endMatch = afterMarkerLine.match(/\n(?:Resume this session with:|Session:|Duration:|Messages:|\[hermes\])/);
  const body = (endMatch?.index !== undefined ? afterMarkerLine.slice(0, endMatch.index) : afterMarkerLine).trim();
  return responseFromDisplayLines(hermesDisplayLines(body));
}

export function parseHermesOutput(stdout: string, stderr: string) {
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
    const resumeMatch = combined.match(RESUME_SESSION_REGEX);
    const sessionLineMatch = combined.match(SESSION_LINE_REGEX);
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    result.sessionId = resumeMatch?.[1] ?? sessionLineMatch?.[1] ?? legacyMatch?.[1];
  }
  result.response ??= parseHermesConversationResponse(stdout) ?? undefined;

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
  const imagePaths = await materializeHermesChatImages(ctx.context);

  const prevSessionId = cfgString(ctx.runtime?.sessionParams?.sessionId);
  const args = buildHermesChatArgs({
    prompt,
    model,
    provider,
    toolsets,
    imagePaths,
    worktreeMode: cfgBoolean(config.worktreeMode),
    checkpoints: cfgBoolean(config.checkpoints),
    yolo: cfgBoolean(config.yolo) || cfgBoolean(config.autoApproveTools) || Boolean(ctx.context.paperclipHermesChat),
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
  const hasSuccessfulAnswer = result.exitCode === 0 && !result.timedOut && Boolean(parsed.response?.trim());
  if (parsed.errorMessage && !hasSuccessfulAnswer) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (parsed.errorMessage && hasSuccessfulAnswer) {
    executionResult.resultJson = {
      ...executionResult.resultJson,
      warning: parsed.errorMessage,
    };
  }
  if (parsed.usage) executionResult.usage = parsed.usage;
  if (parsed.costUsd !== undefined) executionResult.costUsd = parsed.costUsd;
  if (parsed.response) executionResult.summary = parsed.response.slice(0, 2000);
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }
  return executionResult;
}
