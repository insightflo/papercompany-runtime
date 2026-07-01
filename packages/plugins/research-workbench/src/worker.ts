import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_RESULTS,
  MAX_TIMEOUT_MS,
  MIN_MAX_RESULTS,
  MIN_TIMEOUT_MS,
  PLUGIN_ID,
  TOOL_NAMES,
} from "./constants.js";
import manifest from "./manifest.js";
import { createVaneHeadlessAdapter } from "./adapters/vane-headless.js";
import { createScriptSearchAdapter } from "./adapters/script-search.js";
import { createDirectWebAdapter, DIRECT_WEB_BASE_URL } from "./adapters/direct-web.js";
import type {
  VaneHeadlessSearchOutput,
  EvidenceBundle as EvidenceBundleType,
  ResearchSearchInput,
} from "./types.js";
import { buildEvidenceBundle } from "./evidence.js";
import { resolveResearchProfile, resolveSourceScopeCategories } from "./profiles.js";

// ---------------------------------------------------------------------------
// Evidence bundle types (kept for backward compatibility with existing tests)
// ---------------------------------------------------------------------------

export interface EvidenceBundle {
  query: string;
  results: EvidenceItem[];
  meta: {
    backend: string;
    totalResults: number;
    elapsedMs: number;
  };
}

export interface EvidenceItem {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  source?: string;
}

// ---------------------------------------------------------------------------
// Adapter interface (injectable for tests)
// ---------------------------------------------------------------------------

export interface ResearchAdapter {
  search(
    query: string,
    options: { maxResults: number; timeoutMs: number },
  ): Promise<EvidenceBundle>;
}

/**
 * Production default adapter — not yet wired in B1.
 * Returns a clear error indicating the adapter is a placeholder.
 */
function createDefaultAdapter(): ResearchAdapter {
  return {
    async search(): Promise<EvidenceBundle> {
      throw new Error("Research Workbench backend adapter is not wired in B1");
    },
  };
}

// Module-level adapter, overridable for testing via setAdapter()
let adapter: ResearchAdapter = createDefaultAdapter();
let adapterOverridden = false;

/**
 * Inject a custom adapter (used by tests).
 * Resets to the default adapter when called with no argument.
 */
export function setAdapter(custom?: ResearchAdapter): void {
  adapter = custom ?? createDefaultAdapter();
  adapterOverridden = Boolean(custom);
  vaneAdapter = null;
  scriptAdapter = null;
  directWebAdapter = null;
}

// Module-level plugin context stash. onHealth() receives no ctx argument, so it
// reads the live instance config through this reference set during setup().
let pluginContext: PluginContext | null = null;

/**
 * Lightweight reachability probe for the configured backend base URL.
 * Any HTTP response (even 404/405) means the server is up; only a network-level
 * failure ("fetch failed") counts as unreachable. Short timeout keeps health snappy.
 */
async function probeBackendReachable(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(baseUrl, { method: "HEAD", signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Research Workbench health: report the configured backend's real state.
 * Does NOT force Vane — empty config defaults to the built-in direct-web
 * backend, while script and Vane are optional explicit backends.
 *   error    -> config missing a required field for the chosen backend
 *   degraded -> configured remote backend unreachable
 *   ok       -> default direct-web or configured backend is usable
 */
async function computeResearchHealth(): Promise<PluginHealthDiagnostics> {
  const ctx = pluginContext;
  if (!ctx) {
    return { status: "ok", message: "Research Workbench worker alive; config not yet loaded" };
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await ctx.config.get()) as Record<string, unknown>;
  } catch (err) {
    return {
      status: "degraded",
      message: `Research Workbench config read failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
  const config = resolveConfig(raw);

  if (config.backend === "direct-web") {
    return { status: "ok", message: "Research Workbench backend 'direct-web' configured" };
  }

  if (config.backend === "vane-headless") {
    if (!config.vaneBaseUrl) {
      return { status: "error", message: "vane-headless backend is missing required field: vaneBaseUrl" };
    }
    const reachable = await probeBackendReachable(config.vaneBaseUrl);
    if (!reachable) {
      return { status: "degraded", message: `Vane backend unreachable at ${config.vaneBaseUrl}` };
    }
    return { status: "ok", message: `Research Workbench backend 'vane-headless' reachable at ${config.vaneBaseUrl}` };
  }

  if (config.backend === "script") {
    if (!config.scriptCommand) {
      return { status: "error", message: "script backend is missing required field: scriptCommand" };
    }
    return { status: "ok", message: "Research Workbench backend 'script' configured" };
  }

  return { status: "error", message: `Research Workbench backend '${config.backend}' is not supported` };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface InstanceConfig {
  backend: "direct-web" | "vane-headless" | "script";
  vaneBaseUrl: string;
  scriptCommand: string;
  scriptWorkingDirectory: string;
  defaultMaxResults: number;
  timeoutMs: number;
}

function resolveConfig(raw: Record<string, unknown>): InstanceConfig {
  const backend = typeof raw.backend === "string" ? raw.backend : "direct-web";
  const vaneBaseUrl = typeof raw.vaneBaseUrl === "string" ? raw.vaneBaseUrl : "";
  const scriptCommand = typeof raw.scriptCommand === "string" ? raw.scriptCommand : "";
  const scriptWorkingDirectory = typeof raw.scriptWorkingDirectory === "string" ? raw.scriptWorkingDirectory : "";
  const rawMax = typeof raw.defaultMaxResults === "number" ? raw.defaultMaxResults : DEFAULT_MAX_RESULTS;
  const rawTimeout = typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    backend: backend as InstanceConfig["backend"],
    vaneBaseUrl,
    scriptCommand,
    scriptWorkingDirectory,
    defaultMaxResults: Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, rawMax)),
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawTimeout)),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function buildSearchInput(
  p: Record<string, unknown>,
  query: string,
  maxResults: number,
): ResearchSearchInput {
  const input: ResearchSearchInput = { query, maxResults };

  if (typeof p.profile === "string") {
    input.profile = p.profile as ResearchSearchInput["profile"];
  }

  if (typeof p.futureProfile === "string") {
    input.futureProfile = p.futureProfile as ResearchSearchInput["futureProfile"];
  }

  const sourceScope = stringArray(p.sourceScope);
  if (sourceScope) {
    input.sourceScope = sourceScope as ResearchSearchInput["sourceScope"];
  }

  const domainHints = stringArray(p.domainHints);
  if (domainHints) {
    input.domainHints = domainHints;
  }

  const excludeDomains = stringArray(p.excludeDomains);
  if (excludeDomains) {
    input.excludeDomains = excludeDomains;
  }

  if (typeof p.freshness === "string") {
    input.freshness = p.freshness as ResearchSearchInput["freshness"];
  }

  return input;
}

// ---------------------------------------------------------------------------
// Vane headless adapter integration
// ---------------------------------------------------------------------------

let vaneAdapter: ReturnType<typeof createVaneHeadlessAdapter> | null = null;
let scriptAdapter: ReturnType<typeof createScriptSearchAdapter> | null = null;
let directWebAdapter: ReturnType<typeof createDirectWebAdapter> | null = null;

function getOrCreateVaneAdapter(
  ctx: PluginContext,
  config: InstanceConfig,
): ReturnType<typeof createVaneHeadlessAdapter> {
  if (!vaneAdapter) {
    vaneAdapter = createVaneHeadlessAdapter({
      vaneBaseUrl: config.vaneBaseUrl,
      timeoutMs: config.timeoutMs,
      http: ctx.http,
      directFetch: fetch,
    });
  }
  return vaneAdapter;
}

function getOrCreateScriptAdapter(
  config: InstanceConfig,
): ReturnType<typeof createScriptSearchAdapter> {
  if (!scriptAdapter) {
    scriptAdapter = createScriptSearchAdapter({
      command: config.scriptCommand,
      workingDirectory: config.scriptWorkingDirectory || undefined,
      timeoutMs: config.timeoutMs,
    });
  }
  return scriptAdapter;
}

function getOrCreateDirectWebAdapter(
  ctx: PluginContext,
  config: InstanceConfig,
): ReturnType<typeof createDirectWebAdapter> {
  if (!directWebAdapter) {
    directWebAdapter = createDirectWebAdapter({
      http: ctx.http,
      timeoutMs: config.timeoutMs,
    });
  }
  return directWebAdapter;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleResearchSearch(
  ctx: PluginContext,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = (params ?? {}) as Record<string, unknown>;
  const query = typeof p.query === "string" ? p.query.trim() : "";

  if (!query) {
    return { error: "query is required" };
  }

  const config = resolveConfig(await ctx.config.get());

  if (config.backend === "vane-headless" && !config.vaneBaseUrl) {
    return { error: "Plugin instance config is missing required field for vane-headless backend: vaneBaseUrl" };
  }
  if (config.backend === "script" && !config.scriptCommand) {
    return { error: "Plugin instance config is missing required field for script backend: scriptCommand" };
  }
  if (!["direct-web", "vane-headless", "script"].includes(config.backend)) {
    return { error: `Research Workbench backend '${config.backend}' is not supported` };
  }

  const maxResults = typeof p.maxResults === "number"
    ? Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, p.maxResults))
    : config.defaultMaxResults;
  const searchInput = buildSearchInput(p, query, maxResults);

  // Determine which adapter path to use
  if (config.backend === "direct-web" && !adapterOverridden) {
    return handleDirectWebSearch(ctx, config, searchInput);
  }

  if (config.backend === "vane-headless" && !adapterOverridden) {
    return handleVaneHeadlessSearch(ctx, config, searchInput);
  }

  if (config.backend === "script" && !adapterOverridden) {
    return handleScriptSearch(config, searchInput);
  }

  // Fallback to the legacy adapter path (used by B1 tests with setAdapter)
  const startedAt = Date.now();

  try {
    const bundle = await adapter.search(query, {
      maxResults,
      timeoutMs: config.timeoutMs,
    });

    const elapsedMs = Date.now() - startedAt;

    return {
      content: JSON.stringify({
        ...bundle,
        meta: {
          ...bundle.meta,
          elapsedMs,
        },
      }, null, 2),
      data: bundle,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Research search failed: ${message}` };
  }
}

async function handleDirectWebSearch(
  ctx: PluginContext,
  config: InstanceConfig,
  input: ResearchSearchInput,
): Promise<ToolResult> {
  const directWeb = getOrCreateDirectWebAdapter(ctx, config);
  const query = input.query;
  const maxResults = input.maxResults ?? config.defaultMaxResults;

  const profileResolution = resolveResearchProfile(input);
  const scopeMapping = resolveSourceScopeCategories(
    input.sourceScope ?? profileResolution.profile.sourceScope,
    { discussionsSupported: false },
  );

  const output: VaneHeadlessSearchOutput = await directWeb.search({
    ...input,
    query,
    maxResults,
  });

  if (!output.ok) {
    const retryable = output.retryable;
    const retryAfter = output.retryAfterSeconds;
    const errorDetail = retryable
      ? `${output.error} (retryable, retryAfter=${retryAfter ?? 60}s)`
      : output.error;
    return {
      error: `Research search failed: ${errorDetail}`,
      data: {
        retryable,
        ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}),
        error: output.error,
      },
    };
  }

  const bundle = buildEvidenceBundle({
    input,
    rawResults: output.results,
    profile: profileResolution.profile,
    retrievedAt: output.retrievedAt,
    rawEngine: {
      name: "direct-web",
      baseUrl: DIRECT_WEB_BASE_URL,
      upstreamVersion: output.engine.upstreamVersion,
      patchVersion: output.engine.patchVersion,
    },
    warnings: [...profileResolution.warnings, ...scopeMapping.warnings],
  });

  return {
    content: `Research search completed for "${query}" via direct-web backend: ${bundle.sources.length} sources, ${bundle.warnings.length} warnings. Use \`data.sources\`, \`data.warnings\`, and \`data.gaps\` for synthesis; do not treat this as final analysis.`,
    data: bundle,
  };
}

async function handleVaneHeadlessSearch(
  ctx: PluginContext,
  config: InstanceConfig,
  input: ResearchSearchInput,
): Promise<ToolResult> {
  const vane = getOrCreateVaneAdapter(ctx, config);
  const query = input.query;
  const maxResults = input.maxResults ?? config.defaultMaxResults;

  const profileResolution = resolveResearchProfile(input);
  const scopeMapping = resolveSourceScopeCategories(
    input.sourceScope ?? profileResolution.profile.sourceScope,
    { discussionsSupported: true },
  );

  const output: VaneHeadlessSearchOutput = await vane.search({
    query,
    maxResults,
    profile: profileResolution.profile.name,
    categories: scopeMapping.categories,
  });

  if (!output.ok) {
    const retryable = output.retryable;
    const retryAfter = output.retryAfterSeconds;
    const errorDetail = retryable
      ? `${output.error} (retryable, retryAfter=${retryAfter ?? 60}s)`
      : output.error;
    return {
      error: `Research search failed: ${errorDetail}`,
      data: {
        retryable,
        ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}),
        error: output.error,
      },
    };
  }

  // Build the evidence bundle from raw Vane results
  const retrievedAt = output.retrievedAt;
  const bundle = buildEvidenceBundle({
    input,
    rawResults: output.results,
    profile: profileResolution.profile,
    retrievedAt,
    rawEngine: {
      name: "vane-headless",
      baseUrl: config.vaneBaseUrl,
      upstreamVersion: output.engine.upstreamVersion,
      patchVersion: output.engine.patchVersion,
    },
    warnings: [...profileResolution.warnings, ...scopeMapping.warnings],
  });

  const sourceCount = bundle.sources.length;
  const warningCount = bundle.warnings.length;
  const content = `Research search completed for "${query}": ${sourceCount} sources, ${warningCount} warnings. Use \`data.sources\`, \`data.warnings\`, and \`data.gaps\` for synthesis; do not treat this as final analysis.`;

  return {
    content,
    data: bundle,
  };
}

async function handleScriptSearch(
  config: InstanceConfig,
  input: ResearchSearchInput,
): Promise<ToolResult> {
  const script = getOrCreateScriptAdapter(config);
  const query = input.query;
  const maxResults = input.maxResults ?? config.defaultMaxResults;

  const profileResolution = resolveResearchProfile(input);
  const scopeMapping = resolveSourceScopeCategories(
    input.sourceScope ?? profileResolution.profile.sourceScope,
    { discussionsSupported: true },
  );

  const output: VaneHeadlessSearchOutput = await script.search({
    ...input,
    query,
    maxResults,
    profile: profileResolution.profile.name,
    categories: scopeMapping.categories,
  });

  if (!output.ok) {
    const retryable = output.retryable;
    const retryAfter = output.retryAfterSeconds;
    const errorDetail = retryable
      ? `${output.error} (retryable, retryAfter=${retryAfter ?? 60}s)`
      : output.error;
    return {
      error: `Research search failed: ${errorDetail}`,
      data: {
        retryable,
        ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}),
        error: output.error,
      },
    };
  }

  const bundle = buildEvidenceBundle({
    input,
    rawResults: output.results,
    profile: profileResolution.profile,
    retrievedAt: output.retrievedAt,
    rawEngine: {
      name: "script",
      baseUrl: config.scriptCommand,
      upstreamVersion: output.engine.upstreamVersion,
      patchVersion: output.engine.patchVersion,
    },
    warnings: [...profileResolution.warnings, ...scopeMapping.warnings],
  });

  return {
    content: `Research search completed for "${query}" via script backend: ${bundle.sources.length} sources, ${bundle.warnings.length} warnings. Use \`data.sources\`, \`data.warnings\`, and \`data.gaps\` for synthesis; do not treat this as final analysis.`,
    data: bundle,
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginContext = ctx;
    ctx.logger.info(`${PLUGIN_ID} plugin starting up`);

    ctx.tools.register(
      TOOL_NAMES.researchSearch,
      {
        displayName: "Research Search",
        description:
          "Search the web for information and return structured evidence bundles with sources, summaries, and relevance scores.",
        parametersSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to execute",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (1-25)",
            },
          },
          required: ["query"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> =>
        handleResearchSearch(ctx, params, runCtx),
    );
  },

  async onHealth() {
    return computeResearchHealth();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
