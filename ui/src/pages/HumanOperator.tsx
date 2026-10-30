import { useEffect, useState } from "react";
import { Link } from "../lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RefreshCw, UserRoundCheck } from "lucide-react";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
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
  type HumanOperatorRequestStateProblem,
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

function requestStateLabel(
  lang: ReturnType<typeof useCompanyLanguage>,
  state: HumanOperatorRequestStateV1 | null,
  problem: HumanOperatorRequestStateProblem | null,
  hasCard: boolean,
): string {
  if (problem === "legacy") return L(lang, { en: "Decision state not provided by this server", ko: "이 서버 응답에 결정 상태가 없습니다" });
  if (problem === "malformed") return L(lang, { en: "Decision state format is unknown", ko: "결정 상태 형식을 확인할 수 없습니다" });
  if (problem === "scope-conflict") return L(lang, { en: "Request scope needs review", ko: "요청 범위를 확인해야 합니다" });
  if (problem === "card-conflict") return L(lang, { en: "Decision/card details conflict", ko: "결정과 카드 정보가 일치하지 않습니다" });
  if (problem === "duplicate-decision") return L(lang, { en: "Decision identity is ambiguous", ko: "결정 연결이 모호합니다" });
  if (!state) return L(lang, { en: "Decision state is unknown", ko: "결정 상태를 알 수 없습니다" });
  if (state.identity === "missing") return L(lang, { en: "No exact decision found", ko: "정확히 연결된 결정을 찾지 못했습니다" });
  if (state.identity === "ambiguous") return L(lang, { en: "Decision link is ambiguous", ko: "결정 연결이 모호합니다" });
  if (state.identity === "unsupported") return L(lang, { en: "Unsupported decision record", ko: "지원하지 않는 결정 기록입니다" });
  if (state.decision?.status === "pending") {
    return hasCard
      ? L(lang, { en: "Direction pending", ko: "방향 선택 대기" })
      : L(lang, { en: "Direction pending · card not loaded", ko: "방향 결정 대기 · 카드 미조회" });
  }
  if (state.decision?.status === "resolved") return L(lang, { en: "Direction decided", ko: "방향 결정됨" });
  return L(lang, { en: "Direction cancelled", ko: "방향 결정 취소됨" });
}

function continuationStatusLabel(lang: ReturnType<typeof useCompanyLanguage>, status: string): string {
  const labels: Record<string, { en: string; ko: string }> = {
    pending: { en: "Follow-up pending", ko: "후속 실행 대기" },
    dispatching: { en: "Follow-up dispatching", ko: "후속 실행 전달 중" },
    blocked: { en: "Follow-up blocked", ko: "후속 실행 차단" },
    exhausted: { en: "Follow-up attempts exhausted", ko: "후속 실행 시도 한도 도달" },
    queued: { en: "Follow-up queued", ko: "후속 실행 대기열" },
    deferred: { en: "Follow-up deferred", ko: "후속 실행 대기" },
    running: { en: "Follow-up running", ko: "후속 실행 중" },
    coalesced: { en: "Follow-up joined an existing run", ko: "기존 실행에 연결됨" },
    completed: { en: "Follow-up completed", ko: "후속 실행 완료" },
    skipped: { en: "Follow-up skipped", ko: "후속 실행 건너뜀" },
    failed: { en: "Follow-up failed", ko: "후속 실행 실패" },
    cancelled: { en: "Follow-up cancelled", ko: "후속 실행 취소" },
    timed_out: { en: "Follow-up timed out", ko: "후속 실행 시간 초과" },
    agent_unrunnable: { en: "Target agent cannot run", ko: "대상 에이전트를 실행할 수 없음" },
    assignee_changed: { en: "Issue assignee changed", ko: "이슈 담당자가 변경됨" },
    issue_terminal: { en: "Issue is terminal", ko: "이슈가 종료 상태임" },
  };
  return labels[status] ? L(lang, labels[status]!) : L(lang, { en: "Follow-up state unknown", ko: "후속 실행 상태를 알 수 없음" });
}

function RequestDecisionState({ state }: { state: HumanOperatorRequestStateV1 }) {
  const lang = useCompanyLanguage();
  if (state.identity !== "exact" || !state.decision) return null;
  const decision = state.decision;
  const result = decision.result;
  const continuation = state.continuation;
  return (
    <section data-human-operator-request-state={decision.status} className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
      <dl className="grid gap-x-2 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">{L(lang, { en: "Owner action issue", ko: "조치 소유 이슈" })}</dt>
        <dd data-owner-action-issue-id>{state.ownerActionIssueId}</dd>
        <dt className="font-medium">{L(lang, { en: "Source/navigation issue", ko: "원천·탐색 이슈" })}</dt>
        <dd data-source-issue-id>{state.sourceIssueId ?? L(lang, { en: "None recorded", ko: "기록된 원천 이슈 없음" })}</dd>
      </dl>
      {decision.status === "resolved" && result && (
        <div data-human-operator-decision-result className="space-y-1">
          <p><span className="font-medium">{L(lang, { en: "Selected result", ko: "선택 결과" })}:</span> {result.actionId} · {result.outcome}</p>
          {result.selectedOptionIds.length > 0 && <p>{L(lang, { en: "Selected options", ko: "선택 항목" })}: {result.selectedOptionIds.join(", ")}</p>}
          {result.comment && <p>{L(lang, { en: "Recorded comment", ko: "기록된 메모" })}: {result.comment}</p>}
        </div>
      )}
      {decision.status === "cancelled" && <p>{L(lang, { en: "This decision was cancelled.", ko: "이 결정은 취소되었습니다." })}</p>}
      {decision.status !== "pending" && (
        <div data-human-operator-continuation className="space-y-1">
          <p className="font-medium">{L(lang, { en: "Native follow-up state", ko: "후속 실행 상태" })}</p>
          {!continuation
            ? <p>{decision.continuationMode === "none"
              ? L(lang, { en: "No automatic follow-up is expected.", ko: "자동 후속 실행 대상이 아닙니다." })
              : L(lang, { en: "Follow-up evidence needs review.", ko: "후속 실행 증거 확인 필요" })}</p>
            : <>
              <p>{continuationStatusLabel(lang, continuation.effectiveStatus)} · {continuation.state}</p>
              <p>{L(lang, { en: "Attempts", ko: "시도" })}: {continuation.attemptCount}/{continuation.maxAttempts} · {L(lang, { en: "Manual retries", ko: "수동 재시도" })}: {continuation.manualRetryCount}/{continuation.maxManualRetries}</p>
              {continuation.errorCode && <p>{L(lang, { en: "Error code", ko: "오류 코드" })}: {continuation.errorCode}</p>}
              {continuation.retryHint && <p>{L(lang, { en: "Read-only diagnostic hint", ko: "읽기 전용 진단 참고" })}: {continuation.retryHint}</p>}
              {continuation.state === "accepted" && <p>{L(lang, { en: "Accepted delivery does not mean the mission or owner work is complete.", ko: "실행 접수는 미션 완료나 오너 작업 소비를 뜻하지 않습니다." })}</p>}
            </>}
        </div>
      )}
    </section>
  );
}

function HumanOperatorRow({
  request,
  card,
  requestState,
  requestStateProblem,
  scope,
  onResolve,
}: {
  request: MissionHumanOperatorRequest;
  card: OperatorDecisionView | null;
  requestState: HumanOperatorRequestStateV1 | null;
  requestStateProblem: HumanOperatorRequestStateProblem | null;
  scope: HumanOperatorScope;
  onResolve: (decisionId: string, input: ResolveOperatorDecisionInput) => Promise<unknown>;
}) {
  const lang = useCompanyLanguage();
  const cardStatusBadge = requestStateLabel(lang, requestState, requestStateProblem, !!card);
  return (
    <li data-human-operator-lifecycle={scope.lifecycle} className="border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={request.severity ?? "attention"} />
            <StatusBadge status={scope.missionStatus ?? "unknown"} />
            <span data-human-input-card-badge className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{cardStatusBadge}</span>
            {(!requestState || requestState.attention === null) && <span data-human-operator-attention="unknown" className="text-xs text-amber-700">{L(lang, { en: "Attention unknown", ko: "주의 여부 미확인" })}</span>}
            {requestState && requestState.attention !== null && <span data-human-operator-attention={requestState.attention ? "needed" : "none"} className="text-xs text-muted-foreground">{requestState.attention
              ? L(lang, { en: "Follow-up attention needed", ko: "후속 실행 확인 필요" })
              : L(lang, { en: "No follow-up attention reported", ko: "후속 실행 주의 신호 없음" })}</span>}
            <span className="text-xs text-muted-foreground">{formatRequestTime(request.timestamp)}</span>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{request.title}</h2>
            <p className="mt-1 text-xs font-medium text-muted-foreground">{L(lang, { en: "Historical request evidence · not a current instruction", ko: "과거 요청 증거 · 현재 지시가 아닙니다" })}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{request.summary}</p>
            {requestState && requestState.identity !== "exact" && requestState.reasonCode && (
              <p data-human-operator-request-reason className="mt-1 text-xs text-muted-foreground">{L(lang, { en: "Reason", ko: "사유 코드" })}: {requestState.reasonCode}</p>
            )}
            {requestStateProblem && <p data-human-operator-request-reason className="mt-1 text-xs text-muted-foreground">{L(lang, { en: "Request state is shown as unknown.", ko: "요청 상태를 미확인으로 표시했습니다." })}</p>}
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full shrink-0 lg:w-auto">
          <Link to={missionLink(request)}>{L(lang, { en: "Open mission", ko: "미션 열기" })}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Link>
        </Button>
      </div>
      {requestState?.identity === "exact" && requestStateProblem === null && <RequestDecisionState state={requestState} />}
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
  const recentWindowNotice = L(lang, {
    en: "Showing a bounded recent request window; this is not a total or a count of all pending work.",
    ko: "최근 요청 일부 표시이며 전체 요청 또는 전체 대기 수가 아닙니다.",
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Human Operator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Structured decisions, mission escalations, and input requests needing operator attention.
          </p>
          <p data-human-operator-recent-window className="mt-1 text-xs text-muted-foreground">{recentWindowNotice}</p>
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
            {data.requests.length > 0 && <ul className="space-y-2">{data.requests.map(({ request, card, requestState, requestStateProblem, scope }) => (
              <HumanOperatorRow
                key={request.id}
                request={request}
                card={card}
                requestState={requestState}
                requestStateProblem={requestStateProblem}
                scope={scope}
                onResolve={resolveDecision}
              />
            ))}</ul>}
            {surface.displayedCount === 0 && lifecycle === "active" && (
              <h3 data-human-operator-empty-heading tabIndex={-1} className="text-sm font-medium">
                {L(lang, { en: "No requests in this recent window.", ko: "최근 요청 범위에 표시할 요청이 없습니다." })}
              </h3>
            )}
          </section>
        );
      })}
    </div>
  );
}
