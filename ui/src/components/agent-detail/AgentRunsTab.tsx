import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../../api/heartbeats";
import { isHeartbeatPageScopeCurrent } from "../../lib/inbox";
import { createDirectLinkedRunStub } from "../../lib/heartbeat-run-stub";
import { useSidebar } from "../../context/SidebarContext";
import { cn, relativeTime, formatTokens, visibleRunCostUsd } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, XCircle, Clock, Timer, Loader2, Slash } from "lucide-react";
import type {
  HeartbeatRun,
  HeartbeatRunCursor,
  HeartbeatRunSummary,
} from "@paperclipai/shared";

const RUN_STATUS_ICONS: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

const SOURCE_LABELS: Record<string, string> = {
  timer: "Timer",
  assignment: "Assignment",
  on_demand: "On-demand",
  automation: "Automation",
};

const PAGE_SIZE = 100;

function sourceLabel(value: string): string {
  return SOURCE_LABELS[value] ?? value;
}

function sourceBadgeClass(invocationSource: string): string {
  if (invocationSource === "timer") return "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
  if (invocationSource === "assignment") return "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300";
  if (invocationSource === "on_demand") return "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300";
  return "bg-muted text-muted-foreground";
}

function runMetrics(run: HeartbeatRun | HeartbeatRunSummary) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = "resultJson" in run
    ? ((run as HeartbeatRun).resultJson ?? null) as Record<string, unknown> | null
    : null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached = usageNumber(usage, "cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens");
  const cost = visibleRunCostUsd(usage, result);
  return { input, output, cached, cost, totalTokens: input + output };
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]): number {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}
function RunListItem({ run, isSelected, agentId }: { run: HeartbeatRunSummary; isSelected: boolean; agentId: string }) {
  const statusInfo = RUN_STATUS_ICONS[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = run.resultSummary ?? run.error ?? "";

  return (
    <Link
      to={isSelected ? `/agents/${agentId}/runs` : `/agents/${agentId}/runs/${run.id}`}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
          sourceBadgeClass(run.invocationSource),
        )}>
          {sourceLabel(run.invocationSource)}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 60)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </Link>
  );
}

export function AgentRunsTab({
  initialRuns,
  nextCursor,
  companyId,
  agentId,
  agentRouteId,
  selectedRunId,
  adapterType,
  renderRunDetail,
}: {
  initialRuns: HeartbeatRunSummary[];
  nextCursor: HeartbeatRunCursor | null;
  companyId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  adapterType: string;
  renderRunDetail: (run: HeartbeatRunSummary) => React.ReactNode;
}) {
  const { isMobile } = useSidebar();
  const scopeRef = useRef({ companyId, agentId });
  scopeRef.current = { companyId, agentId };
  const [runs, setRuns] = useState<HeartbeatRunSummary[]>(initialRuns);
  const [cursor, setCursor] = useState<HeartbeatRunCursor | null>(nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setRuns(initialRuns);
    setCursor(nextCursor);
  }, [initialRuns, nextCursor]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const scope = { companyId, agentId };
    setLoadingMore(true);
    try {
      const page = await heartbeatsApi.page(companyId, { agentId, limit: PAGE_SIZE, cursor });
      if (!isHeartbeatPageScopeCurrent(scopeRef.current, scope)) return;
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
      });
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, companyId, agentId]);
  if (runs.length === 0 && !selectedRunId) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? runs[0]?.id ?? null);
  const selectedRun = runs.find((r) => r.id === effectiveRunId) ?? null;
  const directLinkedStub = !selectedRun && selectedRunId
    ? createDirectLinkedRunStub(selectedRunId, companyId, agentId)
    : null;
  const detailRun = selectedRun ?? directLinkedStub;

  const loadMoreButton = cursor ? (
    <div className="p-2 text-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void loadMore()}
        disabled={loadingMore}
      >
        {loadingMore ? "Loading…" : "Load more"}
      </Button>
    </div>
  ) : null;

  if (isMobile) {
    if (detailRun) {
      return (
        <div className="space-y-3 min-w-0 overflow-x-hidden">
          <Link
            to={`/agents/${agentRouteId}/runs`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          {renderRunDetail(detailRun)}
        </div>
      );
    }
    return (
      <div className="border border-border rounded-lg overflow-x-hidden">
        {runs.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
        ))}
        {loadMoreButton}
      </div>
    );
  }

  return (
    <div className="flex gap-0">
      <div className={cn(
        "shrink-0 border border-border rounded-lg",
        detailRun ? "w-72" : "w-full",
      )}>
        <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
          {runs.map((run) => (
            <RunListItem key={run.id} run={run} isSelected={run.id === effectiveRunId} agentId={agentRouteId} />
          ))}
          {loadMoreButton}
        </div>
      </div>

      {detailRun && (
        <div className="flex-1 min-w-0 pl-4">
          {renderRunDetail(detailRun)}
        </div>
      )}
    </div>
  );
}
