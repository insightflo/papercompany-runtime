import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "./types.js";
import { dedupeAdapterModels } from "./local-cli-models.js";

const HERMES_MODELS_CACHE_TTL_MS = 60_000;

let cached: { cachePath: string; mtimeMs: number; expiresAt: number; models: AdapterModel[] } | null = null;

function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return configured || path.join(os.homedir(), ".hermes");
}

function providerModelsCachePath(): string {
  return path.join(resolveHermesHome(), "provider_models_cache.json");
}

function isModelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseHermesProviderModelsCache(value: unknown): AdapterModel[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const models: AdapterModel[] = [];
  for (const [providerRaw, entry] of Object.entries(value as Record<string, unknown>)) {
    const provider = providerRaw.trim();
    if (!provider || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const providerModels = (entry as Record<string, unknown>).models;
    if (!isModelList(providerModels)) continue;
    for (const rawModel of providerModels) {
      const model = rawModel.trim();
      if (!model) continue;
      const id = `${provider}/${model}`;
      models.push({ id, label: id });
    }
  }
  return dedupeAdapterModels(models).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  const cachePath = providerModelsCachePath();
  try {
    const stat = await fs.promises.stat(cachePath);
    const now = Date.now();
    if (cached && cached.cachePath === cachePath && cached.mtimeMs === stat.mtimeMs && cached.expiresAt > now) {
      return cached.models;
    }
    const payload = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as unknown;
    const models = parseHermesProviderModelsCache(payload);
    cached = { cachePath, mtimeMs: stat.mtimeMs, expiresAt: now + HERMES_MODELS_CACHE_TTL_MS, models };
    return models;
  } catch {
    return [];
  }
}

export function resetHermesModelsCacheForTests() {
  cached = null;
}
