import { useEffect, useState } from "react";
import { Link } from "../lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RefreshCw, UserRoundCheck } from "lucide-react";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { missionsApi, type MissionHumanOperatorRequest } from "../api/missions";
import { operatorDecisionsApi, type ResolveOperatorDecisionInput } from "../api/operator-decisions";
import { ExternalAutomationApprovals } from "../components/ExternalAutomationApprovals";
import { EmptyState } from "../components/EmptyState";
import { OperatorDecisionCard } from "../components/OperatorDecisionCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

function formatRequestTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function missionLink(request: MissionHumanOperatorRequest): string {
  const query = request.issueId ? `?issue=${encodeURIComponent(request.issueId)}` : "";
  return `/missions/${request.missionId}${query}`;
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
          <div>
            <h2 className="text-sm font-semibold text-foreground">{request.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{request.summary}</p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>Mission: {request.missionTitle}</span>
            <span>Issue: {request.issueId ? request.issueId.slice(0, 8) : "mission"}</span>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
          <Link to={missionLink(request)}>Open mission<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
        </Button>
      </div>
    </li>
  );
}

function humanize(value: string | null) {
  return value ? value.replace(/_/g, " ") : "unknown continuation error";
}
export function isContinuationRetryEligible(decision: OperatorDecisionView) {
  const continuation = decision.continuation;
  if (!continuation || continuation.manualRetryCount >= continuation.maxManualRetries) return false;
  if (continuation.state === "exhausted") return true;
  if (continuation.state === "blocked") {
    return continuation.errorCode === "issue_unassigned" || continuation.errorCode === "issue_terminal";
  }
  return ["skipped", "failed", "cancelled", "timed_out", "assignee_changed"]
    .includes(continuation.effectiveStatus);
}

function ContinuationAttention({
  decision,
  onRetry,
}: {
  decision: OperatorDecisionView;
  onRetry: (decision: OperatorDecisionView) => Promise<void>;
}) {
  const continuation = decision.continuation!;
  const [retryError, setRetryError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const retryable = isContinuationRetryEligible(decision);

  async function retry() {
    setRetryError(null);
    setIsRetrying(true);
    try {
      await onRetry(decision);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "Failed to retry this continuation.");
    } finally {
      setIsRetrying(false);
    }
  }
  return (
    <li className="border border-destructive/40 bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">{decision.title}</h3>
          <p className="mt-1 text-sm text-destructive">{humanize(continuation.errorCode)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {continuation.effectiveStatus} · generation {continuation.generation} · attempt {continuation.attemptCount}
          </p>
        </div>
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" disabled={!retryable || isRetrying} onClick={() => void retry()}>
            {isRetrying ? "Retrying…" : "Retry continuation"}
          </Button>
          {retryError && <p role="alert" className="text-xs text-destructive">{retryError}</p>}
        </div>
      </div>
    </li>
  );
}

export function focusOperatorDecisionSuccessTarget(root: ParentNode = document) {
  const target = root.querySelector<HTMLElement>(
    "[data-operator-decision-heading], [data-operator-decision-attention-heading], [data-human-operator-empty-heading]",
  );
  target?.focus();
}

export function HumanOperator() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [focusAfterSuccess, setFocusAfterSuccess] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: "Human Operator" }]), [setBreadcrumbs]);

  const requestsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.missions.humanOperatorRequests(selectedCompanyId) : ["missions", "human-operator-requests"],
    queryFn: () => missionsApi.listHumanOperatorRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const pendingQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.operatorDecisions.list(selectedCompanyId, "pending") : ["operator-decisions", "pending"],
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const attentionQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.operatorDecisions.list(selectedCompanyId, "attention") : ["operator-decisions", "attention"],
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "attention"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!focusAfterSuccess) return;
    const frame = requestAnimationFrame(() => {
      focusOperatorDecisionSuccessTarget();
      setFocusAfterSuccess(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAfterSuccess, pendingQuery.data, attentionQuery.data, requestsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserRoundCheck} message="Select a company to view human operator requests." />;
  }
  if (requestsQuery.isLoading || pendingQuery.isLoading || attentionQuery.isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const requests = requestsQuery.data ?? [];
  const pending = pendingQuery.data?.data ?? [];
  const attention = attentionQuery.data?.data ?? [];
  const actionableCount = requests.length + pending.length;
  const error = requestsQuery.error ?? pendingQuery.error ?? attentionQuery.error;
  const isFetching = requestsQuery.isFetching || pendingQuery.isFetching || attentionQuery.isFetching;

  async function refreshDecisionSurfaces() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "attention") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId!) }),
    ]);
    setFocusAfterSuccess(true);
  }

  async function resolveDecision(id: string, input: ResolveOperatorDecisionInput) {
    await operatorDecisionsApi.resolve(id, input);
    await refreshDecisionSurfaces();
  }

  async function retryContinuation(decision: OperatorDecisionView) {
    await operatorDecisionsApi.retryContinuation(decision.id);
    await refreshDecisionSurfaces();
  }

  async function refreshAll() {
    await Promise.all([requestsQuery.refetch(), pendingQuery.refetch(), attentionQuery.refetch()]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Human Operator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Structured decisions, mission escalations, and input requests needing operator attention.
          </p>
          <p className="mt-1 text-xs font-medium text-foreground">{actionableCount} actionable</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error && <div className="flex items-center gap-2 border border-destructive/40 p-3 text-sm text-destructive" role="alert">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{error instanceof Error ? error.message : "Failed to load Human Operator work."}</span>
      </div>}

      <section aria-labelledby="interactive-cards-heading" className="space-y-2">
        <h2 id="interactive-cards-heading" className="text-base font-semibold">Pending Interactive Cards</h2>
        {pending.map((decision) => <OperatorDecisionCard key={decision.id} decision={decision} onResolve={resolveDecision} />)}
      </section>

      {attention.length > 0 && <section aria-labelledby="continuation-attention-heading" className="space-y-2">
        <h2 id="continuation-attention-heading" data-operator-decision-attention-heading tabIndex={-1} className="text-base font-semibold">
          Continuations needing attention
        </h2>
        <ul className="space-y-2">{attention.map((decision) => (
          <ContinuationAttention key={decision.id} decision={decision} onRetry={retryContinuation} />
        ))}</ul>
      </section>}

      <ExternalAutomationApprovals />

      {requests.length > 0 ? <ul className="space-y-2">{requests.map((request) => (
        <HumanOperatorRow key={request.id} request={request} />
      ))}</ul> : pending.length === 0 && attention.length === 0 ? (
        <h2 data-human-operator-empty-heading tabIndex={-1} className="text-sm font-medium">No open human operator requests.</h2>
      ) : null}
    </div>
  );
}
