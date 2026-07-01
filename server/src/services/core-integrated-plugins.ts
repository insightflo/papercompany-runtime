const CORE_INTEGRATED_PLUGIN_KEY_VALUES = [
  "insightflo.workflow-engine",
  "insightflo.tool-registry",
];

export const CORE_INTEGRATED_PLUGIN_KEYS: ReadonlySet<string> = new Set(
  CORE_INTEGRATED_PLUGIN_KEY_VALUES,
);

export function isCoreIntegratedPluginKey(pluginKey: string): boolean {
  return CORE_INTEGRATED_PLUGIN_KEYS.has(pluginKey);
}
