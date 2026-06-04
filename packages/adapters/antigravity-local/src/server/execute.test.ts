import { describe, expect, it } from "vitest";
import {
  buildAntigravityArgs,
  extractLatestAntigravityResponse,
  readConversationIdForCwdFromCache,
  resolveAntigravityFailure,
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

  it("adds an adapter-owned diagnostic log file before --print", () => {
    const args = buildAntigravityArgs({
      cwd: "/tmp/work",
      prompt: "diagnose",
      printTimeout: "30s",
      bypassPermissions: false,
      sandbox: false,
      sessionId: null,
      extraArgs: [],
      diagnosticLogFilePath: "/tmp/antigravity.log",
    });

    expect(args).toContain("--log-file");
    expect(args[args.indexOf("--log-file") + 1]).toBe("/tmp/antigravity.log");
    expect(args.indexOf("--log-file")).toBeLessThan(args.indexOf("--print"));
  });

  it("deduplicates user-provided log-file args when adapter-owned diagnostics are enabled", () => {
    const args = buildAntigravityArgs({
      cwd: "/tmp/work",
      prompt: "diagnose",
      printTimeout: "30s",
      bypassPermissions: false,
      sandbox: false,
      sessionId: null,
      extraArgs: ["--model", "auto", "--log-file", "/tmp/user.log", "--flag"],
      diagnosticLogFilePath: "/tmp/adapter.log",
    });

    expect(args).toEqual([
      "--print-timeout",
      "30s",
      "--add-dir",
      "/tmp/work",
      "--model",
      "auto",
      "--flag",
      "--log-file",
      "/tmp/adapter.log",
      "--print",
      "diagnose",
    ]);
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

  it("treats Antigravity print response timeout text as an adapter failure even when the process exits zero", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "Error: timed out waiting for response\n",
        stderr: "",
        latestResponse: "Error: timed out waiting for response",
      }),
    ).toEqual({
      errorMessage: "Error: timed out waiting for response",
      errorCode: "adapter_failed",
    });
  });

  it("treats an empty Antigravity print response as an adapter failure", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        latestResponse: "",
      }),
    ).toEqual({
      errorMessage: "Antigravity CLI exited without producing a response",
      errorCode: "adapter_failed",
    });
  });

  it("promotes quota exhaustion from the Antigravity diagnostic log when print output is empty", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        latestResponse: "",
        diagnosticLog:
          "agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 2h57m51s.",
      }),
    ).toEqual({
      errorMessage:
        "Antigravity provider quota exhausted: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 2h57m51s.",
      errorCode: "provider_quota_exhausted",
    });
  });
});
