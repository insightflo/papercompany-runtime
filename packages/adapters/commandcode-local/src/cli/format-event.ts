import pc from "picocolors";

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

/**
 * Pretty-print one documented Command Code NDJSON line for live CLI display.
 * Outer frames are `{"type":"event","event":{...}}` and one always-last
 * `{"type":"result",...}`. Unknown nested event types fall through as raw text.
 */
export function printCommandCodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const frameType = asString(parsed.type);

  if (frameType === "result") {
    const subtype = asString(parsed.subtype);
    const finalText = asString(parsed.finalText);
    if (subtype === "error") {
      const err = asString(parsed.error);
      console.log(pc.red(`result: error${err ? ` — ${err}` : ""}`));
    } else if (subtype === "max_turns") {
      console.log(pc.yellow(`result: max_turns reached${finalText ? "" : " (no partial text)"}`));
    } else {
      console.log(pc.green(`result: success`));
    }
    if (finalText) console.log(pc.green(`assistant: ${finalText}`));
    return;
  }

  if (frameType !== "event") {
    console.log(line);
    return;
  }

  const event = asRecord(parsed.event);
  if (!event) {
    console.log(line);
    return;
  }
  const eventType = asString(event.type);

  if (eventType === "run_start") {
    const sessionId = asString(event.sessionId);
    console.log(pc.blue(`Command Code session started${sessionId ? `: ${sessionId}` : ""}`));
    return;
  }

  if (eventType === "text_delta") {
    const delta = asString(event.delta);
    if (delta) console.log(pc.green(delta));
    return;
  }

  if (eventType === "message_end") {
    const text = asString(event.content);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (eventType === "tool_queued" || eventType === "tool_running") {
    const toolName = asString(event.toolName);
    console.log(pc.yellow(`tool: ${toolName}`));
    if (eventType === "tool_queued" && event.input !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(event.input, null, 2)));
      } catch {
        console.log(pc.gray(String(event.input)));
      }
    }
    return;
  }

  if (eventType === "tool_completed" || eventType === "tool_errored") {
    const payload = eventType === "tool_completed" ? event.result : event.error;
    const content = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    if (content) console.log((eventType === "tool_errored" ? pc.red : pc.gray)(content));
    return;
  }

  // Unknown nested AgentEvent type: forward-compatible, ignore silently.
}
