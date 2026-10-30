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
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import {
  selectHumanOperatorSurface,
  type HumanOperatorLifecycle,
  type HumanOperatorScope,
  type HumanOperatorSurfaceSection,
} from "../lib/human-operator-surface";

function formatRequestTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function missionLink(request: MissionHumanOperatorRequest): string {
  const query = request.issueId ? `?issue=${encodeURIComponent(request.issueId)}` : "";
  return `/missions/${request.missionId}${query}`;
}

function HumanOperatorRow({
  request,
  card,
  resolvedCard,
  scope,
  onResolve,
}: {
  request: MissionHumanOperatorRequest;
  card: OperatorDecisionView | null;
  resolvedCard: OperatorDecisionView | null;
  scope: HumanOperatorScope;
  onResolve: (decisionId: string, input: ResolveOperatorDecisionInput) => Promise<unknown>;
}) {
  const lang = useCompanyLanguage();
  // [C4 상태 일치] pending 카드는 행 안에서 인터랙티브로 resolve 하고, 해결·취소된 카드는 이력 상태 배지로,
  // 카드가 없는(Stage 1 이전 과거) 행은 카드 없음 배지로 표시한다.
  const cardStatusBadge = card
    ? null
    : resolvedCard
      ? resolvedCard.status === "resolved"
        ? L(lang, { en: "Resolved", ko: "해결됨" })
        : L(lang, { en: "Cancelled", ko: "취소됨" })
      : L(lang, { en: "No card", ko: "카드 없음" });
  return (
    <li data-human-operator-lifecycle={scope.lifecycle} className="border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={request.severity ?? "attention"} />
            <StatusBadge status={scope.missionStatus ?? "unknown"} />
            {cardStatusBadge && (
              <span data-human-input-card-badge className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {cardStatusBadge}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{formatRequestTime(request.timestamp)}</span>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{request.title}</h2>
            {/* 요약은 서버가 구조화한 다중 줄바꿈 텍스트(무엇이/왜 막힘/할 일)다. */}
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{request.summary}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
          <Link to={missionLink(request)}>{L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
        </Button>
      </div>
      {card && (
        <div className="mt-3 border-t border-border pt-3">
          <OperatorDecisionCard decision={card} onResolve={onResolve} />
        </div>
      )}
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
  const lang = useCompanyLanguage();
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
  const missionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.missions.list(selectedCompanyId) : ["missions"],
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const pendingQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.operatorDecisions.list(selectedCompanyId, "pending") : ["operator-decisions", "pending"],
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  // [2026-10-20 운영자 승인] resolved/cancelled 이력(attention·history 뷰)은 가져오지 않는다.
  // 두 뷰가 회사 전체 카드를 N+1로 로드해 페이지를 2.5s+ 지연시켰고 표시 대상도 아니었다.
  // 활성(pending) 카드와 요청 행만 조회한다.

  useEffect(() => {
    if (!focusAfterSuccess) return;
    const frame = requestAnimationFrame(() => {
      focusOperatorDecisionSuccessTarget();
      setFocusAfterSuccess(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAfterSuccess, pendingQuery.data, requestsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserRoundCheck} message="Select a company to view human operator requests." />;
  }
  if (requestsQuery.isLoading || pendingQuery.isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const requests = requestsQuery.data ?? [];
  const pending = pendingQuery.data?.data ?? [];
  const surface = selectHumanOperatorSurface({
    companyId: selectedCompanyId,
    missions: missionsQuery.isError ? undefined : missionsQuery.data,
    requests,
    pendingDecisions: pending,
    pendingNextCursor: pendingQuery.data?.page.nextCursor,
  });
  const error = requestsQuery.error ?? pendingQuery.error ?? missionsQuery.error;
  const isFetching = requestsQuery.isFetching || pendingQuery.isFetching || missionsQuery.isFetching;

  async function refreshDecisionSurfaces() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.humanOperatorRequests(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId!) }),
    ]);
    setFocusAfterSuccess(true);
  }

  async function resolveDecision(id: string, input: ResolveOperatorDecisionInput) {
    await operatorDecisionsApi.resolve(id, input);
    await refreshDecisionSurfaces();
  }

  async function refreshAll() {
    await Promise.all([requestsQuery.refetch(), pendingQuery.refetch(), missionsQuery.refetch()]);
  }

  const sections: { lifecycle: HumanOperatorLifecycle; title: string; note?: string; data: HumanOperatorSurfaceSection }[] = [
    { lifecycle: "active", title: L(lang, { en: "Active and planning", ko: "활성 및 계획 중" }), data: surface.active },
    { lifecycle: "paused", title: L(lang, { en: "Paused missions", ko: "일시 중지된 미션" }),
      note: L(lang, { en: "A pending decision remains available while paused. Choosing a direction does not resume the mission.", ko: "미션이 멈춰 있어도 대기 중인 결정은 유지됩니다. 방향을 선택해도 미션이 자동으로 재개되지는 않습니다." }), data: surface.paused },
    { lifecycle: "terminal", title: L(lang, { en: "Completed or cancelled missions", ko: "완료 또는 취소된 미션" }), data: surface.terminal },
    { lifecycle: "unknown", title: L(lang, { en: "Mission status unknown", ko: "미션 상태를 알 수 없음" }), data: surface.unknown },
    { lifecycle: "unscoped", title: L(lang, { en: "Unscoped work", ko: "미션 범위가 없는 작업" }), data: surface.unscoped },
  ];
  const missionStatusNotice = missionsQuery.isLoading
    ? L(lang, { en: "Loading the complete company mission list; scoped items remain visible as unknown until it loads.", ko: "회사 전체 미션 목록을 불러오는 중입니다. 완료될 때까지 범위가 있는 항목은 상태 미확인으로 표시됩니다." })
    : missionsQuery.isError
      ? L(lang, { en: "The mission list could not be loaded; scoped items remain visible as unknown.", ko: "미션 목록을 불러오지 못했습니다. 범위가 있는 항목은 상태 미확인으로 표시됩니다." })
      : missionsQuery.isFetching || missionsQuery.isStale
        ? L(lang, { en: "Mission status may be stale; displayed groups use the last successful complete list.", ko: "미션 상태가 오래되었을 수 있습니다. 마지막으로 성공한 전체 목록으로 분류했습니다." })
        : null;
  const displayedLabel = surface.pendingPageIncomplete
    ? L(lang, { en: `At least ${surface.displayedCount} ${surface.displayedCount === 1 ? "item" : "items"} displayed; more pending cards exist.`, ko: `항목 ${surface.displayedCount}개 이상 표시 중이며, 대기 카드가 더 있습니다.` })
    : L(lang, { en: `${surface.displayedCount} ${surface.displayedCount === 1 ? "item" : "items"} displayed`, ko: `항목 ${surface.displayedCount}개 표시 중` });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Human Operator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Structured decisions, mission escalations, and input requests needing operator attention.
          </p>
          <p className="mt-1 text-xs font-medium text-foreground">{displayedLabel}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {L(lang, {
              en: `${surface.activeCount} active/planning item${surface.activeCount === 1 ? "" : "s"} displayed`,
              ko: `활성/계획 미션 항목 ${surface.activeCount}개 표시 중`,
            })}
          </p>
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

      {missionStatusNotice && <p className="text-xs text-muted-foreground" role={missionsQuery.isError ? "alert" : "status"}>{missionStatusNotice}</p>}

      {sections.map(({ lifecycle, title, note, data }) => {
        const sectionCount = data.cards.length + data.requests.length;
        if (lifecycle !== "active" && sectionCount === 0) return null;
        const headingId = `human-operator-${lifecycle}-heading`;
        return (
          <section key={lifecycle} aria-labelledby={headingId} className="space-y-2">
            <h2 id={headingId} className="text-base font-semibold">
              {title} <span className="text-xs font-normal text-muted-foreground">({sectionCount} displayed)</span>
            </h2>
            {note && sectionCount > 0 && <p className="text-sm text-muted-foreground">{note}</p>}
            {data.cards.length > 0 && (
              <div aria-label={L(lang, { en: "Pending Interactive Cards", ko: "대기 중인 인터랙티브 카드" })} className="space-y-2">
                <h3 className="text-sm font-medium">{L(lang, { en: "Pending Interactive Cards", ko: "대기 중인 인터랙티브 카드" })}</h3>
                {data.cards.map(({ decision }) => <OperatorDecisionCard key={decision.id} decision={decision} onResolve={resolveDecision} />)}
              </div>
            )}
            {lifecycle === "active" && <ExternalAutomationApprovals />}
            {data.requests.length > 0 && <ul className="space-y-2">{data.requests.map(({ request, card, scope }) => (
              <HumanOperatorRow
                key={request.id}
                request={request}
                card={card}
                resolvedCard={null}
                scope={scope}
                onResolve={resolveDecision}
              />
            ))}</ul>}
            {surface.displayedCount === 0 && lifecycle === "active" && (
              <h3 data-human-operator-empty-heading tabIndex={-1} className="text-sm font-medium">
                {L(lang, { en: "No open human operator requests.", ko: "열려 있는 사람 운영자 요청이 없습니다." })}
              </h3>
            )}
          </section>
        );
      })}
    </div>
  );
}
