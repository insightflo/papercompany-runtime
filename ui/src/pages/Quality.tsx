import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { qualityApi } from "../api/quality";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import type {
  QualityReviewItemListItem,
  QualityVerdict,
} from "@paperclipai/shared";

const VERDICTS: QualityVerdict[] = ["pass", "fail", "request_changes", "needs_evidence", "dismissed"];

const STATUS_TONE: Record<string, string> = {
  detected: "bg-muted text-muted-foreground",
  awaiting_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  evidence_collecting: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  changes_requested: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  resolved_pass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  resolved_fail: "bg-red-500/15 text-red-700 dark:text-red-400",
  dismissed: "bg-muted text-muted-foreground",
};

const PRIORITY_TONE: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/60",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}

function EvidenceSurface({ evidence }: { evidence: { surface: string; status: string; blocking: boolean; sourceUrl?: string | null } }) {
  const unresolved = evidence.status === "missing" || evidence.status === "failed" || evidence.status === "stale" || evidence.blocking;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
        unresolved
          ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
      title={`${evidence.surface}: ${evidence.status}${evidence.blocking ? " (blocking)" : ""}`}
    >
      {unresolved ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
      {evidence.surface}
    </span>
  );
}

export function Quality() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [surfacesByItem, setSurfacesByItem] = useState<Record<string, string>>({});
  const [anchorTitleByItem, setAnchorTitleByItem] = useState<Record<string, string>>({});
  const [lastVerdictByItem, setLastVerdictByItem] = useState<Record<string, { verdictId: string; verdict: QualityVerdict }>>({});
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Quality" }]);
  }, [setBreadcrumbs]);

  const { data: items, isLoading } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.quality.reviewItems(selectedCompanyId) : ["quality", "review-items"],
    queryFn: () => qualityApi.listReviewItems(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const verdictMut = useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: { verdict: QualityVerdict; reason?: string; requiredEvidenceSurfaces?: string[] } }) =>
      qualityApi.recordVerdict(itemId, body),
    onSuccess: (data, vars) => {
      setLastVerdictByItem((prev) => ({ ...prev, [vars.itemId]: { verdictId: data.verdict.id, verdict: data.verdict.verdict } }));
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.quality.reviewItems(selectedCompanyId) });
      }
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Verdict failed"),
  });

  const promoteMut = useMutation({
    mutationFn: ({ itemId, verdictId, title }: { itemId: string; verdictId: string; title: string }) =>
      qualityApi.promoteAnchor(itemId, { verdictId, title }),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.quality.reviewItems(selectedCompanyId) });
      }
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Promote failed"),
  });

  async function handleVerdict(item: QualityReviewItemListItem, verdict: QualityVerdict) {
    setError(null);
    setBusyItem(item.id);
    const surfacesRaw = surfacesByItem[item.id]?.trim() ?? "";
    const requiredEvidenceSurfaces = verdict === "needs_evidence" && surfacesRaw
      ? surfacesRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    try {
      await verdictMut.mutateAsync({ itemId: item.id, body: { verdict, requiredEvidenceSurfaces } });
    } finally {
      setBusyItem(null);
    }
  }

  async function handlePromote(item: QualityReviewItemListItem) {
    const last = lastVerdictByItem[item.id];
    if (!last) return;
    const title = anchorTitleByItem[item.id]?.trim() || `Anchor: ${item.title}`;
    setError(null);
    setBusyItem(item.id);
    try {
      await promoteMut.mutateAsync({ itemId: item.id, verdictId: last.verdictId, title });
      setAnchorTitleByItem((prev) => ({ ...prev, [item.id]: "" }));
    } finally {
      setBusyItem(null);
    }
  }

  if (!selectedCompanyId) {
    return <PageSkeleton variant="list" />;
  }
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const open = (items ?? []).filter((i) => !i.status.startsWith("resolved") && i.status !== "dismissed");
  const closed = (items ?? []).filter((i) => i.status.startsWith("resolved") || i.status === "dismissed");
  const blockingCount = (items ?? []).reduce(
    (acc, i) => acc + i.evidenceRefs.filter((r) => r.blocking || r.status === "missing" || r.status === "failed" || r.status === "stale").length,
    0,
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">Quality</h1>
          <span className="text-xs text-muted-foreground">
            {open.length} open - {blockingCount} evidence gaps - {closed.length} resolved
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        {(items ?? []).length === 0 ? (
          <EmptyState icon={ListChecks} message="No quality review items yet. Delivery audits and evidence gates will surface items here." />
        ) : (
          <div className="flex flex-col gap-3">
            {open.map((item) => {
              const last = lastVerdictByItem[item.id];
              const unresolved = item.evidenceRefs.filter((r) => r.blocking || r.status === "missing" || r.status === "failed" || r.status === "stale");
              return (
                <div key={item.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusPill status={item.status} />
                        <span className={cn("text-[11px] font-semibold uppercase", PRIORITY_TONE[item.priority] ?? "text-muted-foreground")}>
                          {item.priority}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{item.triggerSource}</span>
                        <span className="text-[11px] text-muted-foreground">- {item.targetType}</span>
                      </div>
                      <p className="mt-1 text-sm font-medium text-foreground truncate">{item.title}</p>
                      {item.evidenceRefs.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {item.evidenceRefs.map((r) => (
                            <EvidenceSurface key={r.id} evidence={{ surface: r.surface, status: r.status, blocking: r.blocking, sourceUrl: r.sourceUrl }} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {VERDICTS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        disabled={busyItem === item.id}
                        onClick={() => handleVerdict(item, v)}
                        className={cn(
                          "rounded border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
                          v === "pass" && "border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400",
                          v === "fail" && "border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400",
                          v === "request_changes" && "border-orange-500/40 text-orange-700 hover:bg-orange-500/10 dark:text-orange-400",
                          v === "needs_evidence" && "border-blue-500/40 text-blue-700 hover:bg-blue-500/10 dark:text-blue-400",
                          v === "dismissed" && "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {busyItem === item.id && verdictMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : v}
                      </button>
                    ))}
                  </div>

                  {unresolved.length > 0 && (
                    <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                      {unresolved.length} blocking/missing evidence surface{unresolved.length > 1 ? "s" : ""} - record "needs_evidence" to open a collection issue.
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      placeholder="needs_evidence surfaces (comma-sep): browser_readback, public_url"
                      value={surfacesByItem[item.id] ?? ""}
                      onChange={(e) => setSurfacesByItem((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
                    />
                  </div>

                  {last && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-border/60 bg-muted/30 px-2 py-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Last verdict: <span className="font-medium text-foreground">{last.verdict}</span>
                      </span>
                      <input
                        type="text"
                        placeholder="anchor title"
                        value={anchorTitleByItem[item.id] ?? ""}
                        onChange={(e) => setAnchorTitleByItem((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[11px]"
                      />
                      <button
                        type="button"
                        disabled={busyItem === item.id}
                        onClick={() => handlePromote(item)}
                        className="rounded border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-400"
                      >
                        promote anchor
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {closed.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Resolved / dismissed ({closed.length})</summary>
                <div className="mt-2 flex flex-col gap-1">
                  {closed.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1 text-xs text-muted-foreground">
                      <StatusPill status={item.status} />
                      <span className="truncate">{item.title}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
