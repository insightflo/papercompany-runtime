import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Identity } from "../components/Identity";
import { approvalLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { ApprovalComments } from "../components/ApprovalComments";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import { HumanReviewPacket } from "../components/HumanReviewPacket";
import { approvalHumanReview } from "../lib/humanReview";

export function ApprovalDetail() {
  const lang = useCompanyLanguage();
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: L(lang, { en: "Approvals", ko: "승인" }), href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? L(lang, { en: "Approval", ko: "승인 요청" }) },
    ]);
  }, [setBreadcrumbs, approval, approvalId, lang]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approval!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Failed to approve", ko: "승인하지 못했습니다." })),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approval!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Failed to reject", ko: "거절하지 못했습니다." })),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approval!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Revision request failed", ko: "수정 요청을 보내지 못했습니다." })),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approval!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Resubmit failed", ko: "재제출하지 못했습니다." })),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Comment failed", ko: "댓글을 게시하지 못했습니다." })),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Delete failed", ko: "삭제하지 못했습니다." })),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">{L(lang, { en: "Approval not found.", ko: "승인 요청을 찾을 수 없습니다." })}</p>;

  const payload = approval.payload as Record<string, unknown>;
  const reviewPacket = approvalHumanReview(approval);
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? L(lang, { en: "Review linked work items", ko: "연관 업무 검토" })
              : L(lang, { en: "Review linked work item", ko: "연관 업무 검토" }),
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: L(lang, { en: "Open hired agent", ko: "고용된 에이전트 열기" }),
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: L(lang, { en: "Back to approvals", ko: "승인 목록으로" }),
            to: "/approvals",
          };

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">{L(lang, { en: "Approval confirmed", ko: "승인이 확정되었습니다" })}</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  {approval.type === "workflow_replacement" ? L(lang, { en: "Replacement approved. Actual creation and execution require a separate request and rechecking current conditions.", ko: "교체 요청을 승인했습니다. 실제 생성·실행은 별도 요청과 현재 조건 재검사를 거칩니다." }) : L(lang, { en: "Requesting agent was notified to review this approval and linked work items.", ko: "요청한 에이전트에게 승인 결과와 연관 업무를 확인하도록 알렸습니다." })}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h2 className="text-lg font-semibold">{approvalLabel(approval.type, approval.payload as Record<string, unknown> | null, lang)}</h2>
              <p className="text-xs text-muted-foreground font-mono">{approval.id}</p>
            </div>
          </div>
          <span title={approval.status} className="text-xs font-medium">{humanLabel(lang, "approvalStatus", approval.status).label}</span>
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{L(lang, { en: "Requested by", ko: "요청:" })}</span>
              <Identity
                name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <HumanReviewPacket packet={reviewPacket} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            {L(lang, { en: "See full request", ko: "전체 요청 보기" })}
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">{L(lang, { en: "Decision note:", ko: "결정 메모:" })} {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">{L(lang, { en: "Linked Work Items", ko: "연관 업무" })}</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                >
                  <span className="font-mono text-muted-foreground mr-2">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {L(lang, { en: "Linked work items remain open until the requesting agent follows up and closes them.", ko: "연관 업무는 요청한 에이전트가 후속 작업을 수행하고 종결할 때까지 열린 상태로 유지됩니다." })}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending || !reviewPacket || (approval.type === "workflow_replacement" && approval.status !== "pending")}
                title={!reviewPacket ? L(lang, { en: "Review information and source locations are required before approval.", ko: "판단 정보와 원본 위치를 보완해야 승인할 수 있습니다." }) : undefined}
              >
                {L(lang, { en: "Approve", ko: "승인" })}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                {L(lang, { en: "Reject", ko: "거절" })}
              </Button>
            </>
          )}
          {isBudgetApproval && approval.status === "pending" && (
            <p className="text-sm text-muted-foreground">
              {L(lang, { en: "Resolve this budget stop from the budget controls on", ko: "예산 정지는 다음 페이지의 예산 설정에서 해결하세요:" })} <Link to="/costs" className="underline underline-offset-2">/costs</Link>.
            </p>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              {L(lang, { en: "Request revision", ko: "수정 요청" })}
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              {L(lang, { en: "Mark resubmitted", ko: "재제출로 표시" })}
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => {
                if (!window.confirm(L(lang, { en: "Delete this disapproved agent? This cannot be undone.", ko: "거절된 에이전트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다." }))) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              {L(lang, { en: "Delete disapproved agent", ko: "거절된 에이전트 삭제" })}
            </Button>
          )}
        </div>
      </div>

      <ApprovalComments comments={comments ?? []} agentNameById={agentNameById} commentBody={commentBody} setCommentBody={setCommentBody} isPending={addCommentMutation.isPending} onPost={() => addCommentMutation.mutate()} />
    </div>
  );
}
