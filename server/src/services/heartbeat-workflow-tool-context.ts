import type { Db } from "@paperclipai/db";
import { toolService } from "./tools/registry.js";
import { listDefaultWorkflowPluginAgentTools } from "./workflow/plugin-agent-tools.js";

type WorkflowStepToolContext = {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  toolNames: string[];
  toolArgs: unknown;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    adapterType: string;
    instructions?: string | null;
  }>;
};

type ResolvedWorkflowToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  adapterType: string;
  enabled: boolean;
  instructions: string | null;
};

/**
 * toolDefinitions.adapterConfig.instructions를 안전하게 string으로 꺼낸다.
 * adapterConfig는 jsonb object 또는 string-encoded JSON일 수 있고(codex가 daily-tech-scout
 * 수정 중 string→object 변환 이력 있음), instructions는 tool 사용 지시문(예: rawPath 파일을
 * 읽고 evidence.json을 써라). string이면 그대로, 아니면 null.
 */
function readToolInstructions(adapterConfig: unknown): string | null {
  const cfg = typeof adapterConfig === "string"
    ? (() => { try { return JSON.parse(adapterConfig); } catch { return null; } })()
    : adapterConfig;
  if (!cfg || typeof cfg !== "object") return null;
  const value = (cfg as Record<string, unknown>).instructions;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function resolveWorkflowStepToolContext(input: {
  db: Db;
  companyId: string;
  issueId: string | null;
}): Promise<WorkflowStepToolContext | null> {
  if (!input.issueId) return null;

  const { workflowService } = await import("./workflow/engine.js");
  const contract = await workflowService.getStepExecutionContractForIssue(input.db, input.issueId);
  if (!contract || contract.toolNames.length === 0) return null;

  const [coreDefinitions, pluginDefinitions] = await Promise.all([
    toolService.listDefinitions(input.db, {
      companyId: input.companyId,
    }),
    listDefaultWorkflowPluginAgentTools(input.db),
  ]);
  const definitionByName = new Map<string, ResolvedWorkflowToolDefinition>();
  for (const definition of coreDefinitions) {
    definitionByName.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      adapterType: definition.adapterType,
      enabled: definition.enabled !== false,
      instructions: readToolInstructions(definition.adapterConfig),
    });
  }
  for (const definition of pluginDefinitions) {
    definitionByName.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      adapterType: "plugin",
      enabled: true,
      instructions: definition.instructions,
    });
  }
  const missingToolNames = contract.toolNames.filter((toolName) => !definitionByName.has(toolName));
  const disabledToolNames = contract.toolNames.filter((toolName) => definitionByName.get(toolName)?.enabled === false);

  if (missingToolNames.length > 0 || disabledToolNames.length > 0) {
    const details = [
      missingToolNames.length > 0 ? `missing tools: ${missingToolNames.join(", ")}` : null,
      disabledToolNames.length > 0 ? `disabled tools: ${disabledToolNames.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    throw Object.assign(
      new Error(`Workflow step "${contract.stepName}" has an invalid tool contract (${details})`),
      {
        code: "workflow_step_tool_contract_invalid",
      },
    );
  }

  return {
    workflowRunId: contract.workflowRunId,
    workflowId: contract.workflowId,
    stepId: contract.stepId,
    stepName: contract.stepName,
    toolNames: contract.toolNames,
    toolArgs: contract.toolArgs,
    tools: contract.toolNames
      .map((toolName) => definitionByName.get(toolName))
      .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        adapterType: definition.adapterType,
        instructions: definition.instructions,
      })),
  };
}
