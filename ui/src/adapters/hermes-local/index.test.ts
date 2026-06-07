import { describe, expect, it, vi } from "vitest";

vi.mock("./config-fields", () => ({
  HermesLocalConfigFields: () => null,
}));

import { hermesLocalUIAdapter } from ".";

describe("hermes local UI adapter", () => {
  const ts = "2026-06-04T00:00:00.000Z";

  it("parses Hermes assistant lines as assistant transcript entries", () => {
    expect(
      hermesLocalUIAdapter.parseStdoutLine("  ┊ 💬 I checked the issue", ts),
    ).toEqual([{ kind: "assistant", ts, text: "I checked the issue" }]);
  });

  it("parses Hermes tool completion lines as paired tool call/result entries", () => {
    const entries = hermesLocalUIAdapter.parseStdoutLine(
      "  [done] ┊ 💻 $         pnpm --filter @paperclipai/ui typecheck  1.2s (1.2s)",
      ts,
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "shell",
      input: { detail: "pnpm --filter @paperclipai/ui typecheck" },
    });
    expect(entries[1]).toMatchObject({
      kind: "tool_result",
      content: "pnpm --filter @paperclipai/ui typecheck  1.2s",
      isError: false,
    });
    expect(
      entries[0].kind === "tool_call" &&
        entries[1].kind === "tool_result" &&
        entries[0].toolUseId,
    ).toBe(
      entries[1].kind === "tool_result" ? entries[1].toolUseId : undefined,
    );
  });

  it("keeps Paperclip/Hermes adapter log lines as system entries", () => {
    expect(
      hermesLocalUIAdapter.parseStdoutLine(
        "[paperclip] No process output for 75s",
        ts,
      ),
    ).toEqual([
      { kind: "system", ts, text: "[paperclip] No process output for 75s" },
    ]);
  });
});
