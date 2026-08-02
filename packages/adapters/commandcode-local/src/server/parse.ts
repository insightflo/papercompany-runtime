import { asNumber, asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

export type CommandCodeResultSubtype = "success" | "error" | "max_turns";

export interface ParsedCommandCodeOutput {
  sessionId: string | null;
  subtype: CommandCodeResultSubtype | null;
  /** Authoritative final answer from the always-last result line. */
  finalMessage: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  /** Command Code results carry no cost field; always null, never fabricated. */
  costUsd: null;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: string | null;
    isError: boolean;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Read a usage block. Documented Command Code keys are inputTokens /
 * outputTokens / cacheReadTokens / cacheWriteTokens; cacheReadTokens maps to
 * Paperclip cachedInputTokens. Generic aliases are accepted defensively.
 */
function readUsage(raw: unknown): ParsedCommandCodeOutput["usage"] | null {
  const u = asRecord(raw);
  if (!u) return null;
  const inputTokens = asNumber(u.inputTokens ?? u.input_tokens ?? u.input, NaN);
  const outputTokens = asNumber(u.outputTokens ?? u.output_tokens ?? u.output, NaN);
  const cachedInputTokens = asNumber(
    u.cacheReadTokens ?? u.cachedInputTokens ?? u.cacheRead ?? u.cached_input_tokens,
    NaN,
  );
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return {
    inputTokens: finiteOr(inputTokens, 0),
    outputTokens: finiteOr(outputTokens, 0),
    cachedInputTokens: finiteOr(cachedInputTokens, 0),
  };
}

function addUsage(
  base: ParsedCommandCodeOutput["usage"],
  add: ParsedCommandCodeOutput["usage"],
): ParsedCommandCodeOutput["usage"] {
  return {
    inputTokens: base.inputTokens + add.inputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    cachedInputTokens: base.cachedInputTokens + add.cachedInputTokens,
  };
}

function readErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  const rec = asRecord(error);
  if (rec) return asString(rec.message, "");
  return error == null ? "" : String(error);
}

/**
 * Parse the documented Command Code headless NDJSON stream.
 *
 * Outer frames: `{"type":"event","event":{...AgentEvent...}}` and one
 * always-last `{"type":"result","subtype":"success|error|max_turns",...}`.
 * Unknown nested event types are ignored (forward-compatible). The result line
 * is authoritative for usage, finalText, sessionId, and outcome.
 */
export function parseCommandCodeJsonl(stdout: string): ParsedCommandCodeOutput {
  const result: ParsedCommandCodeOutput = {
    sessionId: null,
    subtype: null,
    finalMessage: null,
    messages: [],
    errors: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    costUsd: null,
    toolCalls: [],
  };

  // Provisional usage accumulated from turn/model events; only used if no
  // authoritative result.usage arrives. Never accumulated on top of the total.
  let provisionalUsage: ParsedCommandCodeOutput["usage"] | null = null;
  let resultUsageSeen = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const frame = parseJson(line);
    if (!frame) continue; // non-JSON line: never execution authority
    const frameType = asString(frame.type, "");

    if (frameType === "result") {
      const subtype = asString(frame.subtype, "");
      if (subtype === "success" || subtype === "error" || subtype === "max_turns") {
        result.subtype = subtype;
      }
      const sid = asString(frame.sessionId, "");
      if (sid) result.sessionId = sid;
      const finalText = asString(frame.finalText, "");
      if (finalText) {
        result.finalMessage = finalText;
        result.messages.push(finalText);
      }
      if (subtype === "error") {
        const errMsg = readErrorText(frame.error);
        if (errMsg) result.errors.push(errMsg);
      }
      // Authoritative totals: REPLACE any provisional event usage.
      const usage = readUsage(frame.usage);
      if (usage) {
        result.usage = usage;
        resultUsageSeen = true;
      }
      continue;
    }

    if (frameType !== "event") continue; // unknown outer frame: ignore

    const event = asRecord(frame.event);
    if (!event) continue;
    const eventType = asString(event.type, "");

    if (eventType === "run_start") {
      const sid = asString(event.sessionId, "");
      if (sid) result.sessionId = sid;
      continue;
    }
    if (eventType === "tool_queued") {
      result.toolCalls.push({
        toolCallId: asString(event.toolCallId, ""),
        toolName: asString(event.toolName, ""),
        args: event.input,
        result: null,
        isError: false,
      });
      continue;
    }
    if (eventType === "tool_completed" || eventType === "tool_errored") {
      const id = asString(event.toolCallId, "");
      const existing = result.toolCalls.find((tc) => id && tc.toolCallId === id);
      const payload = eventType === "tool_completed" ? event.result : event.error;
      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
      if (existing) {
        existing.result = text;
        existing.isError = eventType === "tool_errored";
      }
      continue;
    }
    // Provisional per-inference usage; only used if the result line is missing
    // (which fails closed anyway). model_request_end only — turn_end totals
    // overlap it and would double-count.
    if (!resultUsageSeen && eventType === "model_request_end") {
      const usage = readUsage(event.usage);
      if (usage) provisionalUsage = provisionalUsage ? addUsage(provisionalUsage, usage) : usage;
    }
    // Unknown nested AgentEvent types are ignored (forward-compatible).
  }

  if (!resultUsageSeen && provisionalUsage) result.usage = provisionalUsage;
  return result;
}

export function isCommandCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+such\s+(session|conversation)|conversation\s+not\s+found|could\s+not\s+resume|cannot\s+resume|invalid\s+session/i.test(
    haystack,
  );
}
