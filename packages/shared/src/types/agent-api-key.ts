export type AgentApiKeyScope =
  | { kind: "standard" }
  | { kind: "skill_test"; issueId: string };

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "standard" };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "skill_test" && typeof candidate.issueId === "string" && candidate.issueId.trim()) {
    return { kind: "skill_test", issueId: candidate.issueId.trim() };
  }
  return { kind: "standard" };
}
