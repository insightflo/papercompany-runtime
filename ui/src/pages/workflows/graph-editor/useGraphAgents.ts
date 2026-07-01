import { useEffect, useState } from "react";
import { useCompany } from "../../../context/CompanyContext";
import { apiBaseUrl } from "../workflow-page-api.js";

export type GraphAgent = { id: string; name: string };

export function useGraphAgents(): GraphAgent[] {
  const { selectedCompanyId: graphCompanyId } = useCompany();
  const [graphAgents, setGraphAgents] = useState<GraphAgent[]>([]);
  useEffect(() => {
    const cid = graphCompanyId ?? "";
    if (!cid.trim()) return;
    let cancelled = false;
    fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(cid)}/agents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return;
        setGraphAgents(
          data
            .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
            .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [graphCompanyId]);
  return graphAgents;
}
