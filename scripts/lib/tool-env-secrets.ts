import { isSensitiveToolEnvKey } from "../../server/src/services/tool-env-sensitivity.js";

type ToolEnvRow = { id: string; adapterConfig: unknown };
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function planToolEnvSecrets(tool: ToolEnvRow) {
  const env = record(record(tool.adapterConfig)?.env);
  return Object.entries(env ?? {}).flatMap(([key, binding]) => {
    if (!isSensitiveToolEnvKey(key)) return [];
    const object = record(binding);
    const value = typeof binding === "string" ? binding
      : object?.type === "plain" && typeof object.value === "string" ? object.value : null;
    if (value === null || !value.trim()) return [];
    return [{ key, value, name: `tool_${tool.id.slice(0, 8)}_${key.toLowerCase()}` }];
  });
}

// All secret writes finish before the caller can persist the replacement config.
// On failure, the original row stays intact; successfully created secrets can be reused.
export async function transformToolEnvSecrets(
  tool: ToolEnvRow,
  apply: boolean,
  writeSecret: (entry: ReturnType<typeof planToolEnvSecrets>[number]) => Promise<string>,
) {
  const plan = planToolEnvSecrets(tool);
  const keys = plan.map(entry => entry.key);
  if (!apply || !keys.length) return { keys, adapterConfig: null };
  const adapterConfig = record(tool.adapterConfig)!;
  const env = { ...record(adapterConfig.env) };
  for (const entry of plan) {
    const secretId = await writeSecret(entry);
    env[entry.key] = { type: "secret_ref", secretId, version: "latest" };
  }
  return { keys, adapterConfig: { ...adapterConfig, env } };
}
