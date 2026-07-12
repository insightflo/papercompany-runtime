export const MISSION_SEARCH_SCOPES = [
  "workProduct",
  "missionOutput",
  "repo",
  "logs",
  "config",
] as const;

export type MissionSearchScope = (typeof MISSION_SEARCH_SCOPES)[number];

const SCOPE_SET = new Set<string>(MISSION_SEARCH_SCOPES);
const DEFAULT_SCOPES: readonly MissionSearchScope[] = ["workProduct", "missionOutput"];

export function normalizeMissionSearchScopes(value: unknown): MissionSearchScope[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const scopes = raw
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry): entry is MissionSearchScope => SCOPE_SET.has(entry));
  return Array.from(new Set(scopes));
}

export function defaultMissionSearchScopes(): MissionSearchScope[] {
  return [...DEFAULT_SCOPES];
}

export function missionSearchScopesAllowRepo(scopes: readonly MissionSearchScope[]): boolean {
  return scopes.includes("repo");
}

export function buildMissionSearchGuidance(scopes: readonly MissionSearchScope[]): string[] {
  const scopeText = scopes.length > 0 ? scopes.join(", ") : "none";
  return [
    `Mission search scopes: ${scopeText}.`,
    "Use missionSearch/scoped search for discovery before raw shell scans.",
    "If repo scope is absent, read only declared workProduct, dependency, output, log, or config paths.",
    "If repo scope is present, repository-wide discovery is allowed for development work.",
  ];
}
