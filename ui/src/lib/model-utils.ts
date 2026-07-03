export function extractProviderId(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed.includes("/")) return null;
  const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
  return provider || null;
}

export function extractProviderIdWithFallback(
  modelId: string | null | undefined,
  fallback = "other",
): string {
  return extractProviderId(modelId) ?? fallback;
}

export function extractModelName(modelId: string | null | undefined): string {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed.includes("/")) return trimmed;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim();
}

export interface ModelEntryLike {
  readonly id: string;
  readonly label: string;
}

export interface ModelProviderOption {
  readonly id: string;
  readonly label: string;
  readonly modelCount: number;
}

export function listModelProviders(
  models: readonly ModelEntryLike[],
): ModelProviderOption[] {
  const counts = new Map<string, number>();
  for (const model of models) {
    const provider = extractProviderId(model.id);
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, modelCount]) => ({
      id: provider,
      label: provider,
      modelCount,
    }));
}

export function filterModelsByProvider(
  models: readonly ModelEntryLike[],
  provider: string,
): ModelEntryLike[] {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) return [...models];
  return models.filter((model) => extractProviderId(model.id) === normalizedProvider);
}

export function resolveProviderModelSelection(
  models: readonly ModelEntryLike[],
  provider: string,
  currentModelId: string | null | undefined,
): string {
  const providerModels = filterModelsByProvider(models, provider);
  if (providerModels.length === 0) return "";

  const currentModelName = extractModelName(currentModelId);
  const existing = providerModels.find(
    (model) =>
      model.id === currentModelId ||
      extractModelName(model.id) === currentModelName,
  );
  return existing?.id ?? providerModels[0]?.id ?? "";
}
