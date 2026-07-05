import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RefreshCw, UserRoundCheck } from "lucide-react";
import { missionsApi, type MissionHumanOperatorRequest } from "../api/missions";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

function formatRequestTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function missionLink(request: MissionHumanOperatorRequest): string {
  const query = request.issueId ? `?issue=${encodeURIComponent(request.issueId)}` : "";
  return `/missions/${request.missionId}${query}`;
}

function issueLabel(request: MissionHumanOperatorRequest): string {
  return request.issueId ? request.issueId.slice(0, 8) : "mission";
}

function HumanOperatorRow({ request }: { request: MissionHumanOperatorRequest }) {
  return (
    <li className="border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={request.severity ?? "attention"} />
            <StatusBadge status={request.missionStatus} />
            <span className="text-xs text-muted-foreground">{formatRequestTime(request.timestamp)}</span>
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{request.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{request.summary}</p>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">Mission: {request.missionTitle}</span>
            <span>Issue: {issueLabel(request)}</span>
          </div>
        </div>

        <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
          <Link to={missionLink(request)}>
            Open mission
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function HumanOperator() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Human Operator" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.missions.humanOperatorRequests(selectedCompanyId) : ["missions", "human-operator-requests"],
    queryFn: () => missionsApi.listHumanOperatorRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={UserRoundCheck} message="Select a company to view human operator requests." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const requests = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Human Operator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mission owner escalations and input requests that need operator attention.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 border border-destructive/40 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error instanceof Error ? error.message : "Failed to load human operator requests."}</span>
        </div>
      )}

      {requests.length === 0 ? (
        <EmptyState icon={UserRoundCheck} message="No open human operator requests." />
      ) : (
        <ul className="space-y-2">
          {requests.map((request) => (
            <HumanOperatorRow key={request.id} request={request} />
          ))}
        </ul>
      )}
    </div>
  );
}
