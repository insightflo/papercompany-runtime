import { afterEach, describe, expect, it } from "vitest";
import {
  parseCommandCodeModelsOutput,
  listCommandCodeModels,
  discoverCommandCodeModels,
  resetCommandCodeModelsCacheForTests,
} from "./models.js";

const SAMPLE_MODELS_OUTPUT = `Available models  ·  50 models

Open Source

deepseek/deepseek-v4-pro             hybrid-attention long-context reasoning
moonshotai/kimi-k2.5                 multimodal frontend coding

Anthropic

claude-sonnet-5                      best combo of speed & intelligence (recommended)

Pass the full id, or just the short name after the last "/":
cmd --model moonshotai/kimi-k2.5
Docs:  https://commandcode.ai/docs/reference/cli/models
`;

describe("parseCommandCodeModelsOutput", () => {
  it("extracts model ids and skips headers, footers, and prose", () => {
    const models = parseCommandCodeModelsOutput(SAMPLE_MODELS_OUTPUT);
    expect(models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k2.5",
      "claude-sonnet-5",
    ]);
  });

  it("uses the description as the label and falls back to the id", () => {
    const models = parseCommandCodeModelsOutput(SAMPLE_MODELS_OUTPUT);
    const kimi = models.find((m) => m.id === "moonshotai/kimi-k2.5");
    expect(kimi?.label).toBe("multimodal frontend coding");
    const noDesc = parseCommandCodeModelsOutput("foo/bar\n");
    expect(noDesc[0]?.label).toBe("foo/bar");
  });

  it("returns an empty list for empty output", () => {
    expect(parseCommandCodeModelsOutput("")).toEqual([]);
  });
});

describe("commandcode models discovery", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_COMMANDCODE_COMMAND;
    resetCommandCodeModelsCacheForTests();
  });

  it("returns an empty list from listCommandCodeModels when the command is missing", async () => {
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = "__paperclip_missing_cmd_command__";
    await expect(listCommandCodeModels()).resolves.toEqual([]);
  });

  it("rejects from discoverCommandCodeModels when the command is missing", async () => {
    process.env.PAPERCLIP_COMMANDCODE_COMMAND = "__paperclip_missing_cmd_command__";
    await expect(discoverCommandCodeModels()).rejects.toThrow();
  });
});
