/**
 * Tool Service Types
 *
 * Defines interfaces for tool definitions, audit logging, and tool dispatch.
 */

/**
 * Tool definition represents a callable tool that agents can use.
 */
export interface ToolDefinition {
  id: string;
  companyId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  adapterType: "mcp" | "builtin" | "http";
  adapterConfig: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new tool definition.
 */
export interface CreateToolDefinitionInput {
  companyId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  adapterType: ToolDefinition["adapterType"];
  adapterConfig: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Tool invocation result.
 */
export interface ToolInvocationResult {
  allowed: boolean;
  blockedReason?: string;
  result?: unknown;
}

/**
 * Tool audit log entry.
 */
export interface ToolAuditLogEntry {
  id: string;
  toolId: string;
  companyId: string;
  issueId: string | null;
  agentId: string | null;
  argsHash: string;
  result: "allowed" | "blocked_must" | "blocked_should";
  createdAt: Date;
}

/**
 * Worktree check result (from worktree service).
 */
export interface WorktreeCheckResult {
  allowed: boolean;
  tier: "MUST" | "SHOULD" | "MAY" | null;
  violatedRuleId: string | null;
  message: string | null;
}

/**
 * Tool dispatch context.
 */
export interface ToolDispatchContext {
  companyId: string;
  issueId: string | null;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  worktreeCheck?: WorktreeCheckResult;
}
