export const RUN_TOOL_CONTRACT_CONTEXT_KEY = "paperclipRunToolContract" as const;
export const LEGACY_WORKFLOW_TOOL_CONTRACT_CONTEXT_KEY = "paperclipWorkflowStepToolContract" as const;

export type RunToolContractTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  parametersSchema?: Record<string, unknown>;
  adapterType?: string;
  instructions?: string | null;
};

export type PaperclipRunToolContractV1 = {
  version: 1;
  sourceKind: "workflow_step" | "standalone_issue";
  issueId: string;
  workflowRunId?: string | null;
  workflowId?: string | null;
  stepId?: string | null;
  stepName?: string | null;
  toolNames: string[];
  toolArgs?: unknown;
  tools: RunToolContractTool[];
};

export type ParsedRunToolContract = {
  version: 1;
  sourceKind: "workflow_step" | "standalone_issue";
  issueId: string | null;
  workflowRunId?: string | null;
  workflowId?: string | null;
  stepId?: string | null;
  stepName?: string | null;
  toolNames: string[];
  toolArgs?: unknown;
  tools: RunToolContractTool[];
  source: "run" | "legacy";
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(asString);
  return values.every((value): value is string => value !== null) ? values : null;
}

function readTools(value: unknown): RunToolContractTool[] | null {
  if (!Array.isArray(value)) return null;
  const tools: RunToolContractTool[] = [];
  for (const entry of value) {
    const tool = asRecord(entry);
    const name = asString(tool?.name);
    if (!tool || !name) return null;
    tools.push({ ...tool, name } as RunToolContractTool);
  }
  return tools;
}

function parseRunContract(value: unknown): ParsedRunToolContract | null {
  const raw = asRecord(value);
  if (!raw || raw.version !== 1) return null;
  const sourceKind = raw.sourceKind === "workflow_step" || raw.sourceKind === "standalone_issue"
    ? raw.sourceKind
    : null;
  const issueId = asString(raw.issueId);
  const toolNames = readStringArray(raw.toolNames);
  const tools = readTools(raw.tools);
  const optionalStringKeys = ["workflowRunId", "workflowId", "stepId", "stepName"];
  if (!sourceKind || issueId === null || !toolNames || !tools) return null;
  if (optionalStringKeys.some((key) => Object.prototype.hasOwnProperty.call(raw, key) && asString(raw[key]) === null)) return null;
  if (Object.prototype.hasOwnProperty.call(raw, "toolArgs") && raw.toolArgs === null) return null;

  return {
    source: "run",
    raw,
    version: 1,
    sourceKind,
    issueId,
    ...(typeof raw.workflowRunId === "string" ? { workflowRunId: raw.workflowRunId.trim() } : {}),
    ...(typeof raw.workflowId === "string" ? { workflowId: raw.workflowId.trim() } : {}),
    ...(typeof raw.stepId === "string" ? { stepId: raw.stepId.trim() } : {}),
    ...(typeof raw.stepName === "string" ? { stepName: raw.stepName.trim() } : {}),
    toolNames,
    ...(Object.prototype.hasOwnProperty.call(raw, "toolArgs") ? { toolArgs: raw.toolArgs } : {}),
    tools,
  };
}

function parseLegacyContract(value: unknown): ParsedRunToolContract | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const tools = readTools(raw.tools) ?? [];
  const toolNames = Array.from(new Set([
    ...(readStringArray(raw.toolNames) ?? []),
    ...tools.map((tool) => tool.name),
  ]));
  if (toolNames.length === 0 && !asString(raw.stepName) && !asString(raw.stepId)) return null;

  return {
    source: "legacy",
    raw,
    version: 1,
    sourceKind: "workflow_step",
    issueId: typeof raw.issueId === "string" ? raw.issueId.trim() : null,
    ...(typeof raw.workflowRunId === "string" ? { workflowRunId: raw.workflowRunId.trim() } : {}),
    ...(typeof raw.workflowId === "string" ? { workflowId: raw.workflowId.trim() } : {}),
    ...(typeof raw.stepId === "string" ? { stepId: raw.stepId.trim() } : {}),
    ...(typeof raw.stepName === "string" ? { stepName: raw.stepName.trim() } : {}),
    toolNames,
    toolArgs: raw.toolArgs ?? {},
    tools,
  };
}

export function readRunToolContract(context: unknown): ParsedRunToolContract | null {
  const record = asRecord(context);
  if (!record) return null;
  if (Object.prototype.hasOwnProperty.call(record, RUN_TOOL_CONTRACT_CONTEXT_KEY)) {
    return parseRunContract(record[RUN_TOOL_CONTRACT_CONTEXT_KEY]);
  }
  return parseLegacyContract(record[LEGACY_WORKFLOW_TOOL_CONTRACT_CONTEXT_KEY]);
}

export function parseRunToolContract(value: unknown): PaperclipRunToolContractV1 | null {
  const parsed = parseRunContract(value);
  return parsed?.issueId ? { ...parsed, issueId: parsed.issueId } : null;
}
