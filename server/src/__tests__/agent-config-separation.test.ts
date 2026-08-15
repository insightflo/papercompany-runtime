import { describe, expect, it } from "vitest";
import {
  AGENT_LEVEL_CONFIG_KEYS,
  ENGINE_ENV_KEYS,
  mergeAgentConfig,
  splitAgentLevelKeys,
} from "../services/agents.js";

describe("agent config separation helpers", () => {
  describe("mergeAgentConfig", () => {
    it("merges adapterConfig and agentConfig with agentConfig priority", () => {
      const merged = mergeAgentConfig({
        adapterConfig: { cwd: "/old", model: "claude-opus-4-6", env: { KEY: "v" } },
        agentConfig: { cwd: "/new", instructionsFilePath: "/tmp/AGENTS.md" },
      });
      expect(merged).toEqual({
        cwd: "/new",
        model: "claude-opus-4-6",
        env: { KEY: "v" },
        instructionsFilePath: "/tmp/AGENTS.md",
      });
    });

    it("returns engine keys when agentConfig is missing", () => {
      const merged = mergeAgentConfig({ adapterConfig: { model: "gpt" } });
      expect(merged).toEqual({ model: "gpt" });
    });

    it("is null/array-safe", () => {
      expect(mergeAgentConfig({ adapterConfig: null, agentConfig: null })).toEqual({});
      expect(mergeAgentConfig({ adapterConfig: ["a"], agentConfig: ["b"] })).toEqual({});
      expect(mergeAgentConfig({ adapterConfig: undefined, agentConfig: { cwd: "/x" } })).toEqual({ cwd: "/x" });
    });

    it("merges env at the env-key level with the agent side winning", () => {
      const merged = mergeAgentConfig({
        adapterConfig: { model: "gpt", env: { HOME: "/engine-home", SHARED: "engine", ENGINE_ONLY: "e" } },
        agentConfig: { env: { SHARED: "agent", AGENT_ONLY: "a" } },
      });
      expect(merged).toEqual({
        model: "gpt",
        env: { HOME: "/engine-home", SHARED: "agent", ENGINE_ONLY: "e", AGENT_ONLY: "a" },
      });
    });

    it("omits env when neither side carries env", () => {
      const merged = mergeAgentConfig({
        adapterConfig: { model: "gpt" },
        agentConfig: { cwd: "/work" },
      });
      expect(merged).toEqual({ model: "gpt", cwd: "/work" });
      expect("env" in merged).toBe(false);
    });

    it("ignores non-object env values on either side", () => {
      const merged = mergeAgentConfig({
        adapterConfig: { env: "not-an-object" },
        agentConfig: { env: { KEY: "v" } },
      });
      expect(merged.env).toEqual({ KEY: "v" });

      const merged2 = mergeAgentConfig({
        adapterConfig: { env: { HOME: "/h" } },
        agentConfig: { env: ["array"] },
      });
      expect(merged2.env).toEqual({ HOME: "/h" });
    });
  });

  describe("splitAgentLevelKeys", () => {
    it("routes the 9 agent-level keys into agentConfig and leaves engine keys in adapterConfig", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({
        cwd: "/work",
        instructionsFilePath: "/tmp/AGENTS.md",
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/instructions",
        instructionsEntryFile: "AGENTS.md",
        promptTemplate: "You are an agent.",
        bootstrapPromptTemplate: "Bootstrap.",
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
        agentsMdPath: "/tmp/agents.md",
        model: "claude-opus-4-6",
        command: "/usr/local/bin/claude",
        env: { KEY: "v" },
        maxTurnsPerRun: 10,
      });

      expect(adapterConfig).toEqual({
        model: "claude-opus-4-6",
        command: "/usr/local/bin/claude",
        maxTurnsPerRun: 10,
      });
      expect(agentConfig).toEqual({
        cwd: "/work",
        instructionsFilePath: "/tmp/AGENTS.md",
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/instructions",
        instructionsEntryFile: "AGENTS.md",
        promptTemplate: "You are an agent.",
        bootstrapPromptTemplate: "Bootstrap.",
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
        agentsMdPath: "/tmp/agents.md",
        env: { KEY: "v" },
      });
    });

    it("partitions env key-wise: engine env stays, intent env moves", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({
        model: "gpt",
        env: {
          HOME: "/home/pi",
          CODEX_HOME: "/home/codex",
          HERMES_HOME: "/home/hermes",
          PATH: "/usr/bin",
          PAPERCLIP_API_URL: "https://api.example",
          ANTHROPIC_API_KEY: "sk-abc",
        },
      });
      expect(adapterConfig).toEqual({
        model: "gpt",
        env: { HOME: "/home/pi", CODEX_HOME: "/home/codex", HERMES_HOME: "/home/hermes", PATH: "/usr/bin" },
      });
      expect(agentConfig).toEqual({
        env: { PAPERCLIP_API_URL: "https://api.example", ANTHROPIC_API_KEY: "sk-abc" },
      });
    });

    it("omits an empty env side", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({
        model: "gpt",
        env: { PAPERCLIP_API_URL: "https://api.example" },
      });
      expect(adapterConfig).toEqual({ model: "gpt" });
      expect(agentConfig).toEqual({ env: { PAPERCLIP_API_URL: "https://api.example" } });

      const engineOnly = splitAgentLevelKeys({ model: "gpt", env: { CODEX_HOME: "/c" } });
      expect(engineOnly.adapterConfig).toEqual({ model: "gpt", env: { CODEX_HOME: "/c" } });
      expect(engineOnly.agentConfig).toEqual({});
    });

    it("produces no env on either side when input has no env key", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({ model: "gpt", cwd: "/work" });
      expect(adapterConfig).toEqual({ model: "gpt" });
      expect(agentConfig).toEqual({ cwd: "/work" });
      expect("env" in adapterConfig).toBe(false);
      expect("env" in agentConfig).toBe(false);
    });

    it("treats a non-object env as an engine-level value", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({ env: "raw" });
      expect(adapterConfig).toEqual({ env: "raw" });
      expect(agentConfig).toEqual({});
    });

    it("omits absent agent keys and returns empty objects for non-record input", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({ model: "gpt" });
      expect(adapterConfig).toEqual({ model: "gpt" });
      expect(agentConfig).toEqual({});

      expect(splitAgentLevelKeys(null)).toEqual({ adapterConfig: {}, agentConfig: {} });
      expect(splitAgentLevelKeys(["a"])).toEqual({ adapterConfig: {}, agentConfig: {} });
    });
  });

  it("AGENT_LEVEL_CONFIG_KEYS is the ownership truth (9 keys, env not included)", () => {
    expect(AGENT_LEVEL_CONFIG_KEYS).toEqual([
      "cwd",
      "instructionsFilePath",
      "instructionsBundleMode",
      "instructionsRootPath",
      "instructionsEntryFile",
      "promptTemplate",
      "bootstrapPromptTemplate",
      "paperclipSkillSync",
      "agentsMdPath",
    ]);
    expect(AGENT_LEVEL_CONFIG_KEYS).not.toContain("env");
  });

  it("ENGINE_ENV_KEYS covers the engine-routing env keys", () => {
    expect(ENGINE_ENV_KEYS).toEqual(["HOME", "CODEX_HOME", "HERMES_HOME", "PATH"]);
  });
});
