import type { AdapterModel } from "../api/agents";

export function getCustomModelCandidate(models: AdapterModel[], search: string): string | null {
  const candidate = search.trim();
  if (!candidate) return null;
  const normalized = candidate.toLowerCase();
  const duplicate = models.some(
    (model) => model.id.toLowerCase() === normalized || model.label.toLowerCase() === normalized,
  );
  return duplicate ? null : candidate;
}
