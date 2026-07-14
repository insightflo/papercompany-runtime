import type { Db } from "@paperclipai/db";
import { secretService } from "../secrets.js";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import { executeHttpWorkflowTool } from "./http-tool-adapter.js";
import { executeMcpWorkflowTool } from "./mcp-tool-adapter.js";
import { resolveWorkflowRunStepOutputDir } from "./remote-tool-context.js";

export type CoreWorkflowToolRemoteDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function executeRemoteWorkflowTool(input: {
  db: Db;
  companyId: string;
  toolName: string;
  parameters: unknown;
  requestId: string;
  workflowRunId?: string | null;
  stepId?: string | null;
  adapterType: string;
  adapterConfig: unknown;
  remoteDeps?: CoreWorkflowToolRemoteDeps;
}): Promise<CoreWorkflowToolExecutionResult | null> {
  if (input.adapterType !== "http" && input.adapterType !== "mcp") return null;

  const stepOutputDir = await resolveWorkflowRunStepOutputDir(input.db, input);
  const resolveSecretValue = input.remoteDeps?.resolveSecretValue
    ?? secretService(input.db).resolveSecretValue;
  const adapterInput = {
    companyId: input.companyId,
    toolName: input.toolName,
    parameters: input.parameters,
    requestId: input.requestId,
    stepOutputDir,
    adapterConfig: readObject(input.adapterConfig),
  };
  const deps = {
    fetchImpl: input.remoteDeps?.fetchImpl,
    resolveSecretValue,
  };

  return input.adapterType === "http"
    ? executeHttpWorkflowTool(adapterInput, deps)
    : executeMcpWorkflowTool(adapterInput, deps);
}
