import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readUsageNumbers(usage: unknown) {
  const u = asRecord(usage);
  if (!u) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  return {
    inputTokens: asNumber(u.inputTokens ?? u.input_tokens ?? u.input),
    outputTokens: asNumber(u.outputTokens ?? u.output_tokens ?? u.output),
    cachedTokens: asNumber(u.cacheReadTokens ?? u.cachedInputTokens ?? u.cacheRead ?? u.cached_input_tokens),
  };
}

function readErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  const rec = asRecord(error);
  return rec ? asString(rec.message) : error == null ? "" : String(error);
}

/**
 * Parse one documented Command Code NDJSON line into transcript entries.
 *
 * Outer frames: `{"type":"event","event":{...AgentEvent...}}` and one
 * always-last `{"type":"result",...}`. Unknown nested event types are ignored
 * (forward-compatible). Non-JSON lines render as raw stdout.
 */
export function parseCommandCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const frameType = asString(parsed.type);

  if (frameType === "result") {
    const subtype = asString(parsed.subtype);
    const usage = readUsageNumbers(parsed.usage);
    const isError = subtype === "error" || subtype === "max_turns";
    const errors = subtype === "error" ? [readErrorText(parsed.error)].filter((e) => e.length > 0) : [];
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.finalText),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: 0,
        subtype,
        isError,
        errors,
      },
    ];
  }

  if (frameType !== "event") {
    return [{ kind: "stdout", ts, text: line }];
  }

  const event = asRecord(parsed.event);
  if (!event) return [];

  const eventType = asString(event.type);

  if (eventType === "run_start") {
    const sessionId = asString(event.sessionId);
    return [{ kind: "init", ts, model: asString(event.model), sessionId }];
  }

  if (eventType === "text_delta") {
    const delta = asString(event.delta);
    if (!delta) return [];
    return [{ kind: "assistant", ts, text: delta, delta: true }];
  }

  if (eventType === "message_end") {
    const text = asString(event.content);
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (eventType === "tool_queued" || eventType === "tool_running") {
    const toolName = asString(event.toolName);
    if (!toolName) return [];
    if (eventType === "tool_queued") {
      return [{ kind: "tool_call", ts, name: toolName, input: event.input, toolUseId: asString(event.toolCallId) || undefined }];
    }
    return [{ kind: "system", ts, text: `tool: ${toolName}` }];
  }

  if (eventType === "tool_completed" || eventType === "tool_errored") {
    const payload = eventType === "tool_completed" ? event.result : event.error;
    const content = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: asString(event.toolCallId, "unknown"),
        toolName: asString(event.toolName),
        content,
        isError: eventType === "tool_errored",
      },
    ];
  }

  // Unknown nested AgentEvent type: forward-compatible, ignored.
  return [];
}
