import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents.js";
import { queryKeys } from "../lib/queryKeys.js";

/**
 * Fetch the supported reasoning-effort levels for a specific Command Code model.
 *
 * Only commandcode_local exposes per-model effort discovery. Other adapters
 * pass an empty adapterType, which disables the query. The hook returns the raw
 * effort string[] (e.g. ["low","medium","high","max"]) — callers wrap it with
 * the "Auto" (no-override) option via buildCommandCodeEffortOptions.
 *
 * Returns `isSuccess` so callers can distinguish "still loading / disabled"
 * (data undefined, isSuccess false) from "loaded and genuinely empty"
 * (data [], isSuccess true). This prevents prematurely clearing a valid effort
 * selection while the query is in flight.
 */
export function useAdapterModelEfforts(
  companyId: string | null | undefined,
  adapterType: string | null | undefined,
  model: string | null | undefined,
) {
  const enabled =
    Boolean(companyId) &&
    adapterType === "commandcode_local" &&
    Boolean(model && model.trim());
  return useQuery({
    queryKey:
      companyId && adapterType && model
        ? queryKeys.agents.adapterModelEfforts(companyId, adapterType, model)
        : ["agents", "none", "adapter-model-efforts", "none", "none"],
    queryFn: () => agentsApi.adapterModelEfforts(companyId!, adapterType!, model!),
    enabled,
    staleTime: 300_000,
  });
}
