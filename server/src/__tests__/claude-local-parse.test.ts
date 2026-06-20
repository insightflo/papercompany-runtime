import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";

describe("claude_local stream-json parsing", () => {
  it("synthesizes a best-effort result when a successful stream has assistant text but no result event", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "glm-5.2",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "text",
              text: "REQUEST_CHANGES: corrected artifact is still missing.",
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);

    expect(parsed.resultJson).toMatchObject({
      type: "result",
      subtype: "best_effort_missing_result_event",
      is_error: false,
      result: "REQUEST_CHANGES: corrected artifact is still missing.",
      session_id: "session-1",
    });
    expect(parsed.summary).toBe("REQUEST_CHANGES: corrected artifact is still missing.");
    expect(parsed.model).toBe("glm-5.2");
  });

  it("does not synthesize a result from thinking-only assistant content", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "glm-5.2",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "Internal reasoning should not become the official result.",
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);

    expect(parsed.resultJson).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.sessionId).toBe("session-1");
  });
});
