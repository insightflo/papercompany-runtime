import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { appendWithCap, MAX_EXCERPT_BYTES, parseObject } from "../adapters/utils.js";
import { parseHermesProgressText } from "../adapters/hermes-local-execute.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { hermesChatService } from "./hermes-chat.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";
import { resolveRunawayLogLimitBytes } from "./heartbeat-stability.js";
import { publishLiveEvent } from "./live-events.js";
import { serializeRunLogEvent, type RunLogEvent, type RunLogHandle, type RunLogStore } from "./run-log-store.js";
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
    level: "info" | "warn" | "error";
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
  const storageLimitBytes = resolveRunawayLogLimitBytes(options.config);
  let storageCapped = false;
  let summaryEmitted = false;
  const storage = { storedRecords: 0, storedBytes: 0, omittedRecords: 0, omittedBytes: 0, writeErrors: 0 };

  async function appendStoredEvent(event: RunLogEvent) {
    if (!handle) return;
    const bytes = Buffer.byteLength(serializeRunLogEvent(event), "utf8");
    if (storageCapped || (storageLimitBytes > 0 && storage.storedBytes + bytes > storageLimitBytes)) {
      storageCapped = true;
      storage.omittedRecords += 1;
      storage.omittedBytes += bytes;
      return;
    }
    try {
      await runLogStore.append(handle, event);
      storage.storedRecords += 1;
      storage.storedBytes += bytes;
    } catch (err) {
      storage.writeErrors += 1;
      throw err;
    }
  }

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

    await appendStoredEvent({ stream, chunk: sanitizedChunk, ts });
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
            await appendStoredEvent({ stream: "stdout", chunk: hook.syntheticOutput ?? "", ts: new Date().toISOString() });
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
    if (!handle) return null;
    const summary = await runLogStore.finalize(handle);
    if (!summaryEmitted) {
      await options.appendEvent({
        eventType: "log_storage_summary",
        stream: "system",
        level: storage.omittedRecords || storage.writeErrors ? "warn" : "info",
        message: "Run log storage summary",
        payload: { version: 1, storageLimitBytes, ...storage, actualBytes: summary.bytes, sha256: summary.sha256 ?? null },
      });
      summaryEmitted = true;
    }
    return summary;
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
    // Compatibility for the caller; log volume no longer terminates execution.
    get runawayTriggered() { return false; },
    get redactionOptions() { return currentUserRedactionOptions; },
  };
}
