import { useEffect } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { missionsApi, type MissionStatus } from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { Rocket, Plus } from "lucide-react";

const STATUS_TABS: { label: string; value: MissionStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Planning", value: "planning" },
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
];

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function Missions() {
  const { selectedCompanyId } = useCompany();
  const { openNewMission } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const statusFilter = (searchParams.get("status") as MissionStatus | null) ?? "all";

  useEffect(() => {
    setBreadcrumbs([{ label: "Missions" }]);
  }, [setBreadcrumbs]);

  const { data: missions, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!),
    queryFn: () =>
      missionsApi.list(selectedCompanyId!, {
        status: statusFilter !== "all" ? statusFilter : undefined,
      }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a company to view missions." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Status filter tabs */}
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.value}
              size="sm"
              variant={statusFilter === tab.value ? "default" : "ghost"}
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                if (tab.value === "all") {
                  params.delete("status");
                } else {
                  params.set("status", tab.value);
                }
                setSearchParams(params);
              }}
              className="h-7 text-xs"
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {/* New Mission button */}
        <Button size="sm" variant="outline" onClick={openNewMission}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Mission
        </Button>
      </div>

      {/* Empty state */}
      {missions && missions.length === 0 && (
        <EmptyState
          icon={Rocket}
          message="No missions yet."
          action="Create Mission"
          onAction={openNewMission}
        />
      )}

      {/* Mission list */}
      {missions && missions.length > 0 && (
        <div className="border border-border">
          {missions.map((mission) => (
            <div
              key={mission.id}
              className="flex items-center gap-3 px-4 py-3 text-sm border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors"
            >
              <Link
                to={`/missions/${mission.id}`}
                className="flex-1 flex items-center gap-3 min-w-0 no-underline text-inherit hover:no-underline"
              >
                <Rocket className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate font-medium">{mission.title}</span>
                <StatusBadge status={mission.status} />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agentMap[mission.ownerAgentId] ?? "—"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(mission.createdAt)}
                </span>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
