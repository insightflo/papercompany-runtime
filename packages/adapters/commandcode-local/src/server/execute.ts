import path from "node:path";
import {
  buildPaperclipRuntimeBrief,
  inferOpenAiCompatibleBiller,
  joinPromptSections,
  renderTemplate,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { applyInstructionInjectionPolicy, loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import {
  asBoolean,
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import type { ParsedCommandCodeOutput } from "./parse.js";
import { extractRunEndRecovery, extractRunTailRecovery, isCommandCodeUnknownSessionError, parseCommandCodeJsonl } from "./parse.js";
import {
  buildCommandCodePermissionArgs,
  buildCommandCodeRunEnv,
  resolveEffectiveCwd,
  resolveExtraArgs,
  sanitizeCommandCodeExtraArgs,
} from "./env.js";
import { classifyOutcome, resolveErrorMessage, type Outcome } from "./outcome.js";

const DEFAULT_HEARTBEAT_PROMPT =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. If no assignments are returned, exit the heartbeat.";

type RunProc = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model || !model.includes("/")) return null;
  return model.slice(0, model.indexOf("/")).trim() || null;
}

function resolveCommandCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "commandcode";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(config.promptTemplate, DEFAULT_HEARTBEAT_PROMPT);
  const command = asString(config.command, "cmd");
  const model = asString(config.model, "").trim();
  const effort = asString(config.effort, asString(config.modelReasoningEffort, "")).trim();
  const maxTurns = asNumber(config.maxTurns, 0);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);

  const sanitized = sanitizeCommandCodeExtraArgs(resolveExtraArgs(config));
  if (sanitized.dropped.length > 0) {
    await onLog(
      "stderr",
      `[paperclip] Dropped reserved Command Code flag(s) from extraArgs to protect enforced output, automation, model, max-turns, resume, and session settings: ${sanitized.dropped.join(" ")}\n`,
    );
  }
  const extraArgs = sanitized.args;

  const workspace = resolveEffectiveCwd(config, context);
  const cwd = workspace.cwd;
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const { runtimeEnv, redactedEnv } = buildCommandCodeRunEnv({
    runId,
    agent,
    config,
    context,
    authToken,
    workspace,
  });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  // Fold agent instructions + runtime brief into the single `-p` prompt.
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const commandNotes: string[] = [];

  let instructionsText = "";
  if (resolvedInstructionsFilePath) {
    try {
      const loaded = applyInstructionInjectionPolicy(
        await loadInstructionsWithInlinedReferences(resolvedInstructionsFilePath),
        ctx.context,
      );
      instructionsText = loaded.content;
      commandNotes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      await onLog("stdout", `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`);
      for (const includedPath of loaded.includedPaths) {
        await onLog("stdout", `[paperclip] Inlined referenced agent instructions file: ${includedPath}\n`);
      }
      for (const warning of loaded.warnings) {
        await onLog("stdout", `[paperclip] Warning: ${warning}\n`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      commandNotes.push(`Instructions file ${resolvedInstructionsFilePath} could not be read; continuing without it.`);
      await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`);
    }
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedInstructions = instructionsText ? renderTemplate(instructionsText, templateData) : "";
  const renderedBootstrap =
    bootstrapPromptTemplate.trim().length > 0 ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
  const runtimeBrief = buildPaperclipRuntimeBrief(context);
  const renderedHeartbeat = renderTemplate(promptTemplate, templateData);
  const userPrompt = joinPromptSections([renderedInstructions, renderedBootstrap, runtimeBrief, renderedHeartbeat]);

  // Session resume: target an explicit id when the cwd still matches.
  const runtimeSessionParams =
    typeof runtime.sessionParams === "object" && runtime.sessionParams !== null
      ? (runtime.sessionParams as Record<string, unknown>)
      : {};
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, asString(runtime.sessionId, ""));
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const resumeId = canResumeSession ? runtimeSessionId : "";

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Command Code session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const buildArgs = (sessionResumeId: string): string[] => {
    const args: string[] = [];
    if (sessionResumeId) args.push("--resume", sessionResumeId);
    args.push(
      "--skip-onboarding",
      ...buildCommandCodePermissionArgs(dangerouslySkipPermissions),
      "--trust",
      "--output-format",
      "json",
      "--no-auto-update",
    );
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(Math.floor(maxTurns)));
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("-p", userPrompt);
    return args;
  };

  const provider = parseModelProvider(model || null);
  const biller = resolveCommandCodeBiller(runtimeEnv, provider);

  const runAttempt = async (sessionResumeId: string) => {
    const args = buildArgs(sessionResumeId);
    if (onMeta) {
      await onMeta({
        adapterType: "commandcode_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactedEnv,
        prompt: userPrompt,
        promptMetrics: {
          instructionsChars: renderedInstructions.length,
          promptChars: userPrompt.length,
          bootstrapPromptChars: renderedBootstrap.length,
          sessionHandoffChars: runtimeBrief.length,
          heartbeatPromptChars: renderedHeartbeat.length,
        },
        context,
      });
    }
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      fatalOnLogError: true,
      onSpawn,
      onLog,
    });
    return { proc, parsed: parseCommandCodeJsonl(proc.stdout) };
  };

  const toResult = (
    proc: RunProc,
    parsed: ParsedCommandCodeOutput,
    outcome: Outcome,
    clearSession: boolean,
  ): AdapterExecutionResult => {
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession,
      };
    }

    const resolvedSessionId = clearSession ? null : (parsed.sessionId ?? (resumeId || null));
    const resolvedSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;
    const stderrLine = firstNonEmptyLine(proc.stderr);
    const rawExitCode = proc.exitCode;
    const parsedError = parsed.errors[0] ?? null;
    // A logical failure (error subtype, missing result, or permission denial)
    // with OS exit 0 must not present contradictory exit metadata; synthesize
    // exit 1 (OpenCode parity).
    const logicalFailureNoExit = outcome.isFailure && (rawExitCode === null || rawExitCode === 0);
    const reportedExitCode = logicalFailureNoExit ? 1 : rawExitCode;
    const errorMessage = resolveErrorMessage(outcome, {
      parsedError,
      stderrLine,
      rawExitCode,
    });

    return {
      exitCode: reportedExitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: outcome.errorCode,
      usage: {
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        cachedInputTokens: parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider,
      biller,
      model: model || null,
      billingType: "unknown",
      costUsd: parsed.costUsd,
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
      summary: parsed.finalMessage ?? (parsed.messages.join("\n\n").trim() || null),
      clearSession,
    };
  };

  const initial = await runAttempt(resumeId);
  let initialOutcome = classifyOutcome(initial.parsed, initial.proc.exitCode);

  // [run_end/run-tail recovery] result 줄 부재(missing_result)지만 스트림 꼬리가 실행 완료를
  //   증명하면 success 로 회복한다. 1차: 온전한 run_end 프레임. 2차: 마지막 turn_end(hadToolCalls
  //   없음) + 그 직전 text-only message_end — CLI 1.26.0 이 거대 run_end 출력 중 끊기는 사례
  //   (2026-08-19 A1 실측 10건 전부). 회복 시 finalText/usage/sessionId 를 반영해 청구·요약·
  //   세션 연속이 정확해진다. 그 외는 기존대로 fail-closed(규칙 8).
  if (initialOutcome.kind === "missing_result") {
    const recovery = extractRunEndRecovery(initial.proc.stdout);
    const tail = recovery.recovered ? recovery : extractRunTailRecovery(initial.proc.stdout);
    if (tail.recovered) {
      const recoverySource = recovery.recovered ? "complete run_end frame" : "turn_end + final message_end tail";
      if (tail.finalMessage !== null) {
        initial.parsed.finalMessage = tail.finalMessage;
        initial.parsed.messages.push(tail.finalMessage);
      }
      await onLog("stdout", `[paperclip] Command Code result line missing; recovered final outcome from the ${recoverySource} (stopReason=${tail.stopReason ?? "unknown"}).\n`);
      initial.parsed.subtype = "success";
      initial.parsed.stopReason = tail.stopReason;
      if (tail.sessionId) initial.parsed.sessionId = tail.sessionId;
      if (tail.usage) initial.parsed.usage = tail.usage;
      initialOutcome = classifyOutcome(initial.parsed, initial.proc.exitCode);
    }
  }

  // Stale-session recovery: retry fresh, then preserve any new session id
  // returned by the retry; clear only when the retry produced no new session.
  if (
    canResumeSession &&
    initialOutcome.isFailure &&
    isCommandCodeUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog("stdout", `[paperclip] Command Code session "${resumeId}" is unavailable; retrying with a fresh run.\n`);
    const retry = await runAttempt("");
    const retryOutcome = classifyOutcome(retry.parsed, retry.proc.exitCode);
    const retryHasSession = Boolean(retry.parsed.sessionId);
    return toResult(retry.proc, retry.parsed, retryOutcome, !retryHasSession);
  }

  return toResult(initial.proc, initial.parsed, initialOutcome, false);
}
