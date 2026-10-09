import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// Persisted metadata only: these mission tests never load a plugin worker.
export function missionPluginManifest(
  id: string,
  displayName: string,
  version: string,
): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version,
    displayName,
    description: "Plugin metadata fixture for mission service tests",
    author: "Papercompany tests",
    categories: ["automation"],
    capabilities: ["plugin.state.read"],
    entrypoints: { worker: "dist/worker.js" },
  };
}
