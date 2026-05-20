import { describe, expect, it } from "vitest";
import {
  buildAntigravityArgs,
  extractLatestAntigravityResponse,
  readConversationIdForCwdFromCache,
} from "./execute.js";

describe("antigravity_local argument builder", () => {
  it("places control flags before --print and always adds the effective cwd", () => {
    const args = buildAntigravityArgs({
      cwd: "/tmp/work",
      prompt: "hello",
      printTimeout: "180s",
      bypassPermissions: true,
      sandbox: false,
      sessionId: null,
      extraArgs: ["--log-file", "/tmp/agy.log"],
    });

    expect(args).toEqual([
      "--print-timeout",
      "180s",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/work",
      "--log-file",
      "/tmp/agy.log",
      "--print",
      "hello",
    ]);
    expect(args.indexOf("--print-timeout")).toBeLessThan(args.indexOf("--print"));
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("--print"));
  });

  it("uses --conversation for saved sessions before --print", () => {
    const args = buildAntigravityArgs({
      cwd: "/tmp/work",
      prompt: "resume",
      printTimeout: "5m",
      bypassPermissions: false,
      sandbox: true,
      sessionId: "conv-123",
      extraArgs: [],
    });

    expect(args).toContain("--sandbox");
    expect(args).toContain("--conversation");
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-123");
    expect(args.indexOf("--conversation")).toBeLessThan(args.indexOf("--print"));
  });
});

describe("antigravity_local output/session helpers", () => {
  it("returns only the latest response block from resumed plain stdout", () => {
    const stdout = [
      "AGY_SMOKE_OK",
      "AGY_SMOKE_OK",
      "AGY_CONVERSATION_RESUME_OK",
    ].join("\n");

    expect(extractLatestAntigravityResponse(stdout)).toBe("AGY_CONVERSATION_RESUME_OK");
  });

  it("preserves multiline latest responses separated by blank lines", () => {
    const stdout = "old answer\n\nnew line 1\nnew line 2\n";
    expect(extractLatestAntigravityResponse(stdout)).toBe("new line 1\nnew line 2");
  });

  it("reads the cwd conversation id from Antigravity's last_conversations cache", async () => {
    const cache = JSON.stringify({
      "/tmp/other": "conv-other",
      "/tmp/work": "conv-work",
    });
    const id = await readConversationIdForCwdFromCache("/tmp/work", async () => cache);
    expect(id).toBe("conv-work");
  });
});
