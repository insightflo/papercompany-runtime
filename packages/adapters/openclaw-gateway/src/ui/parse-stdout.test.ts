import { describe, expect, it } from "vitest";
import { parseOpenClawGatewayStdoutLine } from "./parse-stdout.js";

describe("OpenClaw gateway stdout parser", () => {
  it("renders v4 chat deltaText as an assistant delta", () => {
    expect(
      parseOpenClawGatewayStdoutLine(
        '[openclaw-gateway:event] run=run-1 stream=chat data={"state":"delta","deltaText":"hello"}',
        "2026-01-01T00:00:00.000Z",
      ),
    ).toEqual([
      {
        kind: "assistant",
        ts: "2026-01-01T00:00:00.000Z",
        text: "hello",
        delta: true,
      },
    ]);
  });

  it("renders a v4 structured final message and error message", () => {
    expect(
      parseOpenClawGatewayStdoutLine(
        '[openclaw-gateway:event] run=run-1 stream=chat data={"state":"final","message":{"content":[{"type":"text","text":"done"}]}}',
        "ts",
      ),
    ).toEqual([{ kind: "assistant", ts: "ts", text: "done" }]);
    expect(
      parseOpenClawGatewayStdoutLine(
        '[openclaw-gateway:event] run=run-1 stream=chat data={"state":"error","errorMessage":"failed"}',
        "ts",
      ),
    ).toEqual([{ kind: "stderr", ts: "ts", text: "failed" }]);
  });
});
