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

export type AdapterAuthState =
  | { kind: "ok"; headerName: string; secretId: string | null; version: number | "latest" }
  | { kind: "no-auth" }
  | { kind: "invalid" };

/**
 * Reads the `adapterConfig.auth` header-auth block from the raw JSON form
 * state. Returns `invalid` when the JSON cannot be parsed so the selector can
 * stay disabled until the Advanced JSON is fixed.
 */
export function readAdapterAuth(adapterConfigJson: string): AdapterAuthState {
  let cfg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(adapterConfigJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid" };
    }
    cfg = parsed as Record<string, unknown>;
  } catch {
    return { kind: "invalid" };
  }
  const auth = cfg.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return { kind: "no-auth" };
  }
  const a = auth as Record<string, unknown>;
  const headerName = typeof a.headerName === "string" ? a.headerName : "";
  const secretId = typeof a.secretId === "string" && a.secretId.trim() ? a.secretId : null;
  const version =
    a.version === "latest" || (typeof a.version === "number" && a.version > 0)
      ? (a.version as number | "latest")
      : "latest";
  return { kind: "ok", headerName, secretId, version };
}

export type AdapterAuthPatch = {
  headerName?: string;
  secretId?: string | null;
  version?: number | "latest";
};

/**
 * Merges a header-auth patch into the raw adapter config JSON, preserving all
 * other adapterConfig fields. Selecting a secret always pins `version: latest`.
 * Throws if the JSON is invalid — callers must guard with `readAdapterAuth`.
 */
export function writeAdapterAuth(adapterConfigJson: string, patch: AdapterAuthPatch): string {
  const parsed: unknown = JSON.parse(adapterConfigJson);
  const cfg =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const current =
    cfg.auth && typeof cfg.auth === "object" && !Array.isArray(cfg.auth)
      ? (cfg.auth as Record<string, unknown>)
      : {};
  const headerName =
    patch.headerName !== undefined
      ? patch.headerName
      : typeof current.headerName === "string"
        ? current.headerName
        : "Authorization";
  const secretId =
    patch.secretId !== undefined
      ? patch.secretId
      : typeof current.secretId === "string"
        ? current.secretId
        : "";
  const version = patch.version !== undefined ? patch.version : (current.version ?? "latest");
  return JSON.stringify(
    { ...cfg, auth: { type: "header", headerName, secretId, version } },
    null,
    2,
  );
}
