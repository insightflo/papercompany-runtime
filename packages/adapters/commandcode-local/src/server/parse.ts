import { asNumber, asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

export type CommandCodeResultSubtype = "success" | "error" | "max_turns";

export interface ParsedCommandCodeOutput {
  sessionId: string | null;
  subtype: CommandCodeResultSubtype | null;
  /** Stop reason from the result line (e.g. "end_turn", "permission_denied"). */
  stopReason: string | null;
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
 * [run_end recovery] result 줄 부재 시 차선 권위로 승격할 수 있는 run_end 프레임.
 *   CLI 1.26.0: 거대한 run_end(nextState.messages 원문) 출력 중 프로세스가 끝나면
 *   always-last result 줄이 아예 출력되지 않는다(2026-08-19 A1 실측: missing_result 실패 10건 전부 동일 패턴).
 *   이때 실행은 실제로 완료됐다(finalText + stopReason + usage 존재). 온전한 run_end 하나만
 *   success 회복 근거로 인정한다 — 잘린 run_end/부분 finalText 는 여전히 fail-closed(규칙 8).
 */
export interface RunEndRecovery {
  readonly recovered: boolean;
  readonly finalMessage: string | null;
  readonly stopReason: string | null;
  readonly sessionId: string | null;
  readonly usage: ParsedCommandCodeOutput["usage"] | null;
}

const EMPTY_RUN_END_RECOVERY: RunEndRecovery = {
  recovered: false, finalMessage: null, stopReason: null, sessionId: null, usage: null,
};

function readAssistantTextFromMessageEnd(event: Record<string, unknown>): string | null {
  // 프레임 형태 관용: {content:[...]} 직속과 {message:{role,content:[...]}} 래핑 모두 수용.
  const message = typeof event.message === "object" && event.message !== null
    ? event.message as Record<string, unknown>
    : event;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  let text: string | null = null;
  for (const block of content) {
    if (typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string") {
      text = (block as { text: string }).text;
    }
  }
  return text !== null && text.trim().length > 0 ? text : null;
}

function messageEndRole(event: Record<string, unknown>): string | null {
  const message = typeof event.message === "object" && event.message !== null
    ? event.message as Record<string, unknown>
    : event;
  return typeof message.role === "string" ? message.role : null;
}

function messageEndHasToolUse(event: Record<string, unknown>): boolean {
  const message = typeof event.message === "object" && event.message !== null
    ? event.message as Record<string, unknown>
    : event;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use");
}

/**
 * [run-tail recovery] result/run_end 모두 없거나 잘렸을 때의 2차 차선 권위.
 *   마지막 턴 종료(turn_end, hadToolCalls=false)와 그 직전 message_end(text 블록 있고
 *   tool_use 블록 없음 = 도구 없이 답변을 마친 최종 발화)가 온전하면 실행 완료의 기계적
 *   증거로 인정한다(2026-08-19 A1 실측 10건 전부 이 형태: 거대 run_end 출력 절단 —
 *   message_end/turn_end 는 생존). 어느 하나라도 없거나 tool_use 가 남아 있으면
 *   회복하지 않는다(규칙 8 fail-closed).
 */
export function extractRunTailRecovery(stdout: string): RunEndRecovery {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let lastTurnEndUsage: ParsedCommandCodeOutput["usage"] | null = null;
  let lastTurnEndHadToolCalls = true;
  let lastAssistantText: string | null = null;
  let turnEndFound = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{"type":"event"')) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // 잘린 줄은 권위 없음 — 계속 역주행
    }
    const event = (frame as { event?: unknown }).event;
    if (typeof event !== "object" || event === null) continue;
    const ev = event as { type?: unknown };
    if (!turnEndFound) {
      if (ev.type === "turn_end") {
        const usage = readUsage((ev as { usage?: unknown }).usage);
        if (usage) {
          lastTurnEndUsage = usage;
          lastTurnEndHadToolCalls = (ev as { hadToolCalls?: unknown }).hadToolCalls === true;
          turnEndFound = true;
        }
      }
      continue;
    }
    // turn_end 이후(스트림상 이전) 첫 온전한 message_end = 그 턴의 최종 발화 후보.
    if (ev.type === "message_end") {
      const text = readAssistantTextFromMessageEnd(ev as unknown as Record<string, unknown>);
      const hasToolUse = messageEndHasToolUse(ev as unknown as Record<string, unknown>);
      if (text && !hasToolUse) {
        lastAssistantText = text;
        break;
      }
      // tool_use 포함 message_end 는 중간 발화 — 더 이전의 최종 발화를 찾는다.
    }
  }
  if (!turnEndFound || !lastTurnEndUsage || !lastAssistantText || lastTurnEndHadToolCalls) {
    return EMPTY_RUN_END_RECOVERY;
  }
  return {
    recovered: true,
    finalMessage: lastAssistantText,
    stopReason: "end_turn",
    sessionId: null,
    usage: lastTurnEndUsage,
  };
}

export function extractRunEndRecovery(stdout: string): RunEndRecovery {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{"type":"event"')) continue;
    // 후미부터 역주행: 첫 번째로 만나는 온전한 run_end 프레임만 후보로 검증한다.
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // 잘린 줄 — 권위 없음
    }
    const event = (frame as { event?: unknown }).event;
    if (typeof event !== "object" || event === null) continue;
    const ev = event as { type?: unknown; result?: unknown };
    if (ev.type !== "run_end") continue;
    const result = ev.result;
    if (typeof result !== "object" || result === null) continue;
    const r = result as { finalText?: unknown; stopReason?: unknown; usage?: unknown; sessionId?: unknown };
    const finalText = typeof r.finalText === "string" ? r.finalText.trim() : "";
    if (finalText.length === 0) continue;
    const usage = readUsage(r.usage);
    if (!usage) continue;
    return {
      recovered: true,
      finalMessage: finalText,
      stopReason: typeof r.stopReason === "string" ? r.stopReason : null,
      sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
      usage,
    };
  }
  return EMPTY_RUN_END_RECOVERY;
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
    stopReason: null,
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
      const stopReason = asString(frame.stopReason, "");
      if (stopReason) result.stopReason = stopReason;
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
