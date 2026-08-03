import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCommandCodeEffortsProbe,
  isRecognizedEffortProbeOutput,
  listCommandCodeModelEfforts,
  discoverCommandCodeModelEfforts,
  resetCommandCodeEffortsCacheForTests,
} from "./efforts.js";

describe("parseCommandCodeEffortsProbe", () => {
  it("extracts the supported effort list from the probe stderr", () => {
    const stderr = `Unknown effort "__paperclip_probe__". Supported: high, max.\n`;
    expect(parseCommandCodeEffortsProbe(stderr, "")).toEqual(["high", "max"]);
  });

  it("extracts a longer effort list in declared order", () => {
    const stderr = `Unknown effort "__paperclip_probe__". Supported: low, medium, high, xhigh, max.`;
    expect(parseCommandCodeEffortsProbe(stderr, "")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns a three-level list for models capped at high", () => {
    const stderr = `Unknown effort "__paperclip_probe__". Supported: low, medium, high.`;
    expect(parseCommandCodeEffortsProbe(stderr, "")).toEqual(["low", "medium", "high"]);
  });

  it("returns an empty list for models with no adjustable reasoning effort", () => {
    const stderr = `Kimi K3 has no adjustable reasoning effort.\n`;
    expect(parseCommandCodeEffortsProbe(stderr, "")).toEqual([]);
  });

  it("returns an empty list for unrelated or empty output", () => {
    expect(parseCommandCodeEffortsProbe("", "")).toEqual([]);
    expect(parseCommandCodeEffortsProbe("some unrelated error", "")).toEqual([]);
  });

  it("checks stderr first, then stdout", () => {
    expect(parseCommandCodeEffortsProbe("Supported: high, max.", "")).toEqual(["high", "max"]);
    expect(parseCommandCodeEffortsProbe("", "Supported: low, medium, high.")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("isRecognizedEffortProbeOutput", () => {
  it("recognizes a Supported list", () => {
    expect(isRecognizedEffortProbeOutput('Supported: high, max.', "")).toBe(true);
  });

  it("recognizes the no-adjustable-effort message", () => {
    expect(isRecognizedEffortProbeOutput("has no adjustable reasoning effort.", "")).toBe(true);
  });

  it("rejects empty and unrelated output", () => {
    expect(isRecognizedEffortProbeOutput("", "")).toBe(false);
    expect(isRecognizedEffortProbeOutput("command not found", "")).toBe(false);
  });
});

describe("commandcode efforts discovery", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_COMMANDCODE_COMMAND;
    resetCommandCodeEffortsCacheForTests();
  });

  it("returns an empty list from listCommandCodeModelEfforts when the command is missing", async () => {
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = "__paperclip_missing_cmd_command__";
    await expect(listCommandCodeModelEfforts("deepseek/deepseek-v4-pro")).resolves.toEqual([]);
  });

  it("rejects from discoverCommandCodeModelEfforts when the command is missing", async () => {
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = "__paperclip_missing_cmd_command__";
    await expect(discoverCommandCodeModelEfforts("deepseek/deepseek-v4-pro")).rejects.toThrow();
  });
});

/**
 * Write a fake `cmd` binary that prints `stderrText` to stderr and exits 1,
 * simulating Command Code's effort-validation probe response.
 */
async function writeFakeCmdProbe(stderrText: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-efforts-"));
  const cmdPath = path.join(dir, "fake-cmd");
  const script = `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(stderrText)});
process.exit(1);
`;
  await fs.writeFile(cmdPath, script, "utf8");
  await fs.chmod(cmdPath, 0o755);
  return cmdPath;
}

describe("commandcode efforts: failure vs legitimate empty list", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_COMMANDCODE_COMMAND;
    resetCommandCodeEffortsCacheForTests();
  });

  it("returns [] (success) for a model with no adjustable reasoning effort", async () => {
    const cmdPath = await writeFakeCmdProbe("Kimi K3 has no adjustable reasoning effort.\n");
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = cmdPath;
    await expect(discoverCommandCodeModelEfforts("moonshotai/kimi-k3")).resolves.toEqual([]);
  });

  it("returns the effort list (success) for a model with supported efforts", async () => {
    const cmdPath = await writeFakeCmdProbe(
      'Unknown effort "__paperclip_probe__". Supported: high, max.\n',
    );
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = cmdPath;
    await expect(discoverCommandCodeModelEfforts("deepseek/deepseek-v4-pro")).resolves.toEqual([
      "high",
      "max",
    ]);
  });

  it("rejects (failure) when the probe output is unrecognized garbage", async () => {
    const cmdPath = await writeFakeCmdProbe("Error: command not found\n");
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = cmdPath;
    await expect(discoverCommandCodeModelEfforts("some/model")).rejects.toThrow();
  });

  it("listCommandCodeModelEfforts swallows the failure and returns [] for unrecognized output", async () => {
    // The swallowing wrapper is kept for callers that do not need the failure
    // signal (e.g. the environment diagnostics). The server route uses the raw
    // cached version so the UI can distinguish the two cases.
    const cmdPath = await writeFakeCmdProbe("Error: command not found\n");
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = cmdPath;
    await expect(listCommandCodeModelEfforts("some/model")).resolves.toEqual([]);
  });
});
