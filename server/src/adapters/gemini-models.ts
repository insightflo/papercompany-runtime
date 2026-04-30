import { models as geminiFallbackModels } from "@paperclipai/adapter-gemini-local";
import type { AdapterModel } from "./types.js";
import { dedupeAdapterModels, discoverModelsFromLocalCli } from "./local-cli-models.js";

const GEMINI_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeAdapterModels([...models, ...geminiFallbackModels]).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

export async function listGeminiModels(): Promise<AdapterModel[]> {
  const fallback = dedupeAdapterModels(geminiFallbackModels);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const command = process.env.PAPERCLIP_GEMINI_COMMAND?.trim() || "gemini";
  const discovered = discoverModelsFromLocalCli(command, [
    ["models", "list", "--json"],
    ["models", "list"],
    ["models", "--json"],
    ["models"],
    ["--list-models"],
  ]);

  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = { expiresAt: now + GEMINI_MODELS_CACHE_TTL_MS, models: merged };
    return merged;
  }

  return fallback;
}

export function resetGeminiModelsCacheForTests() {
  cached = null;
}
