export const PLUGIN_ID = "insightflo.tool-registry";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "tool-registry";

export const SLOT_IDS = {
  page: "tool-registry-page",
  sidebar: "tool-registry-sidebar-link",
} as const;

export const EXPORT_NAMES = {
  page: "ToolRegistryPage",
  sidebar: "ToolRegistrySidebarLink",
} as const;

export const TOOL_NAMES = {
  genericCliExecutor: "generic-cli-executor",
  markDone: "mark-done",
  escalate: "escalate",
} as const;

export const ENTITY_TYPES = {
  toolConfig: "tool-config",
  agentToolGrant: "agent-tool-grant",
  executionLog: "tool-execution-log",
} as const;

export const DATA_KEYS = {
  pageData: "tool-registry.page-data",
} as const;

export const ACTION_KEYS = {
  createTool: "tool-registry.create-tool",
  updateTool: "tool-registry.update-tool",
  deleteTool: "tool-registry.delete-tool",
  restoreTool: "tool-registry.restore-tool",
  grantTool: "tool-registry.grant-tool",
  revokeTool: "tool-registry.revoke-tool",
  executeWorkflowTool: "tool-registry.execute-workflow-tool",
} as const;

export const DEFAULT_MAX_LOGS = 50;
