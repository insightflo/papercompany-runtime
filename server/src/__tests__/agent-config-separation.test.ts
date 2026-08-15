import { describe, expect, it } from "vitest";
import {
  AGENT_LEVEL_CONFIG_KEYS,
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
        env: { KEY: "v" },
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
      });
    });

    it("omits absent agent keys and returns empty objects for non-record input", () => {
      const { adapterConfig, agentConfig } = splitAgentLevelKeys({ model: "gpt" });
      expect(adapterConfig).toEqual({ model: "gpt" });
      expect(agentConfig).toEqual({});

      expect(splitAgentLevelKeys(null)).toEqual({ adapterConfig: {}, agentConfig: {} });
      expect(splitAgentLevelKeys(["a"])).toEqual({ adapterConfig: {}, agentConfig: {} });
    });
  });

  it("AGENT_LEVEL_CONFIG_KEYS is the ownership truth (9 keys)", () => {
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
  });
});
