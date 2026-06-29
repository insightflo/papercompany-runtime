/**
 * [파일 목적] Core Quality Board 운영 화면(Phase 4/5, 가독 개선). company-scoped.
 *   Queue: 왜 등록됐나 / 무엇을 판단 / 근거 / 현재 해결 여부 / 추천 액션 + 판정·증거·앵커 액션.
 *   Anchors: 판례 카드(교훈/근거/반영 상태). Evaluators: version/run 사람 문장 + 승격 게이트.
 *   Reports: 사람이 읽는 일일 보고서 + 최신성 경고.
 * [외부 연결] ui/src/api/quality.ts, ui/src/lib/quality-ui-helpers.ts, server routes/quality.ts.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  AlertTriangle,
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
import {
  anchorReflectionStatus,
  evidenceLine,
  isClosedStatus,
  isSmokeSignal,
  isUnresolvedEvidence,
  recommendAction,
  recommendedActionLabel,
  renderReportLines,
  replaySentence,
  triggerReason,
} from "../lib/quality-ui-helpers";
import type {
  QualityEvidenceStatus,
  QualityReviewItemListItem,
  QualityVerdict,
} from "@paperclipai/shared";

const VERDICTS: QualityVerdict[] = ["pass", "fail", "request_changes", "needs_evidence", "dismissed"];
const EVIDENCE_OPTIONS = ["verified", "failed", "insufficient", "missing", "stale", "not_applicable"];
type Tab = "queue" | "anchors" | "evaluators" | "reports";

const STATUS_TONE: Record<string, string> = {
  detected: "bg-muted text-muted-foreground",
  awaiting_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  evidence_collecting: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  changes_requested: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  anchor_candidate: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  evaluator_replay_queued: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  evaluator_promoted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  evaluator_rejected: "bg-red-500/15 text-red-700 dark:text-red-400",
  resolved_pass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  resolved_fail: "bg-red-500/15 text-red-700 dark:text-red-400",
  dismissed: "bg-muted text-muted-foreground",
  closed: "bg-muted text-muted-foreground",
  candidate: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  promoted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-red-500/15 text-red-700 dark:text-red-400",
  production: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  generated: "bg-muted text-muted-foreground",
  needs_attention: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  queued: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
  blocked: "bg-red-500/15 text-red-700 dark:text-red-400",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}

function SmokeBadge() {
  return <span className="inline-flex items-center rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">smoke/test</span>;
}

export function Quality() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("queue");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideSmoke, setHideSmoke] = useState(false);
  const [expandedReason, setExpandedReason] = useState<Record<string, boolean>>({});
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
    enabled: !!cid && (tab === "queue" || tab === "reports"),
  });
  const { data: anchors } = useQuery({
    queryKey: cid ? queryKeys.quality.anchors(cid) : ["quality", "anchors"],
    queryFn: () => qualityApi.listAnchors(cid!),
    enabled: !!cid && (tab === "anchors" || tab === "evaluators"),
  });
  const { data: versions } = useQuery({
    queryKey: cid ? queryKeys.quality.evaluatorVersions(cid) : ["quality", "evaluator-versions"],
    queryFn: () => qualityApi.listEvaluatorVersions(cid!),
    enabled: !!cid && (tab === "evaluators" || tab === "anchors"),
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
    (v: { itemId: string; verdictId: string; title: string }) => qualityApi.promoteAnchor(v.itemId, v.verdictId, v.title),
    "Promote anchor",
  );
  const requestEvidenceMut = makeMut(
    (v: { itemId: string; surfaces: string[] }) => qualityApi.requestEvidence(v.itemId, { requiredEvidenceSurfaces: v.surfaces }),
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
        targetType: v.targetType as never,
        triggerSource: v.triggerSource as never,
        targetId: v.targetId,
        failureType: v.failureType,
      }),
    "Create item",
  );
  const replayMut = makeMut((v: { runId: string }) => qualityApi.replayCandidateRun(cid!, v.runId, {}), "Replay");
  const promoteVersionMut = makeMut((v: { versionId: string }) => qualityApi.promoteEvaluatorVersion(cid!, v.versionId), "Promote evaluator");
  const generateReportMut = makeMut(() => qualityApi.generateDailyReport(cid!, {}), "Generate report");

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
      if (result?.verdict?.id) setLastVerdictByItem((prev) => ({ ...prev, [item.id]: { verdictId: result.verdict.id, verdict: result.verdict.verdict } }));
    });
  }

  if (!cid) return <PageSkeleton variant="list" />;

  const openItems = (items ?? []).filter((i) => !isClosedStatus(i.status));
  const visibleOpen = openItems.filter((i) => !hideSmoke || !isSmokeSignal(i));
  const itemsUpdatedAfter = (reportUpdatedAt: string | null) =>
    reportUpdatedAt ? (items ?? []).filter((i) => new Date(i.updatedAt).getTime() > new Date(reportUpdatedAt).getTime()).length : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">Quality</h1>
        </div>
        <div className="flex gap-2 text-center">
          {([
            ["open", summary?.openReviewItems ?? 0, false],
            ["evidence gaps", summary?.blockingEvidenceGaps ?? 0, true],
            ["anchor cand.", summary?.anchorCandidates ?? 0, false],
            ["evaluators", summary?.candidateEvaluators ?? 0, false],
            ["reports", summary?.dailyReports ?? 0, false],
          ] as Array<[string, number, boolean]>).map(([label, value, warn]) => (
            <div key={label} className="rounded-lg border border-border bg-card px-3 py-1.5">
              <div className={cn("text-base font-semibold", warn ? "text-red-600 dark:text-red-400" : "text-foreground")}>{value}</div>
              <div className="text-[11px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </header>

      <nav className="flex gap-1 border-b border-border px-6 py-1.5">
        {([["queue", "Queue"], ["anchors", "Anchors"], ["evaluators", "Evaluators"], ["reports", "Reports"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={cn("rounded px-2.5 py-1 text-[12px] font-medium", tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50")}>
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
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <input type="checkbox" checked={hideSmoke} onChange={(e) => setHideSmoke(e.target.checked)} />
              hide smoke/test items
            </label>

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
                <button type="button" disabled={!newItem.title.trim() || busy === "create"} onClick={() => run("create", createItemMut.mutateAsync({ title: newItem.title, targetType: newItem.targetType, triggerSource: newItem.triggerSource, targetId: newItem.targetId || undefined, failureType: newItem.failureType || undefined })).then(() => setNewItem({ ...newItem, title: "", targetId: "", failureType: "" }))} className="rounded border border-border bg-accent px-3 py-1 text-[12px] font-medium hover:bg-accent/70 disabled:opacity-50">
                  add
                </button>
              </div>
            </details>

            {isLoading ? (
              <PageSkeleton variant="list" />
            ) : visibleOpen.length === 0 ? (
              <EmptyState icon={ListChecks} message="No open quality review items." />
            ) : (
              visibleOpen.map((item) => {
                const last = lastVerdictByItem[item.id];
                const smoke = isSmokeSignal(item);
                const reason = triggerReason(item.triggerMetadata);
                const rec = recommendAction(item);
                const requestChangesRecommended = rec.action === "request_changes";
                const expanded = expandedReason[item.id] ?? false;
                return (
                  <div key={item.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={item.status} />
                      <span className="text-[11px] font-semibold uppercase text-muted-foreground">{item.priority}</span>
                      {smoke && <SmokeBadge />}
                      <span className="text-[11px] text-muted-foreground">why: {item.triggerSource}{item.failureType ? ` · ${item.failureType}` : ""}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-foreground">{item.title}</p>

                    {reason && (
                      <div className="mt-1 rounded border border-border/60 bg-muted/30 px-2 py-1 text-[12px] text-foreground/80">
                        {expanded || reason.length <= 160 ? reason : `${reason.slice(0, 160)}… `}
                        {reason.length > 160 && (
                          <button type="button" className="ml-1 text-[11px] text-blue-600 underline dark:text-blue-400" onClick={() => setExpandedReason((p) => ({ ...p, [item.id]: !p[item.id] }))}>
                            {expanded ? "less" : "more"}
                          </button>
                        )}
                      </div>
                    )}

                    <div className={cn("mt-2 rounded border px-2.5 py-1.5", rec.tone === "warn" ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/30")}>
                      <p className="text-[12px] font-medium text-foreground">Recommended action: {recommendedActionLabel(rec.action)}</p>
                      <p className={cn("mt-0.5 text-[11px]", rec.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{rec.why}</p>
                    </div>

                    <div className="mt-2">
                      <p className="text-[11px] font-medium text-muted-foreground">Evidence</p>
                      {item.evidenceRefs.length === 0 ? (
                        <p className={cn("text-[11px]", requestChangesRecommended ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
                          {requestChangesRecommended
                            ? "No structured evidence — but the trigger reason is enough to request changes. Optionally add a fresh probe if you want more."
                            : "No structured evidence — only the trigger reason above. Consider needs_evidence to request a fresh probe before judging."}
                        </p>
                      ) : (
                        <ul className="mt-0.5 flex flex-col gap-0.5">
                          {item.evidenceRefs.map((r) => {
                            const key = `${item.id}:${r.surface}`;
                            return (
                              <li key={r.id} className="flex flex-wrap items-center gap-2">
                                <span className={cn("text-[11px]", isUnresolvedEvidence(r) ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
                                  {isUnresolvedEvidence(r) ? "⚠ " : "✓ "}{evidenceLine(r)}
                                </span>
                                <select className="rounded border border-border bg-background px-1 py-0.5 text-[11px]" value={evidenceEdit[key] ?? r.status} onChange={(e) => setEvidenceEdit({ ...evidenceEdit, [key]: e.target.value })}>
                                  {EVIDENCE_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                                </select>
                                <button type="button" disabled={busy === key} onClick={() => run(key, recordEvidenceMut.mutateAsync({ itemId: item.id, surface: r.surface, status: (evidenceEdit[key] ?? "verified") as QualityEvidenceStatus }))} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">record</button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">Mission:</span>{" "}
                      {item.missionId ? (
                        <>
                          <Link to={`/missions/${item.missionId}`} className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
                            {item.missionTitle ?? "open mission"}
                          </Link>
                          {item.missionStatus ? ` (${item.missionStatus})` : ""}
                          <span className="ml-1 text-[10px] text-muted-foreground/70">{item.missionId.slice(0, 8)}</span>
                        </>
                      ) : item.missionTitle ? (
                        <span>{item.missionTitle}{item.missionStatus ? ` (${item.missionStatus})` : ""}</span>
                      ) : (
                        <span>no mission link; verify at the target</span>
                      )}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <input type="text" placeholder="evidence surfaces (comma-sep)" value={surfacesByItem[item.id] ?? ""} onChange={(e) => setSurfacesByItem({ ...surfacesByItem, [item.id]: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px]" />
                      <button type="button" className="rounded border border-blue-500/40 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400" disabled={busy === `${item.id}:req`} onClick={() => { const s = (surfacesByItem[item.id] ?? "").split(",").map((x) => x.trim()).filter(Boolean); if (s.length) void run(`${item.id}:req`, requestEvidenceMut.mutateAsync({ itemId: item.id, surfaces: s })); }}>
                        request evidence
                      </button>
                      {VERDICTS.map((v) => (
                        <button key={v} type="button" disabled={busy === `${item.id}:verdict`} onClick={() => handleVerdict(item, v)} className={cn("rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50",
                          v === rec.action && "ring-2 ring-offset-1 ring-offset-card font-bold ring-foreground/50",
                          v === "pass" && "border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400",
                          v === "fail" && "border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400",
                          v === "request_changes" && "border-orange-500/40 text-orange-700 hover:bg-orange-500/10 dark:text-orange-400",
                          v === "needs_evidence" && "border-blue-500/40 text-blue-700 hover:bg-blue-500/10 dark:text-blue-400",
                          v === "dismissed" && "border-border text-muted-foreground hover:bg-accent")}>
                          {v}
                        </button>
                      ))}
                    </div>

                    {last?.verdictId && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">last verdict: {last.verdict}</span>
                        <input type="text" placeholder="anchor title" value={anchorTitleByItem[item.id] ?? ""} onChange={(e) => setAnchorTitleByItem({ ...anchorTitleByItem, [item.id]: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[11px]" />
                        <button type="button" disabled={busy === `${item.id}:anchor`} onClick={() => run(`${item.id}:anchor`, promoteMut.mutateAsync({ itemId: item.id, verdictId: last.verdictId, title: anchorTitleByItem[item.id]?.trim() || `Anchor: ${item.title}` }))} className="rounded border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-400">promote anchor</button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "anchors" && (
          (anchors ?? []).length === 0 ? <EmptyState icon={Anchor} message="No anchor cases yet. Promote a fail verdict to create a precedent." /> : (
            <div className="flex flex-col gap-2">
              {(anchors ?? []).map((a) => {
                const reflection = anchorReflectionStatus(a, (versions ?? []).map((v) => ({ sourceAnchorCaseId: v.sourceAnchorCaseId, status: v.status })));
                return (
                  <div key={a.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={a.status} />
                      {isSmokeSignal({ title: a.title }) && <SmokeBadge />}
                      <span className="text-[11px] text-muted-foreground">{a.failureType ?? "no failure type"}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium">{a.title}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground"><span className="font-medium text-foreground">Precedent:</span> human verdict <b>{a.verdict}</b> on this failure type — treat similar future outputs the same way unless corrected.</p>
                    {a.evidenceRefs.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {a.evidenceRefs.map((r, idx) => <li key={idx} className="text-[11px] text-muted-foreground">{evidenceLine(r as never)}</li>)}
                      </ul>
                    )}
                    <p className="mt-2 text-[12px]">
                      <span className="font-medium text-foreground">Reflected in evaluator:</span>{" "}
                      {reflection.reflected ? <span className="text-emerald-600 dark:text-emerald-400">yes — version {reflection.versionStatus}</span> : <span className="text-amber-600 dark:text-amber-400">not yet — candidate evaluator not created</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          )
        )}

        {tab === "evaluators" && (
          <div className="flex flex-col gap-4">
            <section>
              <h2 className="mb-2 text-[12px] font-semibold uppercase text-muted-foreground">Candidate versions</h2>
              {(versions ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No evaluator versions. Promoting an anchor seeds a candidate.</p> : (
                <div className="flex flex-col gap-2">
                  {(versions ?? []).map((v) => {
                    const sourceAnchor = (anchors ?? []).find((a) => a.id === v.sourceAnchorCaseId);
                    const versionRuns = (runs ?? []).filter((r) => r.evaluatorVersionId === v.id);
                    const hasPassed = versionRuns.some((r) => r.status === "passed");
                    return (
                      <div key={v.id} className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill status={v.status} />
                            {sourceAnchor && isSmokeSignal({ title: sourceAnchor.title }) && <SmokeBadge />}
                            <span className="font-medium text-sm">{v.name}</span>
                          </div>
                          <button type="button" disabled={v.status !== "candidate" || !hasPassed || busy === `pv:${v.id}`} onClick={() => run(`pv:${v.id}`, promoteVersionMut.mutateAsync({ versionId: v.id }))} className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400" title="A passed replay run is required before production promotion.">
                            {v.status === "production" ? "production" : hasPassed ? "promote to production" : "replay required"}
                          </button>
                        </div>
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          <span className="font-medium text-foreground">Source anchor:</span> {sourceAnchor?.title ?? "—"}{sourceAnchor?.failureType ? ` · ${sourceAnchor.failureType}` : ""}
                        </p>
                        <p className="mt-1 text-[12px] text-muted-foreground">Production promotion requires a passed replay run (replay a candidate first).</p>
                        {versionRuns.length > 0 && (
                          <ul className="mt-1 flex flex-col gap-0.5">
                            {versionRuns.map((r) => (
                              <li key={r.id} className="flex items-center justify-between gap-2 text-[11px]">
                                <span className={cn(r.status === "passed" ? "text-emerald-600 dark:text-emerald-400" : r.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                                  {r.status}: {replaySentence(r)}
                                </span>
                                <button type="button" disabled={busy === `replay:${r.id}`} onClick={() => run(`replay:${r.id}`, replayMut.mutateAsync({ runId: r.id }))} className="rounded border border-blue-500/40 px-1.5 py-0.5 text-blue-700 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400">
                                  <FlaskConical className="mr-1 inline h-3 w-3" />replay
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
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
                {[...(reports ?? [])].sort((a, b) => (a.reportDate < b.reportDate ? 1 : -1)).map((rp) => {
                  const stale = itemsUpdatedAfter(rp.updatedAt);
                  return (
                    <div key={rp.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-center gap-2">
                        <StatusPill status={rp.status} />
                        <span className="font-medium">{rp.reportDate}</span>
                      </div>
                      <ul className="mt-2 flex flex-col gap-0.5">
                        {renderReportLines(rp.summary).map((line, idx) => <li key={idx} className="text-[12px] text-foreground/85">{line}</li>)}
                      </ul>
                      {stale !== null && stale > 0 && (
                        <p className="mt-2 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3 w-3" /> {stale} review item(s) updated since this report — consider regenerating.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
