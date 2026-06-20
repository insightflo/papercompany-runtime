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
/**
 * hermes_local 실행 제한 기본값.
 * config.timeoutSec / idleTimeoutSec / graceSec 미설정일 때만 적용된다.
 *
 * [주의] DEFAULT_TIMEOUT_SEC 는 단일 hermes 실행의 wall-clock 상한이다. 이 값을
 *        넘기면 자식 프로세스를 강제 종료(SIGTERM → graceSec 후 SIGKILL)하고
 *        heartbeat run 은 failed 처리된다.
 *
 *        과거 300s 는 관측된 정상 run 최대치(~295s)와 거의 붙어 있어 정상 실행을
 *        false-kill 할 위험이 있어 600s 로 상향했다. 정상 hermes run 의 분포는
 *        14~295s(median ~159s)이므로 600s 는 충분한 여유폭이면서 hang 실행을
 *        10분 안에 확실히 자른다.
 *
 * [수정시 영향] DEFAULT_IDLE_TIMEOUT_SEC 는 의도적으로 0(비활성)을 유지한다.
 *        hermes run 은 LLM 추론 / 도구(curl 등) 대기로 수 분간 무출력이 정상이므로,
 *        idle timeout 을 기본으로 켜면 정상 run 을 false-kill 한다. idle 보호가
 *        필요한 company/agent 는 config.idleTimeoutSec 로 opt-in 할 것.
 *
 *        또한 idle timeout 은 "출력이 완전히 멈춘 경우"만 잡는다. 가즈아 사례처럼
 *        "출력을 뿜으며 도는 auth/API 재시도 루프(잘못된 API URL 하드코딩 등)"에는
 *        무력하므로, 그런 hang 은 근본 원인(API URL / 인증) 해결이 우선이다.
 */
const DEFAULT_TIMEOUT_SEC = 600;
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

function isHermesProgressNoiseLine(line: string) {
  return (
    /^Query:\s*/i.test(line) ||
    /^Initializing\b/i.test(line) ||
    /^Paperclip runtime brief\b/i.test(line) ||
    /^Reasoning$/i.test(line) ||
    /^loop\. Do not switch to text-only replies/i.test(line) ||
    /^the same tool, then try an absolute path/i.test(line) ||
    /^such as read_file\/write_file\/patch/i.test(line) ||
    /^error\/output and verify your assumptions/i.test(line) ||
    /Do not perform new source discovery/i.test(line) ||
    /Return PASS or REQUEST_CHANGES/i.test(line) ||
    /validator returned REQUEST_CHANGES/i.test(line) ||
    /Include article summaries/i.test(line) ||
    /^source quality, overclaiming/i.test(line) ||
    /^review diff$/i.test(line) ||
    /^💻 preparing terminal/i.test(line) ||
    /^\[hermes\]\s*/i.test(line)
  );
}

function looksLikeShellOrToolPayload(line: string) {
  return (
    /^\s*(?:#|echo\b)/.test(line) ||
    /^-d\s+/.test(line) ||
    /^@@\s/.test(line) ||
    /^[ab]\/\/tmp\//.test(line) ||
    /^✍️\s+write\b/.test(line) ||
    /^✍️\s+preparing\b/.test(line) ||
    /^⚡\s+Concurrent\b/.test(line) ||
    /\\"/.test(line) ||
    /(?:^|\s)(?:curl|rg|grep|jq|sed|awk|cat|find|git|pnpm|npm|node|python3?|tsx)\s/.test(line) ||
    /\|\s*(?:jq|grep|sed|awk)\b/.test(line) ||
    /\b(?:exit_code|stderr|stdout|workdir|timeout_ms)\b/.test(line) ||
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/api\//.test(line) ||
    /(?:^|\\)"https?:\/\/[^"]+(?:\\)?"\s*\|/.test(line) ||
    /\$AUTH\b/.test(line) ||
    /2>\/dev\/null/.test(line) ||
    /^\s*-iE\s+/.test(line)
  );
}

function looksLikeUserFacingProgressLine(line: string) {
  return (
    /^(?:알겠습니다|먼저|다음|이제|확인|수정|완료|작업|현재|좋습니다|검증|결과|두 워크플로우)/.test(line) ||
    /^(?:I\b|I'll\b|I'm\b|I’m\b|Let me\b|Now\b|Next\b|First\b|The files\b|The shell\b|Both\b|Good\b|Done\b|Completed\b|No matches\b|The grep\b)/i.test(line)
  );
}

function looksLikeToolContinuation(line: string) {
  return (
    /^[{}\[\]+,]/.test(line) ||
    /^\\?"/.test(line) ||
    /\\n/.test(line) ||
    /\b(?:stepCount|graphContainerType|branch-one)\b/.test(line) ||
    /^steps["']?\s*:/.test(line) ||
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

export function parseHermesProgressText(stdout: string) {
  const clean = stripAnsi(stdout);
  const markerIdx = clean.indexOf("Conversation completed after");
  const body = markerIdx >= 0 ? clean.slice(0, markerIdx) : clean;
  const lines = hermesDisplayLines(body)
    .filter((line) => !isHermesSpeakerLabel(line))
    .filter((line) => !isHermesCliChromeLine(line))
    .filter((line) => !looksLikeToolContinuation(line))
    .filter((line) => !looksLikeShellOrToolPayload(line))
    .filter((line) => !isHermesProgressNoiseLine(line))
    .filter(looksLikeUserFacingProgressLine);

  if (lines.length === 0) return null;
  return lines.join("\n").trim();
}

function parseHermesConversationResponse(stdout: string) {
  const clean = stripAnsi(stdout);
  const marker = "Conversation completed after";
  const markerIdx = clean.indexOf(marker);

  const responseFromLastHermesBlock = (body: string) => {
    const hermesBlockStart = Math.max(
      body.lastIndexOf("⚕ Hermes"),
      body.lastIndexOf("🤖 Hermes"),
      body.lastIndexOf("Hermes ─"),
    );
    if (hermesBlockStart < 0) return null;
    return responseFromDisplayLines(hermesDisplayLines(body.slice(hermesBlockStart)));
  };

  if (markerIdx >= 0) {
    const afterMarker = clean.slice(markerIdx + marker.length);
    const finalBlockEndMatch = afterMarker.match(/\n(?:Resume this session with:|Session:|Duration:|Messages:|\[hermes\])/);
    const finalBlock = finalBlockEndMatch?.index !== undefined
      ? afterMarker.slice(0, finalBlockEndMatch.index)
      : afterMarker;
    const finalResponse = responseFromLastHermesBlock(finalBlock);
    if (finalResponse) return finalResponse;
  }

  const beforeMarker = markerIdx >= 0 ? clean.slice(0, markerIdx) : clean;
  const response = responseFromLastHermesBlock(beforeMarker);
  if (response) return response;

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
  // [주의] ctx.config 는 heartbeat 가 resolveAdapterConfigForRuntime 으로 env 의 secret_ref
  //        를 plain 으로 resolve 한 결과다. ctx.agent.adapterConfig(원본) 에는 env 값이
  //        {type:"secret_ref"} 객체로 남아있어, 그대로 쓰면 hermes 자식 env 에 token 이
  //        안 들어간다(telegram 발송 실패). ctx.config(resolved) 를 우선 병합해 env 를
  //        plain 문자열로 쓴다.
  const config = {
    ...((ctx.agent?.adapterConfig as Record<string, unknown>) ?? {}),
    ...(ctx.config ?? {}),
  } as Record<string, unknown>;
  const hermesCmd = cfgString(config.command) || cfgString(config.hermesCommand) || HERMES_CLI;
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
