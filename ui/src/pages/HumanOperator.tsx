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
  operatorDecisionStageLabel,
  requesterOutcomeStatusLabel,
} from "../components/OperatorDecisionActivity";

function formatRequestTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function missionLink(request: MissionHumanOperatorRequest): string {
  const query = request.issueId ? `?issue=${encodeURIComponent(request.issueId)}` : "";
  return `/missions/${request.missionId}${query}`;
}

// [C4 바인딩 규약] Stage 1 서비스(mission-owner-human-input-card.ts)가 requestKey=`moi1:{decisionEventId}`·
//   sourceId=decisionEventId 로 카드를 만들고, 요청 행은 activity payload 의 decisionEventId 를 log
//   evidenceRef 로 노출한다(human-operator-requests.ts — 현재 제출 경로는 commentId 를 기록하지 않으므로
//   log ref 가 항상 decisionEventId). 서버 수정 없이 이 규약으로 행↔카드를 연결한다.
const MOI_REQUEST_KEY_PREFIX = "moi1:";

function requestDecisionEventId(request: MissionHumanOperatorRequest): string | null {
  const ref = request.event?.evidenceRefs?.find(
    (item) => item.type === "log" && item.label === "mission owner decision",
  );
  return ref?.ref ? ref.ref : null;
}

function requestKeyOf(request: MissionHumanOperatorRequest): string | null {
  const decisionEventId = requestDecisionEventId(request);
  return decisionEventId ? `${MOI_REQUEST_KEY_PREFIX}${decisionEventId}` : null;
}

function HumanOperatorRow({
  request,
  card,
  resolvedCard,
  onResolve,
}: {
  request: MissionHumanOperatorRequest;
  card: OperatorDecisionView | null;
  resolvedCard: OperatorDecisionView | null;
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
    <li className="border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={request.severity ?? "attention"} />
            <StatusBadge status={request.missionStatus} />
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
  const lang = useCompanyLanguage();
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
      setRetryError(error instanceof Error ? error.message : L(lang, { en: "Failed to retry this continuation.", ko: "이어서 진행 재시도에 실패했습니다." }));
    } finally {
      setIsRetrying(false);
    }
  }
  return (
    <li className="border border-destructive/40 bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{decision.title}</h3>
          {continuation.issueIdentifier && (
            <p className="mt-1 text-sm text-foreground">
              이슈: {continuation.issueIdentifier}
              {continuation.issueTitle ? ` — ${continuation.issueTitle}` : ""}
            </p>
          )}
          {continuation.missionTitle && (
            <p className="mt-0.5 text-sm text-muted-foreground">미션: {continuation.missionTitle}</p>
          )}
          <p className="mt-1 text-sm text-destructive">{humanize(continuation.errorCode)}</p>
          {continuation.retryHint && (
            <p className="mt-0.5 text-xs text-muted-foreground">{continuation.retryHint}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {/* [4b-2] 요청자 회신 outcome 이 대표 상태(우선), continuation 단계는 보조로 함께 노출한다. */}
            {decision.requesterOutcome ? <>{L(lang, { en: "Requester outcome", ko: "요청자 결과" })} <span title={decision.requesterOutcome.status}>{requesterOutcomeStatusLabel(lang, decision.requesterOutcome.status)}</span> · </> : null}
            <span title={continuation.effectiveStatus}>{operatorDecisionStageLabel(lang, continuation.effectiveStatus)}</span> · {L(lang, { en: `Generation ${continuation.generation}`, ko: `재시도 회차 ${continuation.generation}` })} · {L(lang, { en: `Attempt ${continuation.attemptCount}`, ko: `시도 ${continuation.attemptCount}회` })}
          </p>
        </div>
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" disabled={!retryable || isRetrying} onClick={() => void retry()}>
            {isRetrying ? L(lang, { en: "Retrying…", ko: "재시도 중…" }) : L(lang, { en: "Retry continuation", ko: "이어서 재시도" })}
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
  // [C4] 해결·취소된 moi 카드의 상태 배지용 이력 — resolved/cancelled 는 pending 뷰에 없다.
  const historyQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.operatorDecisions.list(selectedCompanyId, "history") : ["operator-decisions", "history"],
    queryFn: () => operatorDecisionsApi.list(selectedCompanyId!, "history"),
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
  if (requestsQuery.isLoading || pendingQuery.isLoading || attentionQuery.isLoading || historyQuery.isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const requests = requestsQuery.data ?? [];
  const pending = pendingQuery.data?.data ?? [];
  const attention = attentionQuery.data?.data ?? [];
  const history = historyQuery.data?.data ?? [];
  // [C4] moi 카드 ↔ 요청 행 매칭. 행에 바인딩된 pending 카드는 요청 섹션에서만 렌더하고
  //   pending 카드 섹션에서 제외해 같은 카드의 중복 렌더를 막는다. 행이 없는 moi pending 카드는
  //   (소유자 이슈가 닫혀 행에서 빠진 경우) 여전히 pending 섹션에 남는다.
  const moiPendingByKey = new Map(
    pending.filter((decision) => decision.requestKey.startsWith(MOI_REQUEST_KEY_PREFIX))
      .map((decision) => [decision.requestKey, decision]),
  );
  const moiResolvedByKey = new Map(
    history.filter((decision) => decision.requestKey.startsWith(MOI_REQUEST_KEY_PREFIX))
      .map((decision) => [decision.requestKey, decision]),
  );
  const boundRequestKeys = new Set(
    requests.map(requestKeyOf).filter((key): key is string => key !== null && moiPendingByKey.has(key)),
  );
  const actionableCount = requests.length + pending.length - boundRequestKeys.size;
  const error = requestsQuery.error ?? pendingQuery.error ?? attentionQuery.error ?? historyQuery.error;
  const isFetching = requestsQuery.isFetching || pendingQuery.isFetching || attentionQuery.isFetching || historyQuery.isFetching;

  async function refreshDecisionSurfaces() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "pending") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "attention") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.operatorDecisions.list(selectedCompanyId!, "history") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.humanOperatorRequests(selectedCompanyId!) }),
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
    await Promise.all([requestsQuery.refetch(), pendingQuery.refetch(), attentionQuery.refetch(), historyQuery.refetch()]);
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
        {pending.filter((decision) => !boundRequestKeys.has(decision.requestKey))
          .map((decision) => <OperatorDecisionCard key={decision.id} decision={decision} onResolve={resolveDecision} />)}
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

      {requests.length > 0 ? <ul className="space-y-2">{requests.map((request) => {
        const key = requestKeyOf(request);
        return (
          <HumanOperatorRow
            key={request.id}
            request={request}
            card={key ? moiPendingByKey.get(key) ?? null : null}
            resolvedCard={key ? moiResolvedByKey.get(key) ?? null : null}
            onResolve={resolveDecision}
          />
        );
      })}</ul> : pending.length === 0 && attention.length === 0 ? (
        <h2 data-human-operator-empty-heading tabIndex={-1} className="text-sm font-medium">{L(lang, { en: "No open human operator requests.", ko: "열려 있는 사람 운영자 요청이 없습니다." })}</h2>
      ) : null}
    </div>
  );
}
