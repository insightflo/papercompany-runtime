import { describe, expect, it } from "vitest";
import { parseStoredLogContent } from "./agent-detail-log-content";

describe("stored workspace logs", () => {
  it("keeps valid chunks, defaults unknown streams, and ignores malformed or empty lines", () => {
    const content = [
      '{"ts":"x","stream":"stderr","chunk":"error"}',
      '{"ts":"y","stream":"weird","chunk":"ok"}',
      "bad",
      '{"chunk":""}',
    ].join("\n");
    expect(parseStoredLogContent(content)).toEqual([
      { ts: "x", stream: "stderr", chunk: "error" },
      { ts: "y", stream: "stdout", chunk: "ok" },
    ]);
  });
});
