import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import type { AdapterModel } from "./types.js";
import { dedupeAdapterModels } from "./local-cli-models.js";

const execFileAsync = promisify(execFile);

const HERMES_MODELS_CACHE_TTL_MS = 60_000;
const HERMES_AUTH_CACHE_TTL_MS = 10 * 60_000;
const HERMES_AUTH_PROBE_TIMEOUT_MS = 45_000;
const HERMES_OPENAI_CODEX_PROVIDER = "openai-codex";
const hermesFallbackModels = codexFallbackModels.map((model) => ({
  id: `${HERMES_OPENAI_CODEX_PROVIDER}/${model.id}`,
  label: model.label,
}));

let cached: { cachePath: string; mtimeMs: number; expiresAt: number; models: AdapterModel[] } | null = null;

/**
 * Hermes venv 파이썬에서 (1) 인증된 provider 집합(`list_available_providers`,
 * `hermes model` 피커와 동일 판정)과 (2) provider별 모델 목록
 * (`cached_provider_model_ids` — 1h TTL, stale 시 live fetch 후
 * provider_models_cache.json 재기록, 네트워크 실패 시 stale 폴백)을 한 번에 받는다.
 *
 * 이 경로는 Hermes 자신이 /model 피커에서 쓰는 것과 동일하므로, 드롭다운이
 * 실제 실행 가능한 provider/model 과 어긋나지 않고 새 모델/단종 모델이
 * Hermes 기준으로 자동 반영된다.
 *
 * stdout 에 dotenv/bitwarden 배너가 섞일 수 있으므로 sentinel 뒤 JSON 만 파싱한다.
 */
const HERMES_AUTH_PROBE_SCRIPT = `import json
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.models import cached_provider_model_ids, list_available_providers
providers = []
aliases = {}
for p in list_available_providers():
    if p.get("authenticated"):
        pid = p["id"]
        providers.append(pid)
        aliases[pid] = p.get("aliases") or []
models = {}
for pid in providers:
    try:
        ids = cached_provider_model_ids(pid)
    except Exception:
        ids = []
    if ids:
        models[pid] = sorted(str(m) for m in ids)
print("@@PAPERCLIP_HERMES_AUTH@@")
print(json.dumps({"providers": providers, "aliases": aliases, "models": models}))
`;

const HERMES_AUTH_SENTINEL = "@@PAPERCLIP_HERMES_AUTH@@";

interface HermesProbeResult {
  allowed: Set<string>;
  modelsByProvider: Map<string, string[]>;
}

function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return configured || path.join(os.homedir(), ".hermes");
}

function providerModelsCachePath(): string {
  return path.join(resolveHermesHome(), "provider_models_cache.json");
}

function hermesAuthJsonPath(): string {
  return path.join(resolveHermesHome(), "auth.json");
}

function hermesVenvPythonPath(): string {
  return path.join(resolveHermesHome(), "hermes-agent", "venv", "bin", "python");
}

function isModelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function providerOfModelId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : id;
}

function sortAdapterModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
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
  return sortAdapterModels(dedupeAdapterModels(models));
}

function mergeHermesFallbackModels(models: AdapterModel[]): AdapterModel[] {
  return sortAdapterModels(dedupeAdapterModels([...models, ...hermesFallbackModels]));
}

/**
 * auth.json credential_pool 기반 폴백. 파이썬 프록시를 못 쓰는 환경 전용이며
 * Hermes 실시간 판정(토큰 만료/오류)까지는 반영 못 한다(nous/alibaba 오탐 가능).
 */
function authenticatedProvidersFromAuthJson(): Set<string> | null {
  try {
    const payload = JSON.parse(fs.readFileSync(hermesAuthJsonPath(), "utf8")) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const pool = (payload as Record<string, unknown>).credential_pool;
    if (typeof pool !== "object" || pool === null || Array.isArray(pool)) return null;
    const allowed = new Set<string>();
    for (const [provider, credentials] of Object.entries(pool as Record<string, unknown>)) {
      if (Array.isArray(credentials) && credentials.length > 0) allowed.add(provider);
    }
    return allowed;
  } catch {
    return null;
  }
}

let cachedProbe: { hermesHome: string; pythonPath: string; expiresAt: number; result: HermesProbeResult } | null = null;

/**
 * 인증 provider + provider별 모델을 Hermes 런타임에서 직접 산출.
 * 파이썬 프록시 실패 시 null(레거시: 캐시 파일 + auth.json 폴백).
 */
export async function probeHermesAuthenticatedModels(): Promise<HermesProbeResult | null> {
  const hermesHome = resolveHermesHome();
  const pythonPath = hermesVenvPythonPath();
  const now = Date.now();
  if (
    cachedProbe &&
    cachedProbe.hermesHome === hermesHome &&
    cachedProbe.pythonPath === pythonPath &&
    cachedProbe.expiresAt > now
  ) {
    return cachedProbe.result;
  }

  let result: HermesProbeResult | null = null;
  try {
    const { stdout } = await execFileAsync(pythonPath, ["-c", HERMES_AUTH_PROBE_SCRIPT], {
      cwd: hermesHome,
      timeout: HERMES_AUTH_PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HERMES_HOME: hermesHome },
    });
    const sentinelIdx = stdout.lastIndexOf(HERMES_AUTH_SENTINEL);
    if (sentinelIdx >= 0) {
      const jsonStart = stdout.indexOf("{", sentinelIdx);
      const payload = JSON.parse(stdout.slice(jsonStart)) as {
        providers?: unknown;
        aliases?: unknown;
        models?: unknown;
      };
      const providers = Array.isArray(payload.providers)
        ? payload.providers.filter((p): p is string => typeof p === "string")
        : [];
      const allowed = new Set(providers);
      const aliases =
        typeof payload.aliases === "object" && payload.aliases !== null
          ? Object.values(payload.aliases as Record<string, unknown>)
          : [];
      for (const aliasList of aliases) {
        if (Array.isArray(aliasList)) {
          for (const alias of aliasList) {
            if (typeof alias === "string") allowed.add(alias);
          }
        }
      }
      const modelsByProvider = new Map<string, string[]>();
      if (typeof payload.models === "object" && payload.models !== null) {
        for (const [provider, models] of Object.entries(payload.models as Record<string, unknown>)) {
          if (isModelList(models) && models.length > 0) modelsByProvider.set(provider, models);
        }
      }
      result = { allowed, modelsByProvider };
    }
  } catch {
    result = null;
  }
  if (result) {
    cachedProbe = { hermesHome, pythonPath, expiresAt: now + HERMES_AUTH_CACHE_TTL_MS, result };
  }
  return result;
}

/** Legacy export kept for tests: authenticated provider set only. */
export async function resolveAuthenticatedHermesProviders(): Promise<Set<string> | null> {
  return (await probeHermesAuthenticatedModels())?.allowed ?? authenticatedProvidersFromAuthJson();
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  const probe = await probeHermesAuthenticatedModels();
  if (probe) {
    // Hermes 런타임 판정 성공: 프로브가 준 목록(있는 provider 만)이 진실.
    const models: AdapterModel[] = [];
    for (const [provider, providerModels] of probe.modelsByProvider) {
      for (const model of providerModels) {
        const id = `${provider}/${model}`;
        models.push({ id, label: id });
      }
    }
    const sorted = sortAdapterModels(dedupeAdapterModels(models));
    return probe.allowed.has(HERMES_OPENAI_CODEX_PROVIDER)
      ? mergeHermesFallbackModels(sorted)
      : sorted;
  }

  // 폴백: 캐시 파일 + auth.json credential_pool 필터.
  const cachePath = providerModelsCachePath();
  let raw: AdapterModel[] = [];
  try {
    const stat = await fs.promises.stat(cachePath);
    const now = Date.now();
    if (cached && cached.cachePath === cachePath && cached.mtimeMs === stat.mtimeMs && cached.expiresAt > now) {
      raw = cached.models;
    } else {
      const payload = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as unknown;
      raw = parseHermesProviderModelsCache(payload);
      cached = { cachePath, mtimeMs: stat.mtimeMs, expiresAt: now + HERMES_MODELS_CACHE_TTL_MS, models: raw };
    }
  } catch {
    raw = [];
  }

  const allowed = authenticatedProvidersFromAuthJson();
  if (!allowed) return mergeHermesFallbackModels(raw);

  const filtered = raw.filter((model) => allowed.has(providerOfModelId(model.id)));
  return allowed.has(HERMES_OPENAI_CODEX_PROVIDER)
    ? mergeHermesFallbackModels(filtered)
    : sortAdapterModels(dedupeAdapterModels(filtered));
}

export function resetHermesModelsCacheForTests() {
  cached = null;
  cachedProbe = null;
}
