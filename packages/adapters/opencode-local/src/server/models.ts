import { createHash } from "node:crypto";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;
// 만료된 cache entry 가 stale fallback 으로 살아있는 보존 기간. 이 window 안의 expired entry 는
// fresh discovery 실패 시 반환된다(Phase 3: stale serve). 이를 넘으면 prune.
const MODELS_STALE_RETENTION_MS = 5 * 60_000;
// fresh discovery 의 timeout/exit 실패에 대한 재시도. 시작 실패(command 부재 등)는 비재시도.
const MODELS_DISCOVERY_MAX_ATTEMPTS = 2; // initial + 1 retry
const MODELS_DISCOVERY_RETRY_BACKOFF_MS = 500;

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "HOME"]);

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
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

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

// [수정시 주의] stale serve 를 위해 만료 즉시 삭제하지 않는다. expiresAt + STALE_RETENTION 을
// 넘은 entry 만 prune 한다 (expired-but-within-retention entry 는 fresh discovery 실패 시 fallback).
function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt + MODELS_STALE_RETENTION_MS <= now) discoveryCache.delete(key);
  }
}

/**
 * [목적] isRetryableDiscoveryError — 재시도할 만한 일시 실패인지 판별. timeout / exit failure 만
 *   재시도하고, command 시작 실패(ENOENT 등 "Failed to start command")는 재시도하지 않는다
 *   (command 가 실제로 없는 경우이므로 재시도해도 실패 → run startup latency 만 낭비).
 * [연결] withRetry 의 shouldRetry predicate 로 사용.
 */
export function isRetryableDiscoveryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("timed out") || message.includes("`opencode models` failed");
}

/**
 * [목적] withRetry — fn 을 maxAttempts 회 시도. shouldRetry(err) 가 true 인 실패만 재시도
 *   (false 면 즉시 throw). 마지막 시도 실패 시 마지막 에러 throw.
 * [입력] fn, maxAttempts(≥1), backoffMs, shouldRetry(기본 항상 true).
 * [출력] fn 의 반환값.
 * [연결] resolveModelsCached 가 discoverOpenCodeModels 호출을 감쌈.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  backoffMs: number,
  shouldRetry: (err: unknown) => boolean = () => true,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const moreAttempts = attempt < maxAttempts;
      if (moreAttempts && shouldRetry(err)) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  // unreachable — for 루프가 모든 attempt 를 소진하면 위에서 throw 됨.
  throw new Error("withRetry exhausted attempts without resolution");
}

export async function discoverOpenCodeModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env, ...(resolvedHome ? { HOME: resolvedHome } : {}) }));

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`opencode models\` failed: ${detail}` : "`opencode models` failed.");
  }

  return sortModels(parseModelsOutput(result.stdout));
}

type ResolvedModels = {
  models: AdapterModel[];
  /** true = fresh cache 또는 이번에 fresh discovery 성공. false = fresh discovery 실패로 stale cache 반환. */
  fresh: boolean;
  /** stale serve 시 fresh discovery 실패 사유(staleReason). fresh=true 면 undefined. */
  staleReason?: string;
};

/**
 * [목적] resolveModelsCached — models cache 해석 + retry + stale serve. fresh cache hit 시 즉시 반환,
 *   아니면 discoverOpenCodeModels 를 withRetry 로 시도. 모든 시도 실패 시 (retention 내) stale cache 가
 *   있으면 stale models(fresh=false)를 반환하고 warning, stale 도 없으면 기존처럼 에러 throw.
 * [출력] { models, fresh, staleReason? }.
 * [연결] discoverOpenCodeModelsCached / ensureOpenCodeModelConfiguredAndAvailable 가 사용.
 */
async function resolveModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<ResolvedModels> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);

  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { models: cached.models, fresh: true };
  }

  try {
    const models = await withRetry(
      () => discoverOpenCodeModels({ command, cwd, env }),
      MODELS_DISCOVERY_MAX_ATTEMPTS,
      MODELS_DISCOVERY_RETRY_BACKOFF_MS,
      isRetryableDiscoveryError,
    );
    discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
    return { models, fresh: true };
  } catch (err) {
    // fresh discovery 실패(retry 포함). retention 내 stale cache 가 있으면 반환.
    const stale = discoveryCache.get(key);
    if (stale && stale.models.length > 0) {
      const reason = err instanceof Error ? err.message : String(err);
      const cachedAt = stale.expiresAt - MODELS_CACHE_TTL_MS;
      console.warn(
        `[opencode-models] discovery failed; serving STALE cached models (ageMs=${Math.max(0, now - cachedAt)}, reason=${reason}).`,
      );
      return { models: stale.models, fresh: false, staleReason: reason };
    }
    throw err;
  }
}

export async function discoverOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  return (await resolveModelsCached(input)).models;
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }

  const { models, fresh, staleReason } = await resolveModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (!fresh) {
    // [검증 표시] stale cache 로 model availability 를 검증했음을 코드/로그에 노출.
    console.warn(
      `[opencode-models] configured-model availability checked against STALE cache (reason=${staleReason ?? "unknown"}).`,
    );
  }

  if (models.length === 0) {
    throw new Error("OpenCode returned no models. Run `opencode models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}

/**
 * [목적] seedOpenCodeModelsCacheForTests — 테스트용 cache 주입. expiresAtOffsetMs > 0 이면 fresh,
 *   < 0 이면 stale(만료, retention 내) entry 를 만든다. stale-serve / fresh-hit 테스트에 사용.
 */
export function seedOpenCodeModelsCacheForTests(
  input: { command?: unknown; cwd?: unknown; env?: unknown },
  models: AdapterModel[],
  expiresAtOffsetMs: number,
) {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  discoveryCache.set(key, { expiresAt: Date.now() + expiresAtOffsetMs, models });
}
