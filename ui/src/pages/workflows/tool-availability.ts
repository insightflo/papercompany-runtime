export type SelectableWorkflowTool = {
  name: string;
  displayName: string;
  description: string;
  pluginId: string;
  source?: string;
  enabled?: boolean;
};

export type WorkflowToolSystemState = {
  available: boolean;
  reason?: string;
};

export function getSelectableWorkflowTools<T extends SelectableWorkflowTool>(tools: T[]): T[] {
  return tools
    .filter((tool) => tool.name.trim().length > 0 && tool.enabled !== false)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function getWorkflowToolSystemState(
  tools: SelectableWorkflowTool[],
  explicitState?: WorkflowToolSystemState,
): WorkflowToolSystemState {
  const selectableTools = getSelectableWorkflowTools(tools);
  if (selectableTools.length === 0) {
    return {
      available: false,
      reason: explicitState?.reason ?? "No workflow tools are available.",
    };
  }
  return { available: true };
}
