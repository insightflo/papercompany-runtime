import { describe, expect, it } from "vitest";
import { parseCommandCodeJsonl, isCommandCodeUnknownSessionError } from "./parse.js";

function event(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "event", event: { type, ...extra } });
}

function result(extra: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", ...extra });
}

describe("parseCommandCodeJsonl - result contract", () => {
  it("parses a success result (subtype, finalText, sessionId, usage)", () => {
    const stdout = [
      result({
        subtype: "success",
        sessionId: "cmd-sess-1",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 1 },
        durationMs: 8421,
        finalText: "hello there",
      }),
    ].join("\n");

    const parsed = parseCommandCodeJsonl(stdout);
    expect(parsed.subtype).toBe("success");
    expect(parsed.finalMessage).toBe("hello there");
    expect(parsed.sessionId).toBe("cmd-sess-1");
    expect(parsed.usage.inputTokens).toBe(12);
    expect(parsed.usage.outputTokens).toBe(8);
    expect(parsed.usage.cachedInputTokens).toBe(3); // cacheReadTokens -> cachedInputTokens
    expect(parsed.costUsd).toBeNull();
  });

  it("maps result subtype error with a string error", () => {
    const parsed = parseCommandCodeJsonl(
      result({ subtype: "error", finalText: "", usage: { inputTokens: 1, outputTokens: 0 }, durationMs: 5, error: "auth required" }),
    );
    expect(parsed.subtype).toBe("error");
    expect(parsed.errors).toContain("auth required");
    expect(parsed.finalMessage).toBeNull();
  });

  it("keeps an object/message error fallback only defensively", () => {
    const parsed = parseCommandCodeJsonl(
      result({ subtype: "error", finalText: "", usage: { inputTokens: 1, outputTokens: 0 }, durationMs: 5, error: { message: "boom" } }),
    );
    expect(parsed.errors).toContain("boom");
  });

  it("maps result subtype max_turns", () => {
    const parsed = parseCommandCodeJsonl(
      result({ subtype: "max_turns", sessionId: "s", usage: { inputTokens: 9, outputTokens: 7 }, durationMs: 5, finalText: "partial" }),
    );
    expect(parsed.subtype).toBe("max_turns");
    expect(parsed.finalMessage).toBe("partial");
  });

  it("treats result.usage as authoritative and does not double-count event usage", () => {
    const stdout = [
      event("model_request_end", { model: "x", usage: { inputTokens: 100, outputTokens: 50 } }),
      event("model_request_end", { model: "x", usage: { inputTokens: 30, outputTokens: 20, cacheReadTokens: 5 } }),
      result({
        subtype: "success",
        sessionId: "s",
        usage: { inputTokens: 250, outputTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 2 },
        durationMs: 1,
        finalText: "done",
      }),
    ].join("\n");

    const parsed = parseCommandCodeJsonl(stdout);
    // Final total exactly — NOT accumulated on top of event usage.
    expect(parsed.usage.inputTokens).toBe(250);
    expect(parsed.usage.outputTokens).toBe(120);
    expect(parsed.usage.cachedInputTokens).toBe(40);
  });

  it("falls back to provisional model_request_end usage only when no result line arrives", () => {
    const stdout = [
      event("model_request_end", { model: "x", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 } }),
      event("model_request_end", { model: "x", usage: { inputTokens: 30, outputTokens: 20 } }),
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stdout);
    expect(parsed.subtype).toBeNull();
    expect(parsed.usage.inputTokens).toBe(130);
    expect(parsed.usage.outputTokens).toBe(70);
    expect(parsed.usage.cachedInputTokens).toBe(10);
  });
});

describe("parseCommandCodeJsonl - nested AgentEvents", () => {
  it("captures sessionId from run_start (defensive; result is authoritative)", () => {
    const parsed = parseCommandCodeJsonl([event("run_start", { sessionId: "early-id" })].join("\n"));
    expect(parsed.sessionId).toBe("early-id");
  });

  it("parses tool_queued / tool_completed", () => {
    const stdout = [
      event("tool_queued", { toolCallId: "tu-1", toolName: "shell_command", input: { command: "ls -la" } }),
      event("tool_completed", { toolCallId: "tu-1", result: "file-a\nfile-b" }),
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("shell_command");
    expect(parsed.toolCalls[0].args).toEqual({ command: "ls -la" });
    expect(parsed.toolCalls[0].result).toBe("file-a\nfile-b");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("parses tool_errored as an errored tool call", () => {
    const stdout = [
      event("tool_queued", { toolCallId: "tu-2", toolName: "read_file", input: {} }),
      event("tool_errored", { toolCallId: "tu-2", error: "missing" }),
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stdout);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("missing");
  });

  it("ignores unknown nested event types and non-JSON lines", () => {
    const stdout = [
      "plain prose, not an event",
      event("some_future_event", { foo: "bar" }),
      result({ subtype: "success", finalText: "ok", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }),
    ].join("\n");
    const parsed = parseCommandCodeJsonl(stdout);
    expect(parsed.subtype).toBe("success");
    expect(parsed.finalMessage).toBe("ok");
    expect(parsed.toolCalls).toEqual([]);
  });
});

describe("isCommandCodeUnknownSessionError", () => {
  it("detects unknown/stale session errors", () => {
    expect(isCommandCodeUnknownSessionError("session not found: s_1", "")).toBe(true);
    expect(isCommandCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isCommandCodeUnknownSessionError("", "could not resume session")).toBe(true);
    expect(isCommandCodeUnknownSessionError("all good", "no errors")).toBe(false);
  });
});
