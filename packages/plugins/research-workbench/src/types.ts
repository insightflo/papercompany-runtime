export type ImplementedResearchProfileName = "general" | "tech_scout";
export type FutureResearchProfileName = "academic" | "market" | "policy";
export type ResearchProfileName = ImplementedResearchProfileName | FutureResearchProfileName;

export type SourceScope = "web" | "discussions" | "academic";

export type SourceType =
  | "official_doc"
  | "github"
  | "paper"
  | "discussion"
  | "news"
  | "web"
  | "unknown";

export type DateCoverage = "unknown" | "sparse" | "good";

export type FreshnessPreference = "any" | "recent_preferred" | "recent_required";

export interface ResearchSearchInput {
  query: string;
  profile?: ResearchProfileName;
  futureProfile?: FutureResearchProfileName;
  sourceScope?: SourceScope[];
  maxResults?: number;
  domainHints?: string[];
  excludeDomains?: string[];
  freshness?: FreshnessPreference;
}

export interface ResearchProfileDefinition {
  name: ImplementedResearchProfileName;
  minSources: number;
  sourceScope: SourceScope[];
}

export interface ProfileResolution {
  requestedProfile?: ResearchProfileName;
  profile: ResearchProfileDefinition;
  warnings: string[];
}

export interface SourceScopeMapping {
  categories: string[];
  warnings: string[];
}

export interface VaneHeadlessSearchInput {
  query: string;
  categories?: string[];
  engines?: string[];
  language?: string;
  page?: number;
  maxResults?: number;
}

export interface VaneHeadlessSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string | null;
  raw?: Record<string, unknown>;
}

export type DirectWebProviderName = "exa-mcp" | "duckduckgo";

export type DirectWebProviderFailureReason =
  | "auth_required"
  | "empty_results"
  | "http_error"
  | "network_error"
  | "protocol_error"
  | "response_too_large"
  | "timeout";

export interface DirectWebProviderAttempt {
  provider: DirectWebProviderName;
  status: "ok" | "error";
  reason?: DirectWebProviderFailureReason;
  detail?: string;
}

export type ResearchSearchEngineName = "direct-web" | "vane-headless" | "script";

export interface VaneHeadlessSearchEngineInfo {
  name: ResearchSearchEngineName;
  provider?: DirectWebProviderName;
  attempts?: DirectWebProviderAttempt[];
  upstreamVersion?: string;
  patchVersion?: string;
}

export type VaneHeadlessSearchOutput =
  | {
      ok: true;
      query: string;
      results: VaneHeadlessSearchResult[];
      suggestions?: string[];
      engine: VaneHeadlessSearchEngineInfo;
      retrievedAt: string;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      engine: VaneHeadlessSearchEngineInfo;
      retrievedAt: string;
    };

export interface EvidenceSource {
  title: string;
  url: string;
  snippet: string;
  sourceType: SourceType;
  retrievedAt: string;
  claimRelevance?: string;
}

export interface EvidenceBundle {
  topic: string;
  query: string;
  profile: ImplementedResearchProfileName;
  sources: EvidenceSource[];
  warnings: string[];
  gaps: string[];
  qa: {
    sourceCount: number;
    minSources: number;
    passedMinSources: boolean;
    duplicateUrlsRemoved: number;
    uniqueDomains: number;
    dateCoverage: DateCoverage;
  };
  rawEngine: {
    name: ResearchSearchEngineName;
    provider?: DirectWebProviderName;
    attempts?: DirectWebProviderAttempt[];
    upstreamVersion?: string;
    patchVersion?: string;
    baseUrl: string;
  };
}

export interface BuildEvidenceBundleInput {
  topic?: string;
  input: ResearchSearchInput;
  rawResults: VaneHeadlessSearchResult[];
  profile: ResearchProfileDefinition;
  retrievedAt: string;
  rawEngine: EvidenceBundle["rawEngine"];
  warnings?: string[];
}
