import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents.js";
import { queryKeys } from "../lib/queryKeys.js";
import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Fetch the model list for a single OpenCode provider via the provider-filtered
 * discovery endpoint (`opencode models <provider>`).
 *
 * A full scan (`opencode models`) intermittently drops providers when auth.json
 * contains many providers. Scanning a single provider is reliable, so the
 * opencode_local config UI lists providers from the full list, then loads each
 * provider's models through this filtered query.
 *
 * The query is disabled unless a provider is selected. Callers fall back to an
 * empty list while loading.
 */
export function useAdapterProviderModels(
  companyId: string | null | undefined,
  adapterType: string | null | undefined,
  provider: string | null | undefined,
) {
  const enabled =
    Boolean(companyId) &&
    adapterType === "opencode_local" &&
    Boolean(provider && provider.trim());
  return useQuery<AdapterModel[]>({
    queryKey:
      companyId && adapterType && provider
        ? queryKeys.agents.adapterProviderModels(companyId, adapterType, provider)
        : ["agents", "none", "adapter-provider-models", "none", "none"],
    queryFn: () => agentsApi.adapterModels(companyId!, adapterType!, provider!),
    enabled,
    staleTime: 60_000,
  });
}
