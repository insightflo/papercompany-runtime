import type {
  FutureResearchProfileName,
  ProfileResolution,
  ResearchProfileDefinition,
  ResearchProfileName,
  ResearchSearchInput,
  SourceScope,
  SourceScopeMapping,
} from "./types.js";

export const RESEARCH_PROFILES = {
  general: {
    name: "general",
    minSources: 3,
    sourceScope: ["web"],
  },
  tech_scout: {
    name: "tech_scout",
    minSources: 5,
    sourceScope: ["web", "discussions"],
  },
} as const satisfies Record<string, ResearchProfileDefinition>;

const FUTURE_PROFILES = new Set<FutureResearchProfileName>(["academic", "market", "policy"]);
const IMPLEMENTED_PROFILES = new Set<ResearchProfileName>(["general", "tech_scout"]);

export function isFutureProfile(value: unknown): value is FutureResearchProfileName {
  return typeof value === "string" && FUTURE_PROFILES.has(value as FutureResearchProfileName);
}

export function resolveResearchProfile(input: Pick<ResearchSearchInput, "profile" | "futureProfile">): ProfileResolution {
  const warnings: string[] = [];
  const requested = input.futureProfile ?? input.profile;

  if (input.futureProfile) {
    if (input.profile === "tech_scout") {
      warnings.push(
        `futureProfile '${input.futureProfile}' is reserved for a future Research Workbench slice; using explicitly requested tech_scout profile`,
      );
      return { requestedProfile: input.futureProfile, profile: RESEARCH_PROFILES.tech_scout, warnings };
    }

    warnings.push(
      `profile '${input.futureProfile}' is reserved for a future Research Workbench slice; falling back to general`,
    );
    return { requestedProfile: input.futureProfile, profile: RESEARCH_PROFILES.general, warnings };
  }

  if (input.profile === "tech_scout") {
    return { requestedProfile: input.profile, profile: RESEARCH_PROFILES.tech_scout, warnings };
  }

  if (input.profile === "general" || input.profile === undefined) {
    return { requestedProfile: input.profile, profile: RESEARCH_PROFILES.general, warnings };
  }

  if (isFutureProfile(input.profile)) {
    warnings.push(
      `profile '${input.profile}' is reserved for a future Research Workbench slice; falling back to general`,
    );
    return { requestedProfile: input.profile, profile: RESEARCH_PROFILES.general, warnings };
  }

  if (typeof input.profile === "string" && !IMPLEMENTED_PROFILES.has(input.profile)) {
    warnings.push(`profile '${input.profile}' is not implemented; falling back to general`);
  }

  return { requestedProfile: requested, profile: RESEARCH_PROFILES.general, warnings };
}

export interface ResolveSourceScopeOptions {
  discussionsSupported?: boolean;
}

export function resolveSourceScopeCategories(
  scopes: readonly SourceScope[] | undefined,
  options: ResolveSourceScopeOptions = {},
): SourceScopeMapping {
  const effectiveScopes = scopes && scopes.length > 0 ? scopes : RESEARCH_PROFILES.general.sourceScope;
  const categories = new Set<string>();
  const warnings: string[] = [];

  for (const scope of effectiveScopes) {
    if (scope === "web") {
      categories.add("general");
      continue;
    }

    if (scope === "discussions") {
      if (options.discussionsSupported) {
        categories.add("social media");
      } else {
        categories.add("general");
        warnings.push(
          "sourceScope 'discussions' is not declared as supported by the current backend; using general web search instead",
        );
      }
      continue;
    }

    if (scope === "academic") {
      categories.add("general");
      warnings.push(
        "sourceScope 'academic' is reserved until a stable Vane/SearxNG academic mapping is proven; academic search was not performed",
      );
      continue;
    }

    categories.add("general");
    warnings.push(`sourceScope '${String(scope)}' is not implemented; using general web search instead`);
  }

  if (categories.size === 0) {
    categories.add("general");
  }

  return { categories: [...categories], warnings };
}
