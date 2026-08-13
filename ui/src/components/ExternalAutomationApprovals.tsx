import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { approvalsApi } from "../api/approvals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { ApprovalCard } from "./ApprovalCard";

export { readPayload, shortSha } from "./external-automation-payload";

export function ExternalAutomationApprovals() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId, "pending") : ["approvals", "external", "pending"],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"), enabled: !!selectedCompanyId, refetchInterval: 30_000,
    select: (items) => items.filter((item) => item.type === "external_automation"),
  });
  const refresh = () => selectedCompanyId && queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
  const approve = useMutation({ mutationFn: (id: string) => approvalsApi.approve(id), onSuccess: () => { setActionError(null); refresh(); }, onError: (error) => setActionError(error instanceof Error ? error.message : "승인하지 못했습니다.") });
  const reject = useMutation({ mutationFn: (id: string) => approvalsApi.reject(id), onSuccess: () => { setActionError(null); refresh(); }, onError: (error) => setActionError(error instanceof Error ? error.message : "거절하지 못했습니다.") });
  if (!selectedCompanyId || isLoading || !data?.length) return null;
  return <section className="space-y-2" aria-label="추가 승인 요청">
    <div><h2 className="text-lg font-semibold">추가 승인 요청</h2><p className="mt-1 text-sm text-muted-foreground">외부 시스템 실행, 배포, 신고 초안 등 종류와 관계없이 근거와 영향을 검토한 뒤 결정합니다.</p></div>
    {actionError && <div className="flex gap-2 border border-destructive/40 p-3 text-sm text-destructive" role="alert"><AlertTriangle className="h-4 w-4" />{actionError}</div>}
    {data.map((approval) => <ApprovalCard key={approval.id} approval={approval} requesterAgent={null} onApprove={() => approve.mutate(approval.id)} onReject={() => reject.mutate(approval.id)} detailLink={`/approvals/${approval.id}`} isPending={approve.isPending || reject.isPending} />)}
  </section>;
}
