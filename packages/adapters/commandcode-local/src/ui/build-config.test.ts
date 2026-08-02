import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCommandCodeLocalConfig } from "./build-config.js";

function baseValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "commandcode_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: true,
    intervalSec: 60,
    ...overrides,
  };
}

describe("buildCommandCodeLocalConfig", () => {
  it("parses the comma-separated extraArgs UI string into a flag array", () => {
    const ac = buildCommandCodeLocalConfig(baseValues({ extraArgs: "--verbose, --foo=bar" }));
    expect(ac.extraArgs).toEqual(["--verbose", "--foo=bar"]);
  });

  it("trims and drops empty segments", () => {
    const ac = buildCommandCodeLocalConfig(baseValues({ extraArgs: "  --x , ,--y  " }));
    expect(ac.extraArgs).toEqual(["--x", "--y"]);
  });

  it("omits extraArgs when the UI string is empty", () => {
    const ac = buildCommandCodeLocalConfig(baseValues({ extraArgs: "" }));
    expect(ac).not.toHaveProperty("extraArgs");
  });

  it("does not pass through the legacy args field", () => {
    const ac = buildCommandCodeLocalConfig(baseValues({ args: "--legacy" }));
    expect(ac).not.toHaveProperty("args");
  });
});
