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
  const repoAllowed = scopes.includes("repo");
  const exampleScope = scopes[0] ?? "workProduct";
  const scopeText = scopes.length > 0 ? scopes.join(", ") : "none";
  return [
    `Mission search scopes allowed this run: ${scopeText}.`,
    repoAllowed
      ? `Raw repo-wide rg/find/git-ls-files/tree/ls -R are permitted by the runtime guard (repo scope allowed); missionSearch is still preferred for structured, scope-limited discovery.`
      : `Raw pathless rg/find/git-ls-files/tree/ls -R are blocked by the runtime guard (no repo scope); use the missionSearch tool instead.`,
    `missionSearch (callable): curl -sS -X POST "$PAPERCLIP_API_BASE_URL/agents/me/mission-search" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d "{\"scope\":\"${exampleScope}\",\"query\":\"<your search text>\",\"runContext\":{\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"runId\":\"$PAPERCLIP_RUN_ID\",\"companyId\":\"$PAPERCLIP_COMPANY_ID\"}}"`,
    `Scope semantics — workProduct: declared dependency files/dirs; missionOutput: the run output dir; repo${repoAllowed ? "" : " (NOT allowed this run)"}: repository-wide text search; logs: this run's event log; config: config-like declared paths. Change "scope" to one of the allowed scopes listed above.`,
  ];
}
