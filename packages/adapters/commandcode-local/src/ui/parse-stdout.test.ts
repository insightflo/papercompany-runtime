import { describe, expect, it } from "vitest";
import { parseCommandCodeStdoutLine } from "./parse-stdout.js";

const ts = "2026-08-02T00:00:00Z";

function event(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "event", event: { type, ...extra } });
}
function result(extra: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", ...extra });
}

describe("parseCommandCodeStdoutLine", () => {
  it("renders a result entry for a success result", () => {
    const entries = parseCommandCodeStdoutLine(
      result({ subtype: "success", sessionId: "s", usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 1 }, durationMs: 9, finalText: "hello operator" }),
      ts,
    );
    expect(entries).toMatchObject([
      { kind: "result", ts, text: "hello operator", inputTokens: 5, outputTokens: 4, cachedTokens: 1, subtype: "success", isError: false },
    ]);
  });

  it("renders an error result entry with the error text", () => {
    const entries = parseCommandCodeStdoutLine(
      result({ subtype: "error", finalText: "", usage: { inputTokens: 1, outputTokens: 0 }, durationMs: 1, error: "auth required" }),
      ts,
    );
    expect(entries.some((e) => e.kind === "result" && e.isError && e.errors.includes("auth required"))).toBe(true);
  });

  it("renders an init entry for run_start", () => {
    const entries = parseCommandCodeStdoutLine(event("run_start", { sessionId: "cmd-sess-1" }), ts);
    expect(entries).toEqual([{ kind: "init", ts, model: "", sessionId: "cmd-sess-1" }]);
  });

  it("renders an assistant delta for text_delta", () => {
    const entries = parseCommandCodeStdoutLine(event("text_delta", { delta: "abc" }), ts);
    expect(entries).toEqual([{ kind: "assistant", ts, text: "abc", delta: true }]);
  });

  it("renders a tool_call for tool_queued", () => {
    const entries = parseCommandCodeStdoutLine(
      event("tool_queued", { toolCallId: "tu-1", toolName: "shell_command", input: { command: "ls" } }),
      ts,
    );
    expect(entries.some((e) => e.kind === "tool_call" && e.name === "shell_command")).toBe(true);
  });

  it("renders a tool_result for tool_completed", () => {
    const entries = parseCommandCodeStdoutLine(
      event("tool_completed", { toolCallId: "tu-1", toolName: "shell_command", result: "file-a" }),
      ts,
    );
    expect(entries.some((e) => e.kind === "tool_result" && e.toolUseId === "tu-1" && e.isError === false)).toBe(true);
  });

  it("renders an errored tool_result for tool_errored", () => {
    const entries = parseCommandCodeStdoutLine(event("tool_errored", { toolCallId: "tu-2", error: "boom" }), ts);
    expect(entries.some((e) => e.kind === "tool_result" && e.isError)).toBe(true);
  });

  it("ignores unknown nested event types", () => {
    expect(parseCommandCodeStdoutLine(event("some_future_event", { x: 1 }), ts)).toEqual([]);
  });

  it("falls back to a stdout entry for non-JSON lines", () => {
    expect(parseCommandCodeStdoutLine("not json at all", ts)).toEqual([{ kind: "stdout", ts, text: "not json at all" }]);
  });
});
