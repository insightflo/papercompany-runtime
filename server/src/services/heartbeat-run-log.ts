import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { appendWithCap, MAX_EXCERPT_BYTES, parseObject } from "../adapters/utils.js";
import { parseHermesProgressText } from "../adapters/hermes-local-execute.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { hermesChatService } from "./hermes-chat.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";
import { resolveRunawayAdvisorySoftBytes, resolveRunawayLogLimitBytes } from "./heartbeat-stability.js";
import { publishLiveEvent } from "./live-events.js";
import type { RunLogHandle, RunLogStore } from "./run-log-store.js";
import { evaluateRuntimeBroadScanHook } from "./runtime-broad-scan-hook.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const RUN_ACTIVITY_TOUCH_INTERVAL_MS = 15 * 1000;

interface HeartbeatRunLogOptions {
  db: Db;
  getRun: () => typeof heartbeatRuns.$inferSelect;
  adapterType: string;
  context: Record<string, unknown>;
  config: Record<string, unknown>;
  store: RunLogStore;
  getRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  appendEvent: (event: {
    eventType: string;
    stream: "system";
    level: "warn" | "error";
    message: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
  appendBroadScanEvent: (details: {
    reason: string;
    errorCode: string;
    phase: "runtime_hook";
    stream?: "stdout" | "stderr";
    matchedCommand: string | null;
    line: string;
  }) => Promise<void>;
}

// Per-run output state; shared event sequencing stays with the heartbeat caller.
export function createHeartbeatRunLog(options: HeartbeatRunLogOptions) {
  const { db, getRun, adapterType, context, store: runLogStore } = options;
  const runId = getRun().id;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";
  let stdoutGuardBuffer = "";
  let stderrGuardBuffer = "";
  let currentUserRedactionOptions: CurrentUserRedactionOptions | undefined;
  let hermesChatAssistantMessageId: string | null = null;
  let hermesChat: ReturnType<typeof hermesChatService> | null = null;
  // Preserve the existing advisory/kill policy until the C07 storage-limit step.
  const runawayLogLimitBytes = resolveRunawayLogLimitBytes(options.config);
  const runawayAdvisorySoftBytes = resolveRunawayAdvisorySoftBytes(runawayLogLimitBytes);
  let runawayLogBytes = 0;
  let runawayTriggered = false;
  let runawayAdvisoryEmitted = false;

  const evaluateRuntimeGuardLines = (stream: "stdout" | "stderr", text: string, flush = false) => {
    const currentBuffer = stream === "stdout" ? stdoutGuardBuffer : stderrGuardBuffer;
    const nextBuffer = currentBuffer + text;
    const lines = nextBuffer.split(/\r?\n/);
    const remaining = flush ? "" : (lines.pop() ?? "");
    if (stream === "stdout") stdoutGuardBuffer = remaining;
    else stderrGuardBuffer = remaining;
    return lines.filter((line) => line.trim().length > 0);
  };
  let lastHermesChatProgressText = "";
  let lastHermesChatProgressUpdateMs = 0;
  const maybeUpdateHermesChatProgress = async (now: Date) => {
    if (!hermesChat || !hermesChatAssistantMessageId || adapterType !== "hermes_local") return;
    const progressText = parseHermesProgressText(stdoutExcerpt);
    if (!progressText || progressText === lastHermesChatProgressText) return;
    if (now.getTime() - lastHermesChatProgressUpdateMs < 2_000) return;
    lastHermesChatProgressText = progressText;
    lastHermesChatProgressUpdateMs = now.getTime();
    try {
      await hermesChat.updateAssistantProgress(hermesChatAssistantMessageId, progressText);
    } catch (err) {
      logger.warn({ err, runId: getRun().id }, "failed to update Hermes chat progress");
    }
  };

  async function begin() {
    handle = await runLogStore.begin({
      companyId: getRun().companyId,
      agentId: getRun().agentId,
      runId,
    });

    await db
      .update(heartbeatRuns)
      .set({
        logStore: handle.store,
        logRef: handle.logRef,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    currentUserRedactionOptions = await options.getRedactionOptions();
    const hermesChatContext = parseObject(context.paperclipHermesChat);
    hermesChatAssistantMessageId = readNonEmptyString(hermesChatContext.assistantMessageId);
    hermesChat = hermesChatAssistantMessageId ? hermesChatService(db) : null;
  }

  let lastActivityTouchMs = 0;
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    let sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
    const now = new Date();
    const ts = now.toISOString();
    for (const line of evaluateRuntimeGuardLines(stream, sanitizedChunk)) {
      const hook = await evaluateRuntimeBroadScanHook(db, {
        adapterType,
        line,
        ts,
        context,
        runId: getRun().id,
      });
      if (hook.intercepted) {
        // Runtime broad-scan hook (audit-not-block): black-box CLI adapters
        // run outside heartbeat's stdio pipe — the synthetic output is
        // appended to runLogStore/excerpt/liveEvent for operator audit and
        // next-turn guidance only; it does NOT replace the agent's tool
        // result. The run continues (no throw) so the agent can retry with
        // a declared path or missionSearch. Only the current streaming chunk
        // is replaced (break at most one chunk); remaining output in this
        // callback is intentionally not forwarded — the agent's own context
        // is unaffected. Trade-off vs preflight hard-block is documented in
        // runtime-broad-scan-hook.ts file header.
        await options.appendBroadScanEvent({
          reason: hook.reason ?? "Broad-scan command intercepted; synthetic audit output injected (agent tool result unchanged)",
          errorCode: "manifest_broad_scan_hook_intercepted",
          phase: "runtime_hook",
          stream,
          matchedCommand: hook.rewrittenCommand ?? null,
          line,
        });
        sanitizedChunk = hook.syntheticOutput ?? "";
        break;
      }
    }
    if (stream === "stdout") stdoutExcerpt = appendWithCap(stdoutExcerpt, sanitizedChunk, MAX_EXCERPT_BYTES);
    if (stream === "stderr") stderrExcerpt = appendWithCap(stderrExcerpt, sanitizedChunk, MAX_EXCERPT_BYTES);
    if (stream === "stdout") await maybeUpdateHermesChatProgress(now);

    if (handle) {
      await runLogStore.append(handle, {
        stream,
        chunk: sanitizedChunk,
        ts,
      });
    }
    if (!runawayTriggered && runawayLogLimitBytes > 0) {
      runawayLogBytes += Buffer.byteLength(sanitizedChunk, "utf8");
      // [runaway advisory] 소프트 경고 — kill 전에 한 번, 감사 이벤트로 기록한다.
      //   (commandcode는 stdin이 ignore로 스폰되어 실행 중 주입은 불가; 대신 다음 실행
      //   웨이크의 paperclipRunawayRecoveryBrief가 회복 지시를 보장한다.)
      if (
        !runawayAdvisoryEmitted &&
        runawayAdvisorySoftBytes > 0 &&
        runawayLogBytes >= runawayAdvisorySoftBytes
      ) {
        runawayAdvisoryEmitted = true;
        await options.appendEvent({
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: `Runaway advisory: run log reached ${runawayLogBytes} bytes (soft threshold ${runawayAdvisorySoftBytes}, hard limit ${runawayLogLimitBytes}); the run will be terminated if output growth continues`,
          payload: {
            runawayLogBytes,
            runawayAdvisorySoftBytes,
            runawayLogLimitBytes,
          },
        }).catch(() => undefined);
      }
    }
    if (
      !runawayTriggered &&
      runawayLogLimitBytes > 0 &&
      runawayLogBytes > runawayLogLimitBytes
    ) {
      runawayTriggered = true;
      const tracked = runningProcesses.get(getRun().id);
      if (tracked) {
        tracked.child.kill("SIGTERM");
        setTimeout(() => {
          if (!tracked.child.killed) {
            tracked.child.kill("SIGKILL");
          }
        }, Math.max(1, tracked.graceSec) * 1000);
        runningProcesses.delete(getRun().id);
      }
      await options.appendEvent({
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: `Runaway log guard: run log exceeded ${runawayLogLimitBytes} bytes (wrote ${runawayLogBytes}); terminating adapter child`,
        payload: {
          runawayLogBytes,
          runawayLogLimitBytes,
        },
      }).catch(() => undefined);
    }
    if (now.getTime() - lastActivityTouchMs >= RUN_ACTIVITY_TOUCH_INTERVAL_MS) {
      lastActivityTouchMs = now.getTime();
      await db
        .update(heartbeatRuns)
        .set({ updatedAt: now })
        .where(eq(heartbeatRuns.id, getRun().id));
    }

    const payloadChunk =
      sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
        ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
        : sanitizedChunk;

    publishLiveEvent({
      companyId: getRun().companyId,
      type: "heartbeat.run.log",
      payload: {
        runId: getRun().id,
        agentId: getRun().agentId,
        ts,
        stream,
        chunk: payloadChunk,
        truncated: payloadChunk.length !== sanitizedChunk.length,
      },
    });
  };

  async function flushRuntimeGuardLines() {
    for (const line of [
      ...evaluateRuntimeGuardLines("stdout", "", true),
      ...evaluateRuntimeGuardLines("stderr", "", true),
    ]) {
      const hook = await evaluateRuntimeBroadScanHook(db, {
        adapterType,
        line,
        ts: new Date().toISOString(),
        context,
        runId: getRun().id,
      });
      if (hook.intercepted) {
        // Final-flush hook intercept: adapter has already returned, so this
        // is a retroactive audit only (no throw — marking the run failed over
        // a trailing broad scan would be punitive). Synthetic output is
        // appended to the run log for operator visibility. See
        // runtime-broad-scan-hook.ts header for the audit-not-block trade-off.
        if (handle) {
          try {
            await runLogStore.append(handle, { stream: "stdout", chunk: hook.syntheticOutput ?? "", ts: new Date().toISOString() });
          } catch {
            // non-fatal — the audit event below still records the interception
          }
        }
        await options.appendBroadScanEvent({
          reason: hook.reason ?? "Broad-scan command intercepted; synthetic audit output injected (agent tool result unchanged)",
          errorCode: "manifest_broad_scan_hook_intercepted",
          phase: "runtime_hook",
          matchedCommand: hook.rewrittenCommand ?? null,
          line,
        });
        break;
      }
    }
  }

  async function finalize() {
    return handle ? runLogStore.finalize(handle) : null;
  }

  async function finalizeAfterError() {
    try {
      return await finalize();
    } catch (finalizeErr) {
      logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
      return null;
    }
  }

  return {
    begin,
    onLog,
    flushRuntimeGuardLines,
    finalize,
    finalizeAfterError,
    get stdoutExcerpt() { return stdoutExcerpt; },
    get stderrExcerpt() { return stderrExcerpt; },
    get runawayTriggered() { return runawayTriggered; },
    get redactionOptions() { return currentUserRedactionOptions; },
  };
}
