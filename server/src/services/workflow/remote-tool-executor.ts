import type { Db } from "@paperclipai/db";
import { createCompanyWorkProductStorageService } from "../company-work-product-storage.js";
import { secretService } from "../secrets.js";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import {
  mirrorWorkflowArtifactToCompanyStorage,
  type WorkflowArtifactMirrorDeps,
} from "./artifact-mirror.js";
import { executeHttpWorkflowTool } from "./http-tool-adapter.js";
import { executeMcpWorkflowTool } from "./mcp-tool-adapter.js";
import { resolveWorkflowRunStepOutputDir } from "./remote-tool-context.js";
import { isPathInsideOrEqual } from "../work-products/output-paths.js";

export type CoreWorkflowToolRemoteDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
  artifactMirrorDeps?: Omit<WorkflowArtifactMirrorDeps, "resolveSecretValue">;
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function artifactPathFromResult(
  adapterConfig: unknown,
  result: CoreWorkflowToolExecutionResult,
): string | null {
  const response = readObject(readObject(adapterConfig).response);
  const field = typeof response.artifactPathResultField === "string"
    ? response.artifactPathResultField.trim()
    : "";
  const artifactPath = field ? readObject(result.body.data)[field] : null;
  return typeof artifactPath === "string" && artifactPath.trim() ? artifactPath.trim() : null;
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

  const result = input.adapterType === "http"
    ? executeHttpWorkflowTool(adapterInput, deps)
    : executeMcpWorkflowTool(adapterInput, deps);
  const adapterResult = await result;
  const artifactPath = adapterResult.status === 200 && stepOutputDir
    ? artifactPathFromResult(input.adapterConfig, adapterResult)
    : null;
  if (!artifactPath || !stepOutputDir) return adapterResult;
  if (!isPathInsideOrEqual(artifactPath, stepOutputDir)) {
    return {
      status: 500,
      body: {
        tool: input.toolName,
        source: "core",
        error: `Workflow tool "${input.toolName}" returned an artifact outside its assigned output directory`,
      },
    };
  }

  try {
    const storage = await createCompanyWorkProductStorageService(input.db).get(input.companyId);
    await mirrorWorkflowArtifactToCompanyStorage(
      storage,
      {
        companyId: input.companyId,
        workflowRunId: input.workflowRunId,
        stepId: input.stepId,
        stepOutputDir,
        artifactPath,
      },
      {
        resolveSecretValue,
        ...(input.remoteDeps?.artifactMirrorDeps ?? {}),
      },
    );
  } catch {
    return {
      status: 500,
      body: {
        tool: input.toolName,
        source: "core",
        error: `Workflow tool "${input.toolName}" could not mirror the response artifact to configured work-product storage`,
      },
    };
  }

  return { ...adapterResult, artifactPath };
}
