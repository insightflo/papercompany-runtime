import { spawnSync } from "node:child_process";
import type { AdapterModel } from "./types.js";

const LOCAL_CLI_MODELS_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 512 * 1024;

export type LocalCliModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

type LocalCliModelsRunner = (command: string, args: string[]) => LocalCliModelsCommandResult;

function defaultRunner(command: string, args: string[]): LocalCliModelsCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: LOCAL_CLI_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let runner: LocalCliModelsRunner = defaultRunner;

export function setLocalCliModelsRunnerForTests(next: LocalCliModelsRunner | null) {
  runner = next ?? defaultRunner;
}

export function dedupeAdapterModels(models: AdapterModel[]): AdapterModel[] {
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

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(.*\)\s*$/g, "")
    .replace(/[,;]+$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const value = sanitizeModelId(raw);
  if (!value) return false;
  if (/^(id|name|model|models|available|provider|description|created|owned_by)$/i.test(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function pushModelId(target: AdapterModel[], raw: string) {
  const id = sanitizeModelId(raw);
  if (!isLikelyModelId(id)) return;
  target.push({ id, label: id });
}

function collectFromJsonValue(value: unknown, target: AdapterModel[]) {
  if (typeof value === "string") {
    pushModelId(target, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromJsonValue(item, target);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const rec = value as Record<string, unknown>;
  for (const key of ["id", "name", "model", "modelId"]) {
    const id = rec[key];
    if (typeof id === "string") pushModelId(target, id);
  }
  for (const key of ["models", "data", "items", "availableModels"]) {
    if (key in rec) collectFromJsonValue(rec[key], target);
  }
}

export function parseLocalCliModelsOutput(stdout: string, stderr = ""): AdapterModel[] {
  const models: AdapterModel[] = [];
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      collectFromJsonValue(JSON.parse(trimmedStdout) as unknown, models);
    } catch {
      // Ignore malformed JSON and continue parsing text output.
    }
  }

  const combined = `${stdout}\n${stderr}`;
  for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
    for (const token of (match[1] ?? "").split(/[,\s]+/)) pushModelId(models, token);
  }

  for (const lineRaw of combined.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const bullet = line.replace(/^[-*•]\s+/, "").trim();
    const tableCell = bullet.split(/\s{2,}|\t/)[0] ?? bullet;
    if (!tableCell || tableCell.includes(" ")) continue;
    pushModelId(models, tableCell);
  }

  return dedupeAdapterModels(models);
}

export function discoverModelsFromLocalCli(command: string, argSets: string[][]): AdapterModel[] {
  for (const args of argSets) {
    const result = runner(command, args);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.hasError && output.trim().length === 0) continue;
    const parsed = parseLocalCliModelsOutput(result.stdout, result.stderr);
    if ((result.status ?? 1) === 0 && parsed.length > 0) return parsed;
    if (parsed.length > 0 && /available models?:/i.test(output)) return parsed;
  }
  return [];
}
