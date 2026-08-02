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
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import type { CommandCodeResultSubtype, ParsedCommandCodeOutput } from "./parse.js";
import { isCommandCodeUnknownSessionError, parseCommandCodeJsonl } from "./parse.js";
import {
  buildCommandCodeRunEnv,
  resolveEffectiveCwd,
  resolveExtraArgs,
  sanitizeCommandCodeExtraArgs,
} from "./env.js";

const DEFAULT_HEARTBEAT_PROMPT =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. If no assignments are returned, exit the heartbeat.";

const MAX_TURNS_CAP_EXIT_CODE = 8;

type RunProc = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

type OutcomeKind = "success" | "error" | "max_turns" | "missing_result";

interface Outcome {
  kind: OutcomeKind;
  isFailure: boolean;
  errorCode: string | null;
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
  if (!model || !model.includes("/")) return null;
  return model.slice(0, model.indexOf("/")).trim() || null;
}

function resolveCommandCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "commandcode";
}

/**
 * The always-last result line is the only execution-outcome authority.
 * - subtype "error" fails even when the OS exit code is 0.
 * - subtype "max_turns" (or documented exit 8) is represented via errorCode.
 * - a process that exits 0 with NO result line is a fail-closed failure.
 */
function classifyOutcome(parsed: ParsedCommandCodeOutput, exitCode: number | null): Outcome {
  const nonzeroExit = exitCode === null || exitCode !== 0;
  if (parsed.subtype === "error") {
    return { kind: "error", isFailure: true, errorCode: null };
  }
  if (parsed.subtype === "max_turns" || exitCode === MAX_TURNS_CAP_EXIT_CODE) {
    return { kind: "max_turns", isFailure: false, errorCode: "commandcode_max_turns" };
  }
  if (parsed.subtype === "success") {
    // A success frame with a non-max-turns nonzero/null exit (auth, permission,
    // rate limit, ...) must NOT succeed.
    return { kind: "success", isFailure: nonzeroExit || parsed.errors.length > 0, errorCode: null };
  }
  // No result line: fail closed regardless of exit code.
  return { kind: "missing_result", isFailure: true, errorCode: "commandcode_missing_result" };
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
      "--permission-mode",
      "auto-accept",
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
    // A logical failure (error subtype or missing result) with OS exit 0 must
    // not present contradictory exit metadata; synthesize exit 1 (OpenCode parity).
    const logicalFailureNoExit = outcome.isFailure && (rawExitCode === null || rawExitCode === 0);
    const reportedExitCode = logicalFailureNoExit ? 1 : rawExitCode;

    let errorMessage: string | null;
    switch (outcome.kind) {
      case "error":
        errorMessage = parsedError || stderrLine || `Command Code run failed (exit ${rawExitCode ?? -1})`;
        break;
      case "max_turns":
        errorMessage = "Command Code reached the --max-turns cap before completing; partial response returned.";
        break;
      case "missing_result":
        errorMessage = `Command Code exited (code ${rawExitCode ?? -1}) without a final result line; treating the run as failed.`;
        break;
      default:
        errorMessage = outcome.isFailure
          ? (parsedError || stderrLine || `Command Code reported success but the process exited abnormally (code ${rawExitCode ?? -1}).`)
          : null;
    }

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
  const initialOutcome = classifyOutcome(initial.parsed, initial.proc.exitCode);

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
