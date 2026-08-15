import type { ServerAdapterModule } from "@paperclipai/adapter-utils";

export const RETIRED_ACPX_MESSAGE =
  'The acpx_local adapter has been retired. Migrate existing agents to claude_local or codex_local with adapterConfig.engine="acp".';

export const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  async execute(ctx) {
    await ctx.onLog("stderr", `${RETIRED_ACPX_MESSAGE}\n`);
    await ctx.onMeta?.({
      adapterType: "acpx_local",
      command: "acpx_local-retired",
      commandNotes: [RETIRED_ACPX_MESSAGE],
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: RETIRED_ACPX_MESSAGE,
      errorCode: "acpx_local_retired",
      provider: "acpx",
      summary: RETIRED_ACPX_MESSAGE,
    };
  },
  async testEnvironment() {
    return {
      adapterType: "acpx_local",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: "acpx_local_retired",
          level: "error",
          message: RETIRED_ACPX_MESSAGE,
          hint: "Use claude_local or codex_local with adapterConfig.engine=acp.",
        },
      ],
    };
  },
  models: [],
  supportsLocalAgentJwt: false,
  requiresMaterializedRuntimeSkills: false,
  getConfigSchema: () => ({ fields: [] }),
  agentConfigurationDoc: `# acpx_local retired\n\n${RETIRED_ACPX_MESSAGE}`,
};
