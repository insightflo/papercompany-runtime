import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAntigravityLocalConfig } from "./build-config.js";

function values(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "antigravity_local",
    cwd: "/tmp/work",
    instructionsFilePath: "AGENTS.md",
    promptTemplate: "Do work",
    model: "auto",
    thinkingEffort: "high",
    chrome: true,
    dangerouslySkipPermissions: true,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "agy",
    args: "",
    extraArgs: "--log-file, /tmp/agy.log",
    envVars: "PLAIN=value",
    envBindings: {
      SECRET: { type: "secret_ref", secretId: "secret-1", version: "latest" },
    },
    url: "",
    bootstrapPrompt: "bootstrap",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 300,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildAntigravityLocalConfig", () => {
  it("preserves common local-agent options from the shared create form", () => {
    expect(buildAntigravityLocalConfig(values())).toMatchObject({
      cwd: "/tmp/work",
      instructionsFilePath: "AGENTS.md",
      promptTemplate: "Do work",
      bootstrapPromptTemplate: "bootstrap",
      model: "auto",
      effort: "high",
      chrome: true,
      bypassPermissions: true,
      dangerouslySkipPermissions: true,
      sandbox: true,
      command: "agy",
      extraArgs: ["--log-file", "/tmp/agy.log"],
      env: {
        PLAIN: { type: "plain", value: "value" },
        SECRET: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
    });
  });

  it("maps bypass-sandbox to Antigravity sandbox=false without dropping permission preference", () => {
    expect(
      buildAntigravityLocalConfig(values({ dangerouslySkipPermissions: false, dangerouslyBypassSandbox: true })),
    ).toMatchObject({
      bypassPermissions: false,
      dangerouslySkipPermissions: false,
      sandbox: false,
    });
  });
});
