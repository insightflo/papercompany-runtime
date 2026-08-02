import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

/**
 * A model id is a slug, optionally with a single provider prefix (`provider/model`).
 * This rejects section headers, the "Available models" banner, and footer prose.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function parseCommandCodeModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Command Code separates the model id from its description with 2+ spaces.
    const parts = line.split(/\s{2,}/);
    let id: string;
    let label: string;
    if (parts.length >= 2) {
      id = parts[0].trim();
      label = parts.slice(1).join(" ").trim() || id;
    } else if (/[/-]|\d/.test(line)) {
      // Defensive: a bare model id with no description column. Real output always
      // includes descriptions, so this only matters for atypical listings. The
      // digit/slash/hyphen requirement rejects provider section headers.
      id = line;
      label = line;
    } else {
      continue;
    }
    if (!MODEL_ID_RE.test(id)) continue;
    parsed.push({ id, label });
  }
  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

export function resolveCommandCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_COMMANDCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_COMMANDCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_COMMANDCODE_COMMAND.trim()
      : "cmd";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverCommandCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `commandcode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`cmd --list-models` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(
      detail ? `\`cmd --list-models\` failed: ${detail}` : "`cmd --list-models` failed.",
    );
  }

  return sortModels(dedupeModels(parseCommandCodeModelsOutput(result.stdout)));
}

export async function discoverCommandCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverCommandCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function listCommandCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverCommandCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetCommandCodeModelsCacheForTests() {
  discoveryCache.clear();
}
