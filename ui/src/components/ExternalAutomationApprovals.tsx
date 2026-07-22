import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitBranch, GitCommitHorizontal, XCircle } from "lucide-react";
import { approvalsApi } from "../api/approvals";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./StatusBadge";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { asString, readPayload, readChecks, shortSha } from "./external-automation-payload";

export { readPayload, shortSha };

/**
 * Pending `external_automation` approvals rendered inside the Human Operator
 * menu. Operator can approve/reject directly from here; approving dispatches
 * the exact commit recorded in the payload. No A1/GitHub fixed values live in
 * Runtime — all fields come from the approval payload.
 */
export function ExternalAutomationApprovals() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId, "pending") : ["approvals", "ext", "pending"],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    select: (approvals) => approvals.filter((approval) => approval.type === "external_automation"),
  });

  const refresh = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId, "pending") });
  };

  const [actionError, setActionError] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Approve failed"),
  });
  const reject = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => { setActionError(null); refresh(); },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Reject failed"),
  });

  if (!selectedCompanyId || isLoading) return null;
  const approvals = data ?? [];
  if (approvals.length === 0) return null;
  const pending = approve.isPending || reject.isPending;

  return (
    <section className="space-y-2" aria-label="External automation approvals">
      <div>
        <h2 className="text-lg font-semibold">External automation approvals</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approving deploys the exact commit shown. Rejecting performs no deployment.
        </p>
      </div>
      {actionError && (
        <div className="flex items-center gap-2 border border-destructive/40 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}
      <ul className="space-y-2">
        {approvals.map((approval) => {
          const payload = readPayload(approval);
          const repository = asString(payload.repository);
          const branch = asString(payload.branch);
          const commit = asString(payload.commit);
          const title = asString(payload.title) || "External automation approval";
          const summary = asString(payload.summary);
          const checks = readChecks(payload.checks);
          return (
            <li key={approval.id} className="border border-border bg-card p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">external automation</span>
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                    {summary && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                  </div>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {repository && (
                      <div className="flex items-center gap-1.5 truncate">
                        <GitBranch className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{repository}</span>
                      </div>
                    )}
                    {branch && (
                      <div className="flex items-center gap-1.5 truncate">
                        <GitBranch className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{branch}</span>
                      </div>
                    )}
                    {commit && (
                      <div className="flex items-center gap-1.5 font-mono">
                        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
                        <span>{shortSha(commit)}</span>
                      </div>
                    )}
                  </dl>
                  {checks.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Required checks">
                      {checks.map((check, index) => (
                        <li key={index} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          <span className="font-medium">{asString(check.name) || `check ${index + 1}`}</span>
                          <span className="ml-1">· {asString(check.conclusion || check.status) || "unknown"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="default" size="sm" disabled={pending} data-testid={`approve-${approval.id}`} onClick={() => approve.mutate(approval.id)}>
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                    Approve
                  </Button>
                  <Button variant="outline" size="sm" disabled={pending} data-testid={`reject-${approval.id}`} onClick={() => reject.mutate(approval.id)}>
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    Reject
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
