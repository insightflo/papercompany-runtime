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

export function buildMissionSearchGuidance(
  scopes: readonly MissionSearchScope[],
  options?: { broadScanRepoAllowed?: boolean },
): string[] {
  if (scopes.length === 0) {
    return [
      "missionSearch is unavailable because this run has no declared search scope.",
      "Do not scan the workspace or repository root. Request or use declared mission workProduct paths instead.",
    ];
  }
  const broadScanRepoAllowed = options?.broadScanRepoAllowed ?? scopes.includes("repo");
  const exampleScope = scopes[0] ?? "workProduct";
  const scopeText = scopes.length > 0 ? scopes.join(", ") : "none";
  return [
    `Mission search scopes allowed this run: ${scopeText}.`,
    broadScanRepoAllowed
      ? `Raw repo-wide rg/find/git-ls-files/tree/ls -R are permitted by the runtime guard (repo broad-scan allowed); missionSearch is still preferred for structured, scope-limited discovery.`
      : `Raw pathless rg/find/git-ls-files/tree/ls -R are blocked by the runtime guard; use the missionSearch API instead.`,
    `missionSearch API (callable): curl -sS -X POST "$PAPERCLIP_API_BASE_URL/agents/me/mission-search" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d "{\"scope\":\"${exampleScope}\",\"query\":\"\",\"runContext\":{\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"runId\":\"$PAPERCLIP_RUN_ID\",\"companyId\":\"$PAPERCLIP_COMPANY_ID\"}}"`,
    `Query semantics: send \"query\":\"\" (or omit) to list every entry for the scope (discovery); send a single name fragment to locate one file; multiple space-separated names are matched as OR (any match returned).`,
    `Scope semantics — workProduct: declared dependency files/dirs; missionOutput: the run output dir; repo${scopes.includes("repo") ? "" : " (NOT allowed this run)"}: repository-wide text search via the missionSearch API; logs: this run's event log; config: config-like declared paths. Change "scope" to one of the allowed scopes listed above.`,
  ];
}
