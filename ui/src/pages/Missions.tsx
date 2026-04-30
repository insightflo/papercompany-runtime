import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { missionsApi, type MissionStatus, type MissionListFilters } from "../api/missions";
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

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const SORT_OPTIONS = [
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "createdAt:desc", label: "Recently created" },
  { value: "title:asc", label: "Title A-Z" },
  { value: "title:desc", label: "Title Z-A" },
  { value: "status:asc", label: "Status" },
] as const;

function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

function formatLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function Missions() {
  const { selectedCompanyId } = useCompany();
  const { openNewMission } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const statusFilter = (searchParams.get("status") as MissionStatus | null) ?? "all";
  const ownerAgentId = searchParams.get("ownerAgentId") ?? "all";
  const sortBy = (searchParams.get("sortBy") as MissionListFilters["sortBy"]) ?? "updatedAt";
  const sortOrder = (searchParams.get("sortOrder") as MissionListFilters["sortOrder"]) ?? "desc";
  const defaultDate = formatLocalDateInputValue(new Date());
  const from = searchParams.get("from") ?? defaultDate;
  const to = searchParams.get("to") ?? defaultDate;
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 25);
  const page = parsePositiveInt(searchParams.get("page"), 1);

  useEffect(() => {
    setBreadcrumbs([{ label: "Missions" }]);
  }, [setBreadcrumbs]);

  const missionFilters = useMemo<MissionListFilters>(() => ({
    status: statusFilter !== "all" ? statusFilter : undefined,
    ownerAgentId: ownerAgentId !== "all" ? ownerAgentId : undefined,
    from: from || undefined,
    to: to || undefined,
    sortBy,
    sortOrder,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  }), [from, ownerAgentId, page, pageSize, sortBy, sortOrder, statusFilter, to]);

  const { data: missions, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!, missionFilters),
    queryFn: () => missionsApi.list(selectedCompanyId!, missionFilters),
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

  const hasPreviousPage = page > 1;
  const hasNextPage = (missions?.length ?? 0) >= pageSize;
  const currentSortValue = `${sortBy}:${sortOrder}`;

  const updateSearchParams = (updates: Record<string, string | null>, options?: { resetPage?: boolean }) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (!value || value === "all") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }

    if (options?.resetPage) {
      params.delete("page");
    }

    setSearchParams(params);
  };

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

      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-3">
          <div className="flex items-center gap-1 flex-wrap">
            {STATUS_TABS.map((tab) => (
              <Button
                key={tab.value}
                size="sm"
                variant={statusFilter === tab.value ? "default" : "ghost"}
                onClick={() => updateSearchParams({ status: tab.value === "all" ? null : tab.value }, { resetPage: true })}
                className="h-7 text-xs"
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Main executor</span>
              <select
                value={ownerAgentId}
                onChange={(e) => updateSearchParams({ ownerAgentId: e.target.value === "all" ? null : e.target.value }, { resetPage: true })}
                className="h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                <option value="all">All executors</option>
                {(agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Created from</span>
              <input
                type="date"
                value={from}
                onChange={(e) => updateSearchParams({ from: e.target.value || null }, { resetPage: true })}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>to</span>
              <input
                type="date"
                value={to}
                onChange={(e) => updateSearchParams({ to: e.target.value || null }, { resetPage: true })}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Sort</span>
              <select
                value={currentSortValue}
                onChange={(e) => {
                  const [nextSortBy, nextSortOrder] = e.target.value.split(":");
                  updateSearchParams(
                    {
                      sortBy: nextSortBy,
                      sortOrder: nextSortOrder,
                    },
                    { resetPage: true },
                  );
                }}
                className="h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Page size</span>
              <select
                value={String(pageSize)}
                onChange={(e) => updateSearchParams({ pageSize: e.target.value }, { resetPage: true })}
                className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>{option}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <Button size="sm" variant="outline" onClick={openNewMission}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Mission
        </Button>
      </div>

      {missions && missions.length === 0 && (
        <EmptyState
          icon={Rocket}
          message="No missions match the current filters."
          action="Create Mission"
          onAction={openNewMission}
        />
      )}

      {missions && missions.length > 0 && (
        <>
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
                    Main executor: {agentMap[mission.ownerAgentId] ?? "—"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(mission.createdAt)}
                  </span>
                </Link>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              Page {page}
              {missionFilters.offset !== undefined && missionFilters.limit !== undefined
                ? ` • Showing ${missionFilters.offset + 1}-${missionFilters.offset + (missions?.length ?? 0)}`
                : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!hasPreviousPage}
                onClick={() => updateSearchParams({ page: String(page - 1) })}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasNextPage}
                onClick={() => updateSearchParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
