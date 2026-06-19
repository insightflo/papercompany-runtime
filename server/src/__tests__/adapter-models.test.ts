import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetClaudeModelsCacheForTests } from "../adapters/claude-models.js";
import { resetGeminiModelsCacheForTests } from "../adapters/gemini-models.js";
import { resetHermesModelsCacheForTests } from "../adapters/hermes-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";
import { setLocalCliModelsRunnerForTests } from "../adapters/local-cli-models.js";

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetClaudeModelsCacheForTests();
    resetGeminiModelsCacheForTests();
    resetHermesModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    setLocalCliModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    delete process.env.HERMES_HOME;
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no CLI or OpenAI discovery is available", async () => {
    setLocalCliModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models from Codex CLI before OpenAI discovery", async () => {
    process.env.OPENAI_API_KEY = "***";
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ models: [{ id: "gpt-5.5-codex" }, { id: "gpt-5.3-codex-spark" }] }),
      stderr: "",
      hasError: false,
    }));
    setLocalCliModelsRunnerForTests(runner);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-from-openai" }] }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5.5-codex")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("loads codex models dynamically from OpenAI when CLI discovery fails and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "***";
    setLocalCliModelsRunnerForTests(() => ({
      status: 1,
      stdout: "",
      stderr: "no codex catalog",
      hasError: false,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("loads claude models from Claude CLI and merges fallback options", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ models: [{ id: "claude-sonnet-5-0" }, { id: "claude-opus-4-6" }] }),
      stderr: "",
      hasError: false,
    }));
    setLocalCliModelsRunnerForTests(runner);

    const first = await listAdapterModels("claude_local");
    const second = await listAdapterModels("claude_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "claude-sonnet-5-0")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-4-6")).toBe(true);
  });

  it("loads gemini models from Gemini CLI and merges fallback options", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: gemini-3.0-pro, gemini-2.5-flash",
      stderr: "",
      hasError: false,
    }));
    setLocalCliModelsRunnerForTests(runner);

    const first = await listAdapterModels("gemini_local");
    const second = await listAdapterModels("gemini_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gemini-3.0-pro")).toBe(true);
    expect(first.some((model) => model.id === "gemini-2.5-pro")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");
    expect(models).toEqual([]);
  });

  it("loads hermes models from the provider model cache in provider/model format", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-models-"));
    process.env.HERMES_HOME = home;
    fs.writeFileSync(
      path.join(home, "provider_models_cache.json"),
      JSON.stringify({
        "openai-codex": {
          models: ["gpt-5.4-mini", "gpt-5.4"],
        },
        zai: {
          models: ["glm-5.1"],
        },
      }),
      "utf8",
    );

    try {
      const models = await listAdapterModels("hermes_local");

      expect(models).toContainEqual({
        id: "openai-codex/gpt-5.4-mini",
        label: "openai-codex/gpt-5.4-mini",
      });
      expect(models).toContainEqual({
        id: "zai/glm-5.1",
        label: "zai/glm-5.1",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
