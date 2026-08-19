import { describe, expect, it } from "vitest";

import { extractRunEndRecovery, extractRunTailRecovery } from "./parse.js";

function eventFrame(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "event", event });
}

const COMPLETE_RUN_END = eventFrame({
  type: "run_end",
  result: {
    finalText: "I confirmed the artifact is registered and the issue is done.",
    stopReason: "end_turn",
    turnCount: 3,
    usage: { inputTokens: 94307, outputTokens: 153, cacheReadTokens: 86987, cacheWriteTokens: 7317 },
    nextState: { sessionId: "sess-1", messages: [] },
  },
});

const TURN_END = eventFrame({
  type: "turn_end",
  turnNumber: 3,
  hadToolCalls: false,
  usage: { inputTokens: 94307, outputTokens: 153, cacheReadTokens: 86987, cacheWriteTokens: 7317 },
});

describe("extractRunEndRecovery (result-line missing → run_end fallback authority)", () => {
  it("recovers from a complete run_end frame when the result line never arrived", () => {
    // A1 실측 패턴: 대형 run_end 출력 중 스트림 종료 → result 줄 부재.
    const stdout = [TURN_END, COMPLETE_RUN_END].join("\n") + "\n";
    const recovery = extractRunEndRecovery(stdout);
    expect(recovery.recovered).toBe(true);
    expect(recovery.finalMessage).toContain("artifact is registered");
    expect(recovery.stopReason).toBe("end_turn");
    expect(recovery.usage).toEqual({ inputTokens: 94307, outputTokens: 153, cachedInputTokens: 86987 });
  });

  it("does NOT recover from a truncated run_end frame (fail-closed stays)", () => {
    const truncated = COMPLETE_RUN_END.slice(0, COMPLETE_RUN_END.length - 80);
    const stdout = [TURN_END, truncated].join("\n") + "\n";
    expect(extractRunEndRecovery(stdout).recovered).toBe(false);
  });

  it("does NOT recover when run_end lacks finalText or usage", () => {
    const noText = eventFrame({ type: "run_end", result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
    const noUsage = eventFrame({ type: "run_end", result: { finalText: "done", stopReason: "end_turn" } });
    expect(extractRunEndRecovery(noText + "\n").recovered).toBe(false);
    expect(extractRunEndRecovery(noUsage + "\n").recovered).toBe(false);
  });

  it("does not consider earlier events when the only run_end is truncated", () => {
    const truncated = COMPLETE_RUN_END.replace("finalText", "finalTex"); // broken key mid-JSON
    const stdout = [TURN_END, truncated].join("\n") + "\n";
    expect(extractRunEndRecovery(stdout).recovered).toBe(false);
  });

  it("returns empty on empty stdout", () => {
    expect(extractRunEndRecovery("").recovered).toBe(false);
  });
});

describe("extractRunTailRecovery (truncated run_end → turn-tail fallback)", () => {
  const finalMessageEnd = JSON.stringify({
    type: "event",
    event: { type: "message_end", content: [{ type: "text", text: "Work finished and the artifact was registered." }] },
  });
  const toolMessageEnd = JSON.stringify({
    type: "event",
    event: { type: "message_end", content: [{ type: "text", text: "Let me check the file." }, { type: "tool_use", id: "t1" }] },
  });
  const turnEnd = (hadToolCalls: boolean) => JSON.stringify({
    type: "event",
    event: { type: "turn_end", turnNumber: 3, hadToolCalls, usage: { inputTokens: 94307, outputTokens: 153, cacheReadTokens: 86987, cacheWriteTokens: 7317 } },
  });
  const truncatedRunEnd = COMPLETE_RUN_END.slice(0, COMPLETE_RUN_END.length - 80);

  it("recovers from the final text-only message_end + turn_end(hadToolCalls=false) when run_end is truncated", () => {
    // A1 실측 10건 형태: [message_end(text-only)] [turn_end] [run_end 잘림] — result 줄 없음.
    const stdout = [toolMessageEnd, turnEnd(true), finalMessageEnd, turnEnd(false), truncatedRunEnd].join("\n") + "\n";
    const recovery = extractRunTailRecovery(stdout);
    expect(recovery.recovered).toBe(true);
    expect(recovery.finalMessage).toContain("artifact was registered");
    expect(recovery.stopReason).toBe("end_turn");
    expect(recovery.usage?.inputTokens).toBe(94307);
  });

  it("does not recover when the last turn_end still had tool calls", () => {
    const stdout = [toolMessageEnd, turnEnd(true), truncatedRunEnd].join("\n") + "\n";
    expect(extractRunTailRecovery(stdout).recovered).toBe(false);
  });

  it("does not recover when turn_end or the final message_end is missing", () => {
    expect(extractRunTailRecovery(finalMessageEnd + "\n").recovered).toBe(false);
    expect(extractRunTailRecovery(turnEnd(false) + "\n").recovered).toBe(false);
  });
});
