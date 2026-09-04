import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Scale } from "lucide-react";
import { missionsApi, type MissionDecisionRecord } from "../api/missions";
import { queryKeys } from "../lib/queryKeys";

interface MissionDecisionLogPanelProps {
  missionId: string;
}

function formatDecisionDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * [규칙 8] 결정 로그는 맥락 전달용 표시 상태다. 이 패널은 읽기 전용이며
 * 어떤 실행 통제 판단의 근거 UI도 아니다.
 */
function statusClass(status: MissionDecisionRecord["status"]) {
  switch (status) {
    case "confirmed":
      return "text-emerald-600";
    case "under_review":
      return "text-amber-600";
    case "retired":
      return "text-muted-foreground line-through";
    default:
      return "text-muted-foreground";
  }
}

function provenanceLabel(record: MissionDecisionRecord) {
  return record.handoffId ? `via handoff ${record.handoffId}` : "via decision report";
}

export function MissionDecisionLogPanel({ missionId }: MissionDecisionLogPanelProps) {
  const { data: log, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.decisionLog(missionId),
    queryFn: () => missionsApi.getDecisionLog(missionId),
    enabled: !!missionId,
  });

  if (isLoading) {
    return (
      <section className="rounded-md border border-border p-4" aria-label="Mission Decision Log">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Mission Decision Log</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">Loading mission decision log…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-md border border-border p-4" aria-label="Mission Decision Log">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="text-sm font-medium">Mission Decision Log</h3>
        </div>
        <p className="mt-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load mission decision log."}
        </p>
      </section>
    );
  }

  const decisions = log?.decisions ?? [];
  const confirmedCount = decisions.filter((record) => record.status === "confirmed").length;
  const underReviewCount = decisions.filter((record) => record.status === "under_review").length;

  return (
    <section className="rounded-md border border-border p-4 space-y-4" aria-label="Mission Decision Log">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">Mission Decision Log</h3>
            <p className="text-xs text-muted-foreground">
              Context handoff state only — not an execution-control authority
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">read-only</span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>rev {log?.revision ?? 0}</span>
        <span>{decisions.length} decisions</span>
        <span>{confirmedCount} confirmed</span>
        <span>{underReviewCount} under review</span>
        <span>updated {formatDecisionDate(log?.updatedAt)}</span>
      </div>

      {decisions.length === 0 ? (
        <p className="rounded border border-border/70 p-3 text-sm text-muted-foreground">
          No decisions recorded yet. Agents report decisions via POST /api/missions/{missionId}/decision-reports.
        </p>
      ) : (
        <ul className="space-y-2">
          {decisions.map((record) => (
            <li key={record.id} className="rounded border border-border/70 p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {record.id}
                    {record.supersedes ? (
                      <span className="ml-2 text-xs text-muted-foreground">supersedes {record.supersedes}</span>
                    ) : null}
                  </p>
                  <p className={`mt-1 ${record.status === "retired" ? "text-muted-foreground" : ""}`}>
                    {record.summary}
                  </p>
                </div>
                <span className={`text-xs font-medium ${statusClass(record.status)}`}>{record.status}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatDecisionDate(record.updatedAt)}</span>
                <span>{provenanceLabel(record)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {log?.stateMarkdown ? (
        <details className="rounded border border-border/70 p-3">
          <summary className="text-sm text-muted-foreground">Mission state (markdown)</summary>
          <pre className="mt-2 overflow-x-auto text-sm text-muted-foreground">{log.stateMarkdown}</pre>
        </details>
      ) : null}
    </section>
  );
}
