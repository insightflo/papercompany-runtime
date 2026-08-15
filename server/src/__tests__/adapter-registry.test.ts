import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import * as registry from "../adapters/registry.js";

const requireServerAdapter = (
  registry as typeof registry & {
    requireServerAdapter?: (type: string) => { type: string };
  }
).requireServerAdapter;

const baseContext: AdapterExecutionContext = {
  runId: "run-acpx",
  agent: {
    id: "agent-acpx",
    companyId: "company-acpx",
    name: "Retired ACPX",
    adapterType: "acpx_local",
    adapterConfig: {},
  },
  runtime: {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  },
  config: {},
  context: {},
  onLog: async () => {},
};

describe("server adapter registry boundaries", () => {
  it("requires an explicitly registered adapter instead of silently selecting process", () => {
    expect(requireServerAdapter).toBeTypeOf("function");
    expect(() => requireServerAdapter?.("unknown_adapter")).toThrow(
      "Unknown adapter type: unknown_adapter",
    );
  });


  it("keeps retired acpx_local rows visible as a fail-closed tombstone", async () => {
    const adapter = registry.findServerAdapter("acpx_local");
    expect(adapter).not.toBeNull();
    expect(adapter?.models).toEqual([]);
    expect(adapter?.supportsLocalAgentJwt).toBe(false);

    const result = await adapter!.execute(baseContext);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_local_retired");
    expect(result.errorMessage).toMatch(/retired/i);

    const environment = await adapter!.testEnvironment({
      companyId: "company-acpx",
      adapterType: "acpx_local",
      config: {},
    });
    expect(environment.status).toBe("fail");
    expect(environment.checks[0]?.code).toBe("acpx_local_retired");
  });

  it("declares pi_local capability and model-profile contracts", () => {
    const adapter = registry.findServerAdapter("pi_local");
    expect(adapter).not.toBeNull();
    expect(adapter?.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter?.requiresMaterializedRuntimeSkills).toBe(true);
    expect(adapter?.modelProfiles).toEqual([]);
  });
});
