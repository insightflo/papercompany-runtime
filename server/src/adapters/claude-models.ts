import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";
import type { AdapterModel } from "./types.js";
import { dedupeAdapterModels, discoverModelsFromLocalCli } from "./local-cli-models.js";

const CLAUDE_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeAdapterModels([...models, ...claudeFallbackModels]).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

export async function listClaudeModels(): Promise<AdapterModel[]> {
  const fallback = dedupeAdapterModels(claudeFallbackModels);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const command = process.env.PAPERCLIP_CLAUDE_COMMAND?.trim() || "claude";
  const discovered = discoverModelsFromLocalCli(command, [
    ["models", "--json"],
    ["models"],
    ["model", "list", "--json"],
    ["model", "list"],
    ["--list-models"],
  ]);

  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = { expiresAt: now + CLAUDE_MODELS_CACHE_TTL_MS, models: merged };
    return merged;
  }

  return fallback;
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}
