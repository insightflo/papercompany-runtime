import { describe, expect, it } from "vitest";
import { classifyOutcome, resolveErrorMessage } from "./outcome.js";
import type { ParsedCommandCodeOutput } from "./parse.js";

function emptyParsed(overrides: Partial<ParsedCommandCodeOutput> = {}): ParsedCommandCodeOutput {
  return {
    sessionId: null,
    subtype: null,
    finalMessage: null,
    messages: [],
    errors: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    costUsd: null,
    toolCalls: [],
    stopReason: null,
    ...overrides,
  };
}

describe("classifyOutcome", () => {
  it("fails on stopReason permission_denied even when subtype is success", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "success", stopReason: "permission_denied" }), 0);
    expect(outcome.isFailure).toBe(true);
    expect(outcome.kind).toBe("permission_denied");
    expect(outcome.errorCode).toBe("commandcode_permission_denied");
  });

  it("fails on permission_denied before any subtype/exit reasoning", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "error", stopReason: "permission_denied" }), 1);
    expect(outcome.kind).toBe("permission_denied");
  });

  it("treats subtype error as a failure regardless of exit code", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "error", errors: ["boom"] }), 0);
    expect(outcome.kind).toBe("error");
    expect(outcome.isFailure).toBe(true);
  });

  it("treats max_turns as a non-failure outcome with an errorCode", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "max_turns" }), 8);
    expect(outcome.kind).toBe("max_turns");
    expect(outcome.isFailure).toBe(false);
    expect(outcome.errorCode).toBe("commandcode_max_turns");
  });

  it("fails closed when there is no result line", () => {
    const outcome = classifyOutcome(emptyParsed(), 0);
    expect(outcome.kind).toBe("missing_result");
    expect(outcome.isFailure).toBe(true);
    expect(outcome.errorCode).toBe("commandcode_missing_result");
  });
});

describe("resolveErrorMessage", () => {
  it("describes permission_denied with the parsed error when present", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "success", stopReason: "permission_denied", errors: ["tool not permitted"] }), 0);
    const msg = resolveErrorMessage(outcome, { parsedError: "tool not permitted", stderrLine: "", rawExitCode: 0 });
    expect(msg).toContain("tool not permitted");
  });

  it("falls back to a clear generic message for permission_denied", () => {
    const outcome = classifyOutcome(emptyParsed({ subtype: "success", stopReason: "permission_denied" }), 0);
    const msg = resolveErrorMessage(outcome, { parsedError: null, stderrLine: "", rawExitCode: 0 });
    expect(msg).toContain("permission");
  });
});
