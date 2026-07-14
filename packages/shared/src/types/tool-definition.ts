export type ToolDefinitionAdapterType = "mcp" | "builtin" | "http";

export interface ToolDefinition {
  id: string;
  companyId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  adapterType: ToolDefinitionAdapterType;
  adapterConfig: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateToolDefinitionRequest {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  adapterType: ToolDefinitionAdapterType;
  adapterConfig: Record<string, unknown>;
  enabled?: boolean;
}

export type UpdateToolDefinitionRequest = Partial<CreateToolDefinitionRequest>;

/**
 * Bounded outcome of a board-initiated tool test invocation.
 * Returned by the tool test endpoint; never includes resolved secret values.
 */
export type ToolTestStatus = "success" | "failure" | "error";

export type ToolTestOutcome = {
  ok: boolean;
  status: ToolTestStatus;
  httpStatus: number;
  error?: string;
  result?: unknown;
  stderr?: string;
};
