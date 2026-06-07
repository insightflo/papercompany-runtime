import { describe, expect, it } from "vitest";

import {
  buildHermesChatArgs,
  formatHermesTimeoutLabel,
} from "../adapters/hermes-local-execute.js";

describe("hermes local execution config", () => {
  it("streams Hermes output to Paperclip by default", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "gpt-5.5",
      provider: "openai-codex",
    });

    expect(args).toEqual([
      "chat",
      "-q",
      "Do the work",
      "-m",
      "gpt-5.5",
      "--provider",
      "openai-codex",
      "-v",
    ]);
    expect(args).not.toContain("-Q");
  });

  it("passes Xiaomi/MiMo provider through to Hermes CLI", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "mimo-v2.5-pro",
      provider: "xiaomi",
    });

    expect(args).toEqual(
      expect.arrayContaining(["-m", "mimo-v2.5-pro", "--provider", "xiaomi"]),
    );
  });

  it("keeps quiet mode available as an explicit opt-in", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "gpt-5.5",
      quiet: true,
      verbose: true,
    });

    expect(args).toContain("-Q");
    expect(args).not.toContain("-v");
  });

  it("preserves resume and caller-provided extra args", () => {
    const args = buildHermesChatArgs({
      prompt: "Continue",
      model: "gpt-5.5",
      persistSession: true,
      prevSessionId: "session-123",
      extraArgs: ["--max-turns", "40"],
    });

    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args.slice(-2)).toEqual(["--max-turns", "40"]);
  });

  it("shows disabled idle timeout explicitly in run logs", () => {
    expect(
      formatHermesTimeoutLabel({ timeoutSec: 240, idleTimeoutSec: 0 }),
    ).toBe("timeout=240s, idleTimeout=disabled");
    expect(
      formatHermesTimeoutLabel({ timeoutSec: 240, idleTimeoutSec: 75 }),
    ).toBe("timeout=240s, idleTimeout=75s");
  });
});
