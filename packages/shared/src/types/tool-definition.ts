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
