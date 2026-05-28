import {
  definePlugin,
  runWorker,
  type PluginContext,
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
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface InstanceConfig {
  backend: "vane-headless";
  vaneBaseUrl: string;
  defaultMaxResults: number;
  timeoutMs: number;
}

function resolveConfig(raw: Record<string, unknown>): InstanceConfig {
  const backend = typeof raw.backend === "string" ? raw.backend : "";
  const vaneBaseUrl = typeof raw.vaneBaseUrl === "string" ? raw.vaneBaseUrl : "";
  const rawMax = typeof raw.defaultMaxResults === "number" ? raw.defaultMaxResults : DEFAULT_MAX_RESULTS;
  const rawTimeout = typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    backend: backend as InstanceConfig["backend"],
    vaneBaseUrl,
    defaultMaxResults: Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, rawMax)),
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawTimeout)),
  };
}

// ---------------------------------------------------------------------------
// Vane headless adapter integration
// ---------------------------------------------------------------------------

let vaneAdapter: ReturnType<typeof createVaneHeadlessAdapter> | null = null;

function getOrCreateVaneAdapter(
  ctx: PluginContext,
  config: InstanceConfig,
): ReturnType<typeof createVaneHeadlessAdapter> {
  if (!vaneAdapter) {
    vaneAdapter = createVaneHeadlessAdapter({
      vaneBaseUrl: config.vaneBaseUrl,
      timeoutMs: config.timeoutMs,
      http: ctx.http,
    });
  }
  return vaneAdapter;
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

  if (!config.backend || !config.vaneBaseUrl) {
    return { error: "Plugin instance config is missing required fields: backend, vaneBaseUrl" };
  }

  const maxResults = typeof p.maxResults === "number"
    ? Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, p.maxResults))
    : config.defaultMaxResults;

  // Determine which adapter path to use
  if (config.backend === "vane-headless" && !adapterOverridden) {
    return handleVaneHeadlessSearch(ctx, config, query, maxResults);
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

async function handleVaneHeadlessSearch(
  ctx: PluginContext,
  config: InstanceConfig,
  query: string,
  maxResults: number,
): Promise<ToolResult> {
  const vane = getOrCreateVaneAdapter(ctx, config);

  const searchInput: ResearchSearchInput = { query, maxResults };
  const profileResolution = resolveResearchProfile(searchInput);
  const scopeMapping = resolveSourceScopeCategories(
    profileResolution.profile.sourceScope,
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
    const retryAfter = (output as any).retryAfterSeconds;
    const errorDetail = retryable
      ? `${output.error} (retryable, retryAfter=${retryAfter ?? 60}s)`
      : output.error;
    return { error: `Research search failed: ${errorDetail}` };
  }

  // Build the evidence bundle from raw Vane results
  const retrievedAt = output.retrievedAt;
  const bundle = buildEvidenceBundle({
    input: searchInput,
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

  return {
    content: JSON.stringify(bundle, null, 2),
    data: bundle,
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
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
    // B1: only check config shape, do not require Vane running
    return { status: "ok", message: "Research Workbench worker is alive (B1 skeleton)" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
