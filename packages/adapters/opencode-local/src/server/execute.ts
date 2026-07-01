import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaperclipRuntimeBrief, inferOpenAiCompatibleBiller, joinPromptSections, renderTemplate, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
import { ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * opencode → provider(z.ai GLM 등) 비응답 / overload hang 방어.
 *
 * [목적] wake-on-demand + heartbeat 비활성 에이전트는 heartbeat execution_stale reaper 가
 *        감시하지 않는다(app.ts 의 주기 heartbeat timer 는 Hermes Ops 유일). 그래서 adapter
 *        실행 자체에 상한이 없으면 z.ai GLM 비응답 시 opencode 자식이 run 을 영구 점거한다
 *        (가즈아 25h hang 과 동일 계보, opencode_local 경로로 발현). adapter 단에서 (a) 무출력
 *        idle timeout 으로 hang 을 빠르게 절단하고, (b) provider overload(z.ai 529 등) 를 같은
 *        session 으로 backoff 재시도해 issue 증식 없이 극복한다. hang 절단 시 run 이 종료되고
 *        다음 wake(handoff)가 발화한다.
 * [입력] config.timeoutSec(미설정 시 hard backstop), config.idleTimeoutSec(미설정 시 1800s),
 *        config.maxOverloadRetries / config.overloadBackoffMs.
 * [출력] runChildProcess 로 전달되는 timeoutSec/idleTimeoutSec 와 overload 재시도 루프.
 * [수정시 영향] idleTimeoutSec 기본 1800s(30min) — 정상 run 은 JSON 이벤트를 계속 뿜으므로
 *        활동 중인 긴 run(실측 ~27min/step)은 보호되고, GLM no-response(출력 0)만 절단.
 *        hard timeout 기본 7200s(2h) pure backstop. overload 재시도는 timeout 시도는 제외.
 */
const DEFAULT_HARD_TIMEOUT_SEC = 7200;
const DEFAULT_IDLE_TIMEOUT_SEC = 1800;
const DEFAULT_MAX_OVERLOAD_RETRIES = 3;
const DEFAULT_OVERLOAD_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// provider overload 신호 탐지(429/503/529 status, overload/rate-limit 키워드). z.ai GLM 529 포함.
// 500 은 status 문맥에서만 매치(토큰 카운트 등 노이즈 회피).
const OPENCODE_PROVIDER_OVERLOAD_RE =
  /\b(status[_\s:]*(?:429|500|503|529)|(?:429|503|529)\b|overload|rate[\s_-]?limit|too many requests|service unavailable|temporarily unavailable)/i;

/** opencode stdout(JSON event error → parsed.errorMessage) + stderr 에서 provider overload 탐지. */
export function isOpenCodeProviderOverloaded(
  parsed: { errorMessage: string | null },
  stderr: string,
): boolean {
  const text = `${parsed.errorMessage ?? ""}\n${stderr ?? ""}`;
  return OPENCODE_PROVIDER_OVERLOAD_RE.test(text);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const skillsHome = claudeSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. If no assignments are returned, exit the heartbeat.",
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolvePaperclipDesiredSkillNames(config, openCodeSkillEntries);
  await ensureOpenCodeSkillsInjected(
    onLog,
    openCodeSkillEntries,
    desiredOpenCodeSkillNames,
  );

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent, { context }) };
  env.PAPERCLIP_RUN_ID = runId;
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
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  try {
    await ensureOpenCodeModelConfiguredAndAvailable({
      model,
      command,
      cwd,
      env: runtimeEnv,
    });
  } catch (err) {
    if (wakeReason !== "adapter_fallback" || !model) throw err;
    await onLog(
      "stderr",
      `[paperclip] OpenCode model discovery failed during adapter fallback; continuing with configured model "${model}": ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  // hard timeout: 순수 backstop 상한. config 가 양수로 명시하면 존중, 아니면 2h.
  const explicitTimeoutSec =
    typeof config.timeoutSec === "number" && Number.isFinite(config.timeoutSec) && config.timeoutSec > 0
      ? config.timeoutSec
      : null;
  const timeoutSec = explicitTimeoutSec ?? DEFAULT_HARD_TIMEOUT_SEC;
  const graceSec = asNumber(config.graceSec, 20);
  // idleTimeoutSec: opencode 가 N초간 한 글자도 출력 안 하면 hang(z.ai GLM no-response)으로 보고
  // 종료. 정상 run 은 JSON 이벤트를 계속 뿜으므로 활동 중인 긴 run 은 보호된다. wake-on-demand +
  // heartbeat 비활성 에이전트는 execution_stale reaper 가 안 보기 때문에 이 idle 감시가 핵심이다.
  const explicitIdleSec =
    typeof config.idleTimeoutSec === "number" && Number.isFinite(config.idleTimeoutSec) && config.idleTimeoutSec > 0
      ? config.idleTimeoutSec
      : null;
  const idleTimeoutSec = explicitIdleSec ?? DEFAULT_IDLE_TIMEOUT_SEC;
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

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
      `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const loadedInstructions = await loadInstructionsWithInlinedReferences(resolvedInstructionsFilePath);
      const instructionsContents = loadedInstructions.content;
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stdout",
        `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
      for (const includedPath of loadedInstructions.includedPaths) {
        await onLog("stdout", `[paperclip] Inlined referenced agent instructions file: ${includedPath}\n`);
      }
      for (const warning of loadedInstructions.warnings) {
        await onLog("stdout", `[paperclip] Warning: ${warning}\n`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) return [] as string[];
    if (instructionsPrefix.length > 0) {
      return [
        `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    ];
  })();

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
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    runtimeBrief,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: runtimeBrief.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["run", "--format", "json"];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  let sessionUpdateEmitted = false;
  const readSessionIdFromLine = (rawLine: string): string | null => {
    const event = parseJson(rawLine.trim());
    if (!event) return null;
    return asString(event.sessionID, "").trim() || null;
  };
  const maybeEmitSessionUpdate = async (rawLine: string) => {
    if (sessionUpdateEmitted || !ctx.onSessionUpdate) return;
    const discoveredSessionId = readSessionIdFromLine(rawLine);
    if (!discoveredSessionId) return;
    sessionUpdateEmitted = true;
    await ctx.onSessionUpdate({
      sessionId: discoveredSessionId,
      sessionParams: {
        sessionId: discoveredSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      },
      sessionDisplayId: discoveredSessionId,
      source: "stdout",
      confidence: "provider_reported",
      observedAt: new Date().toISOString(),
    });
  };
  let stdoutLineBuffer = "";
  const onLogWithSessionUpdate: AdapterExecutionContext["onLog"] = async (stream, chunk) => {
    if (stream !== "stdout") {
      await onLog(stream, chunk);
      return;
    }
    const combined = `${stdoutLineBuffer}${chunk}`;
    const lines = combined.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      await maybeEmitSessionUpdate(line);
    }
    await onLog(stream, chunk);
  };
  const flushSessionUpdateBuffer = async () => {
    const trailing = stdoutLineBuffer.trim();
    stdoutLineBuffer = "";
    if (trailing) await maybeEmitSessionUpdate(trailing);
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "opencode_local",
        command,
        cwd,
        commandNotes,
        commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: prompt,
      timeoutSec,
      idleTimeoutSec,
      graceSec,
      fatalOnLogError: true,
      onSpawn,
      onLog: onLogWithSessionUpdate,
    });
    await flushSessionUpdateBuffer();
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseOpenCodeJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenCodeJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
    const modelId = model || null;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: parseModelProvider(modelId),
      biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
      model: modelId,
      billingType: "unknown",
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  // provider overload(z.ai GLM 529 등) 시 같은 session 으로 backoff 재시도. adapter 안에서
  // 극복해 workflow 엔진이 step 을 재dispatch 하며 새 issue 를 찍어내는 증식을 막는다.
  // timeout(idle/hard)으로 종료된 시도는 재시도하지 않는다(hang 절단이 우선).
  const maxOverloadRetries = Math.max(0, asNumber(config.maxOverloadRetries, DEFAULT_MAX_OVERLOAD_RETRIES));
  const overloadBackoffMs = Math.max(0, asNumber(config.overloadBackoffMs, DEFAULT_OVERLOAD_BACKOFF_MS));

  let initial = await runAttempt(sessionId);
  for (
    let overloadAttempt = 0;
    overloadAttempt < maxOverloadRetries &&
    !initial.proc.timedOut &&
    isOpenCodeProviderOverloaded(initial.parsed, initial.rawStderr);
    overloadAttempt += 1
  ) {
    const waitMs = overloadBackoffMs * 2 ** overloadAttempt + Math.floor(Math.random() * 500);
    await onLog(
      "stdout",
      `[paperclip] OpenCode provider overloaded; retry ${overloadAttempt + 1}/${maxOverloadRetries} after ~${Math.round(waitMs / 1000)}s with the same session (no new issue).\n`,
    );
    await sleep(waitMs);
    initial = await runAttempt(sessionId);
  }

  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
  if (
    sessionId &&
    initialFailed &&
    isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
