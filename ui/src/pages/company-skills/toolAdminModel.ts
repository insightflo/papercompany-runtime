import type {
  CreateToolDefinitionRequest,
  ToolDefinition,
  ToolDefinitionAdapterType,
} from "@paperclipai/shared";

export type ToolFormState = {
  name: string;
  description: string;
  inputSchemaJson: string;
  adapterType: ToolDefinitionAdapterType;
  adapterConfigJson: string;
  enabled: boolean;
};

export const emptyToolForm: ToolFormState = {
  name: "",
  description: "",
  inputSchemaJson: "{\n  \"type\": \"object\"\n}",
  adapterType: "http",
  adapterConfigJson: "{}",
  enabled: true,
};

type ToolSelectionInput = {
  isCreating: boolean;
  selectedToolId: string | null;
  toolIds: readonly string[];
};

export function resolveToolSelection({
  isCreating,
  selectedToolId,
  toolIds,
}: ToolSelectionInput): string | null {
  if (isCreating) return null;
  if (selectedToolId && toolIds.includes(selectedToolId)) return selectedToolId;
  return toolIds[0] ?? null;
}

export function isSourceManagedTool(adapterConfig: Record<string, unknown>): boolean {
  return adapterConfig.source === "tool-registry";
}

function formatJson(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

export function formFromTool(tool: ToolDefinition): ToolFormState {
  return {
    name: tool.name,
    description: tool.description,
    inputSchemaJson: formatJson(tool.inputSchema),
    adapterType: tool.adapterType,
    adapterConfigJson: formatJson(tool.adapterConfig),
    enabled: tool.enabled,
  };
}

export function buildToolPayload(form: ToolFormState): CreateToolDefinitionRequest {
  const name = form.name.trim();
  if (!name) throw new Error("Tool name is required.");

  return {
    name,
    description: form.description.trim(),
    inputSchema: parseJsonObject(form.inputSchemaJson, "Input schema"),
    adapterType: form.adapterType,
    adapterConfig: parseJsonObject(form.adapterConfigJson, "Adapter config"),
    enabled: form.enabled,
  };
}
