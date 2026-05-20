const ENABLED_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "antigravity_local",
  "gemini_local",
  "opencode_local",
  "hermes_local",
  "cursor",
]);

export function isAdapterTypeEnabled(type: string): boolean {
  return ENABLED_ADAPTER_TYPES.has(type);
}
