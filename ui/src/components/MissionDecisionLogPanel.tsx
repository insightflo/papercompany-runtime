import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Scale } from "lucide-react";
import {
  missionsApi,
  type MissionDecisionRecord,
  type MissionDecisionReportPayload,
  type MissionDecisionStatus,
} from "../api/missions";
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
 * [규칙 8] 결정 로그는 맥락 전달용 표시 상태다. board(운영자)는 이 패널에서 결정
 * 기록을 작성/은퇴할 수 있지만, 로그 자체는 어떤 실행 통제 판단의 근거 UI도 아니다.
 */
const fieldClass = "mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm";
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
  const queryClient = useQueryClient();
  const { data: log, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.decisionLog(missionId),
    queryFn: () => missionsApi.getDecisionLog(missionId),
    enabled: !!missionId,
  });

  const [decisionId, setDecisionId] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<MissionDecisionStatus>("confirmed");
  const [supersedes, setSupersedes] = useState("");

  const reportMutation = useMutation({
    mutationFn: (payload: MissionDecisionReportPayload) => missionsApi.reportDecisions(missionId, payload),
    onSuccess: async () => {
      setDecisionId("");
      setSummary("");
      setStatus("confirmed");
      setSupersedes("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions.decisionLog(missionId) });
    },
  });

  const retireMutation = useMutation({
    mutationFn: (payload: MissionDecisionReportPayload) => missionsApi.reportDecisions(missionId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions.decisionLog(missionId) });
    },
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
        <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
          board-authorable record
        </span>
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
          No decisions recorded yet. Agents and the board report decisions via POST /api/missions/{missionId}/decision-reports.
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
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatDecisionDate(record.updatedAt)}</span>
                <span>{provenanceLabel(record)}</span>
                {record.status === "confirmed" || record.status === "under_review" ? (
                  <button
                    type="button"
                    disabled={retireMutation.isPending}
                    onClick={() =>
                      retireMutation.mutate({ updates: [{ id: record.id, status: "retired" }] })
                    }
                    className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
                  >
                    Retire
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {retireMutation.error ? (
        <p className="text-sm text-destructive">
          {retireMutation.error instanceof Error
            ? retireMutation.error.message
            : "Failed to retire the decision."}
        </p>
      ) : null}

      <section className="rounded border border-border/70 p-3" aria-label="Record a decision">
        <h4 className="text-sm font-medium">Record a decision</h4>
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!decisionId.trim() || !summary.trim()) return;
            reportMutation.mutate({
              updates: [
                {
                  id: decisionId.trim(),
                  summary: summary.trim(),
                  status,
                  ...(supersedes.trim() ? { supersedes: supersedes.trim() } : {}),
                },
              ],
            });
          }}
        >
          <div>
            <label htmlFor="decision-id-input" className="text-xs font-medium">Decision id</label>
            <input
              id="decision-id-input"
              value={decisionId}
              onChange={(event) => setDecisionId(event.target.value)}
              placeholder="e.g. D-4"
              required
              maxLength={100}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="decision-summary-input" className="text-xs font-medium">Summary</label>
            <textarea
              id="decision-summary-input"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What was decided and why"
              required
              maxLength={2000}
              rows={3}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="decision-status-input" className="text-xs font-medium">Status</label>
            <select
              id="decision-status-input"
              value={status}
              onChange={(event) => setStatus(event.target.value as MissionDecisionStatus)}
              className={fieldClass}
            >
              <option value="under_review">under_review</option>
              <option value="confirmed">confirmed</option>
              <option value="retired">retired</option>
            </select>
          </div>
          <div>
            <label htmlFor="decision-supersedes-input" className="text-xs font-medium">Supersedes</label>
            <input
              id="decision-supersedes-input"
              value={supersedes}
              onChange={(event) => setSupersedes(event.target.value)}
              placeholder="Decision id this replaces (optional)"
              maxLength={100}
              className={fieldClass}
            />
          </div>
          <button
            type="submit"
            disabled={reportMutation.isPending}
            className="rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Record decision
          </button>
        </form>
        {reportMutation.error ? (
          <p className="mt-2 text-sm text-destructive">
            {reportMutation.error instanceof Error
              ? reportMutation.error.message
              : "Failed to record the decision."}
          </p>
        ) : null}
      </section>

      {log?.stateMarkdown ? (
        <details className="rounded border border-border/70 p-3">
          <summary className="text-sm text-muted-foreground">Mission state (markdown)</summary>
          <pre className="mt-2 overflow-x-auto text-sm text-muted-foreground">{log.stateMarkdown}</pre>
        </details>
      ) : null}
    </section>
  );
}
