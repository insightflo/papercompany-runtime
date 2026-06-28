/**
 * [파일 목적] Core Quality Board 운영 화면(Phase 4/5). company-scoped.
 *   - Summary 헤더 + 탭: Queue / Anchors / Evaluators / Reports.
 *   - Queue: review item 생성, verdict, evidence 요청/기록, anchor 승격.
 *   - Evaluators: candidate version/run, replay, production 승격(replay 통과 후).
 *   - Reports: 일일 품질 보고서 생성/조회.
 *
 * [외부 연결] ui/src/api/quality.ts, server routes/quality.ts, shared Quality* 타입.
 * [수정시 주의] verdict/evidence/evaluator 상태 전이는 server + shared QUALITY_* 상수와 같아야 함.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  AlertTriangle,
  CheckCircle2,
  Plus,
  FlaskConical,
  FileBarChart,
  Anchor,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { qualityApi } from "../api/quality";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import type {
  QualityDailyReport,
  QualityEvidenceStatus,
  QualityEvaluatorAnchorCase,
  QualityEvaluatorCandidateRun,
  QualityEvaluatorVersion,
  QualityReviewItemListItem,
  QualityTargetType,
  QualityTriggerSource,
  QualityVerdict,
} from "@paperclipai/shared";

const VERDICTS: QualityVerdict[] = ["pass", "fail", "request_changes", "needs_evidence", "dismissed"];

const STATUS_TONE: Record<string, string> = {
  detected: "bg-muted text-muted-foreground",
  awaiting_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  evidence_collecting: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  changes_requested: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  anchor_candidate: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  verdict_submitted: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  evaluator_replay_queued: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  evaluator_promoted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  evaluator_rejected: "bg-red-500/15 text-red-700 dark:text-red-400",
  resolved_pass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  resolved_fail: "bg-red-500/15 text-red-700 dark:text-red-400",
  dismissed: "bg-muted text-muted-foreground",
  closed: "bg-muted text-muted-foreground",
};

const PRIORITY_TONE: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/60",
};

const EVIDENCE_OPTIONS = ["verified", "failed", "insufficient", "missing", "stale", "not_applicable"];

type Tab = "queue" | "anchors" | "evaluators" | "reports";

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}

function isUnresolved(r: { status: string; blocking: boolean }) {
  return r.blocking || ["missing", "failed", "stale", "insufficient"].includes(r.status);
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className={cn("text-lg font-semibold", tone ?? "text-foreground")}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

export function Quality() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("queue");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [surfacesByItem, setSurfacesByItem] = useState<Record<string, string>>({});
  const [anchorTitleByItem, setAnchorTitleByItem] = useState<Record<string, string>>({});
  const [lastVerdictByItem, setLastVerdictByItem] = useState<Record<string, { verdictId: string; verdict: QualityVerdict }>>({});
  const [evidenceEdit, setEvidenceEdit] = useState<Record<string, string>>({});
  const [newItem, setNewItem] = useState({ title: "", targetType: "work_product", triggerSource: "manual", targetId: "", failureType: "" });

  useEffect(() => {
    setBreadcrumbs([{ label: "Quality" }]);
  }, [setBreadcrumbs]);

  const cid = selectedCompanyId;
  const invalidateQuality = () => {
    if (cid) queryClient.invalidateQueries({ queryKey: ["quality", cid] });
  };

  const { data: summary } = useQuery({
    queryKey: cid ? queryKeys.quality.summary(cid) : ["quality", "summary"],
    queryFn: () => qualityApi.summary(cid!),
    enabled: !!cid,
  });
  const { data: items, isLoading } = useQuery({
    queryKey: cid ? queryKeys.quality.reviewItems(cid) : ["quality", "review-items"],
    queryFn: () => qualityApi.listReviewItems(cid!),
    enabled: !!cid && tab === "queue",
  });
  const { data: anchors } = useQuery({
    queryKey: cid ? queryKeys.quality.anchors(cid) : ["quality", "anchors"],
    queryFn: () => qualityApi.listAnchors(cid!),
    enabled: !!cid && tab === "anchors",
  });
  const { data: versions } = useQuery({
    queryKey: cid ? queryKeys.quality.evaluatorVersions(cid) : ["quality", "evaluator-versions"],
    queryFn: () => qualityApi.listEvaluatorVersions(cid!),
    enabled: !!cid && tab === "evaluators",
  });
  const { data: runs } = useQuery({
    queryKey: cid ? queryKeys.quality.candidateRuns(cid) : ["quality", "candidate-runs"],
    queryFn: () => qualityApi.listCandidateRuns(cid!),
    enabled: !!cid && tab === "evaluators",
  });
  const { data: reports } = useQuery({
    queryKey: cid ? queryKeys.quality.dailyReports(cid) : ["quality", "daily-reports"],
    queryFn: () => qualityApi.listDailyReports(cid!),
    enabled: !!cid && tab === "reports",
  });

  function makeMut<TVars, TRes>(fn: (vars: TVars) => Promise<TRes>, label: string) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => invalidateQuality(),
      onError: (e: unknown) => setError(`${label}: ${e instanceof Error ? e.message : "failed"}`),
    });
  }

  const verdictMut = makeMut(
    (v: { itemId: string; body: { verdict: QualityVerdict; requiredEvidenceSurfaces?: string[] } }) =>
      qualityApi.recordVerdict(v.itemId, v.body),
    "Verdict",
  );
  const promoteMut = makeMut(
    (v: { itemId: string; verdictId: string; title: string }) =>
      qualityApi.promoteAnchor(v.itemId, v.verdictId, v.title),
    "Promote anchor",
  );
  const requestEvidenceMut = makeMut(
    (v: { itemId: string; surfaces: string[] }) =>
      qualityApi.requestEvidence(v.itemId, { requiredEvidenceSurfaces: v.surfaces }),
    "Request evidence",
  );
  const recordEvidenceMut = makeMut(
    (v: { itemId: string; surface: string; status: QualityEvidenceStatus }) =>
      qualityApi.recordEvidence(v.itemId, { surface: v.surface, status: v.status }),
    "Record evidence",
  );
  const createItemMut = makeMut(
    (v: { title: string; targetType: string; triggerSource: string; targetId?: string; failureType?: string }) =>
      qualityApi.createReviewItem(cid!, {
        title: v.title,
        targetType: v.targetType as QualityTargetType,
        triggerSource: v.triggerSource as QualityTriggerSource,
        targetId: v.targetId,
        failureType: v.failureType,
      }),
    "Create item",
  );
  const replayMut = makeMut(
    (v: { runId: string }) => qualityApi.replayCandidateRun(cid!, v.runId, {}),
    "Replay",
  );
  const promoteVersionMut = makeMut(
    (v: { versionId: string }) => qualityApi.promoteEvaluatorVersion(cid!, v.versionId),
    "Promote evaluator",
  );
  const generateReportMut = makeMut(
    (v: { reportDate?: string }) => qualityApi.generateDailyReport(cid!, v),
    "Generate report",
  );

  async function run<T>(key: string, p: Promise<T>): Promise<T> {
    setError(null);
    setBusy(key);
    try {
      return await p;
    } finally {
      setBusy(null);
    }
  }

  function handleVerdict(item: QualityReviewItemListItem, verdict: QualityVerdict) {
    const surfacesRaw = surfacesByItem[item.id]?.trim() ?? "";
    const requiredEvidenceSurfaces = verdict === "needs_evidence" && surfacesRaw ? surfacesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    void run(`${item.id}:verdict`, verdictMut.mutateAsync({ itemId: item.id, body: { verdict, requiredEvidenceSurfaces } })).then((result) => {
      // recordVerdict returns {verdict, reviewItem}; capture the verdict id so promote-anchor works without manual input.
      if (result?.verdict?.id) {
        setLastVerdictByItem((prev) => ({ ...prev, [item.id]: { verdictId: result.verdict.id, verdict: result.verdict.verdict } }));
      }
    });
  }

  if (!cid) return <PageSkeleton variant="list" />;

  const open = (items ?? []).filter((i) => !["resolved_pass", "resolved_fail", "dismissed", "closed"].includes(i.status));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">Quality</h1>
        </div>
        <div className="flex gap-2">
          <Metric label="open" value={summary?.openReviewItems ?? 0} />
          <Metric label="evidence gaps" value={summary?.blockingEvidenceGaps ?? 0} tone="text-red-600 dark:text-red-400" />
          <Metric label="anchor cand." value={summary?.anchorCandidates ?? 0} />
          <Metric label="evaluators" value={summary?.candidateEvaluators ?? 0} />
          <Metric label="reports" value={summary?.dailyReports ?? 0} />
        </div>
      </header>

      <nav className="flex gap-1 border-b border-border px-6 py-1.5">
        {([["queue", "Queue"], ["anchors", "Anchors"], ["evaluators", "Evaluators"], ["reports", "Reports"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn("rounded px-2.5 py-1 text-[12px] font-medium", tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50")}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        {tab === "queue" && (
          <div className="flex flex-col gap-3">
            <details className="rounded-lg border border-border bg-card p-3">
              <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium">
                <Plus className="h-4 w-4" /> Send to Quality Review (manual)
              </summary>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-[11px] text-muted-foreground">
                  title
                  <input className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-[12px]" value={newItem.title} onChange={(e) => setNewItem({ ...newItem, title: e.target.value })} />
                </label>
                <label className="flex flex-col text-[11px] text-muted-foreground">
                  target type
                  <select className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-[12px]" value={newItem.targetType} onChange={(e) => setNewItem({ ...newItem, targetType: e.target.value })}>
                    {["work_product", "public_url", "mission_output", "other"].map((o) => <option key={o}>{o}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-[11px] text-muted-foreground">
                  trigger
                  <select className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-[12px]" value={newItem.triggerSource} onChange={(e) => setNewItem({ ...newItem, triggerSource: e.target.value })}>
                    {["manual", "user_feedback", "delivery_verification", "post_completion_audit"].map((o) => <option key={o}>{o}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-[11px] text-muted-foreground">
                  target id
                  <input className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-[12px]" value={newItem.targetId} onChange={(e) => setNewItem({ ...newItem, targetId: e.target.value })} />
                </label>
                <label className="flex flex-col text-[11px] text-muted-foreground">
                  failure type
                  <input className="mt-0.5 rounded border border-border bg-background px-2 py-1 text-[12px]" value={newItem.failureType} onChange={(e) => setNewItem({ ...newItem, failureType: e.target.value })} />
                </label>
                <button
                  type="button"
                  disabled={!newItem.title.trim() || busy === "create"}
                  onClick={() => run("create", createItemMut.mutateAsync({ title: newItem.title, targetType: newItem.targetType, triggerSource: newItem.triggerSource, targetId: newItem.targetId || undefined, failureType: newItem.failureType || undefined })).then(() => setNewItem({ ...newItem, title: "", targetId: "", failureType: "" }))}
                  className="rounded border border-border bg-accent px-3 py-1 text-[12px] font-medium hover:bg-accent/70 disabled:opacity-50"
                >
                  add
                </button>
              </div>
            </details>

            {isLoading ? (
              <PageSkeleton variant="list" />
            ) : open.length === 0 ? (
              <EmptyState icon={ListChecks} message="No open quality review items." />
            ) : (
              open.map((item) => {
                const last = lastVerdictByItem[item.id];
                const unresolved = item.evidenceRefs.filter(isUnresolved);
                return (
                  <div key={item.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center gap-2">
                      <StatusPill status={item.status} />
                      <span className={cn("text-[11px] font-semibold uppercase", PRIORITY_TONE[item.priority] ?? "text-muted-foreground")}>{item.priority}</span>
                      <span className="text-[11px] text-muted-foreground">{item.triggerSource} · {item.targetType}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-foreground">{item.title}</p>
                    {item.targetId && <p className="text-[11px] text-muted-foreground truncate">{item.targetId}</p>}

                    {item.evidenceRefs.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {item.evidenceRefs.map((r) => {
                          const key = `${item.id}:${r.surface}`;
                          return (
                            <div key={r.id} className="flex items-center gap-2">
                              <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]", isUnresolved(r) ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
                                {isUnresolved(r) ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                                {r.surface}: {r.status}{r.blocking ? " (blocking)" : ""}
                              </span>
                              <select
                                className="rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                                value={evidenceEdit[key] ?? r.status}
                                onChange={(e) => setEvidenceEdit({ ...evidenceEdit, [key]: e.target.value })}
                              >
                                {EVIDENCE_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                              </select>
                              <button
                                type="button"
                                disabled={busy === key}
                                onClick={() => run(key, recordEvidenceMut.mutateAsync({ itemId: item.id, surface: r.surface, status: (evidenceEdit[key] ?? "verified") as QualityEvidenceStatus }))}
                                className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
                              >
                                record
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {unresolved.length > 0 && (
                      <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{unresolved.length} blocking/missing surface{unresolved.length > 1 ? "s" : ""}.</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <input
                        type="text"
                        placeholder="needs_evidence surfaces (comma-sep)"
                        value={surfacesByItem[item.id] ?? ""}
                        onChange={(e) => setSurfacesByItem({ ...surfacesByItem, [item.id]: e.target.value })}
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]"
                      />
                      <button type="button" className="rounded border border-blue-500/40 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-500/10 dark:text-blue-400" onClick={() => { const s = (surfacesByItem[item.id] ?? "").split(",").map((x) => x.trim()).filter(Boolean); if (s.length) run(`${item.id}:req`, requestEvidenceMut.mutateAsync({ itemId: item.id, surfaces: s })); }}>
                        request evidence
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {VERDICTS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          disabled={busy === `${item.id}:verdict`}
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
                          {v}
                        </button>
                      ))}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {!last?.verdictId && <span className="text-[11px] text-muted-foreground">record a verdict to enable anchor promotion</span>}
                      {last?.verdictId && (
                        <>
                          <span className="text-[11px] text-muted-foreground">last: {last.verdict}</span>
                          <input type="text" placeholder="anchor title" value={anchorTitleByItem[item.id] ?? ""} onChange={(e) => setAnchorTitleByItem({ ...anchorTitleByItem, [item.id]: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[11px]" />
                          <button type="button" disabled={busy === `${item.id}:anchor`} onClick={() => run(`${item.id}:anchor`, promoteMut.mutateAsync({ itemId: item.id, verdictId: last.verdictId, title: anchorTitleByItem[item.id]?.trim() || `Anchor: ${item.title}` }))} className="rounded border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-400">
                            promote anchor
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "anchors" && (
          (anchors ?? []).length === 0 ? <EmptyState icon={Anchor} message="No anchor cases yet. Promote a fail verdict to create one." /> : (
            <div className="flex flex-col gap-2">
              {(anchors ?? []).map((a: QualityEvaluatorAnchorCase) => (
                <div key={a.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                  <div className="flex items-center gap-2"><StatusPill status={a.status} /><span className="text-[11px] text-muted-foreground">{a.failureType ?? "no failure type"}</span></div>
                  <p className="mt-1 font-medium">{a.title}</p>
                  <p className="text-[11px] text-muted-foreground">verdict: {a.verdict} · {a.evidenceRefs.length} evidence ref{a.evidenceRefs.length === 1 ? "" : "s"}</p>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "evaluators" && (
          <div className="flex flex-col gap-4">
            <section>
              <h2 className="mb-2 text-[12px] font-semibold uppercase text-muted-foreground">Candidate versions</h2>
              {(versions ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No evaluator versions. Promoting an anchor seeds a candidate.</p> : (
                <div className="flex flex-col gap-2">
                  {(versions ?? []).map((v: QualityEvaluatorVersion) => {
                    const versionRuns = (runs ?? []).filter((r) => r.evaluatorVersionId === v.id);
                    const hasPassed = versionRuns.some((r) => r.status === "passed");
                    return (
                      <div key={v.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2"><StatusPill status={v.status} /><span className="font-medium">{v.name}</span></div>
                          <button type="button" disabled={v.status !== "candidate" || !hasPassed || busy === `pv:${v.id}`} onClick={() => run(`pv:${v.id}`, promoteVersionMut.mutateAsync({ versionId: v.id }))} className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400">
                            {v.status === "production" ? "production" : hasPassed ? "promote to production" : "replay required"}
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">{versionRuns.length} run(s): {versionRuns.map((r) => r.status).join(", ") || "none"}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-2 text-[12px] font-semibold uppercase text-muted-foreground">Replay runs</h2>
              {(runs ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No candidate runs.</p> : (
                <div className="flex flex-col gap-2">
                  {(runs ?? []).map((r: QualityEvaluatorCandidateRun) => (
                    <div key={r.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-2 text-sm">
                      <div className="flex items-center gap-2"><StatusPill status={r.status} /><span className="text-[11px] text-muted-foreground">{r.resultSummary ?? "queued"}</span></div>
                      <button type="button" disabled={busy === `replay:${r.id}`} onClick={() => run(`replay:${r.id}`, replayMut.mutateAsync({ runId: r.id }))} className="rounded border border-blue-500/40 px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400">
                        <FlaskConical className="mr-1 inline h-3 w-3" />replay
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === "reports" && (
          <div className="flex flex-col gap-3">
            <button type="button" disabled={busy === "gen"} onClick={() => run("gen", generateReportMut.mutateAsync({}))} className="self-start rounded border border-border bg-accent px-3 py-1.5 text-[12px] font-medium hover:bg-accent/70 disabled:opacity-50">
              <FileBarChart className="mr-1 inline h-3.5 w-3.5" />Generate today's report
            </button>
            {(reports ?? []).length === 0 ? <EmptyState icon={FileBarChart} message="No daily reports yet." /> : (
              <div className="flex flex-col gap-2">
                {(reports ?? []).map((rp: QualityDailyReport) => (
                  <div key={rp.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                    <div className="flex items-center gap-2"><StatusPill status={rp.status} /><span className="font-medium">{rp.reportDate}</span></div>
                    <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">{JSON.stringify(rp.summary, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
