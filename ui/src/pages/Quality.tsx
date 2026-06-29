/**
 * [파일 목적] Core Quality Board 운영 화면(Phase 4/5, 가독 개선). company-scoped.
 *   Queue: 왜 등록됐나 / 무엇을 판단 / 근거 / 현재 해결 여부 / 추천 액션 + 판정·증거·앵커 액션.
 *   Anchors: 판례 카드(교훈/근거/반영 상태). Evaluators: version/run 사람 문장 + 승격 게이트.
 *   Reports: 사람이 읽는 일일 보고서 + 최신성 경고.
 * [외부 연결] ui/src/api/quality.ts, ui/src/lib/quality-ui-helpers.ts, server routes/quality.ts.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  AlertTriangle,
  Plus,
  FlaskConical,
  FileBarChart,
  Anchor,
  HelpCircle,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
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
  qualityDecisionFocus,
  qualityItemDisplayTitle,
  qualityVerdictCommentDraft,
  qualityVerdictCommentPlaceholder,
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
const EVIDENCE_SURFACE_OPTIONS = [
  { value: "public_url", label: "public_url", description: "Published URL is reachable." },
  { value: "browser_readback", label: "browser_readback", description: "Rendered page/content is checked in a browser." },
  { value: "work_product", label: "work_product", description: "Registered work product or file resolves." },
  { value: "api_probe", label: "api_probe", description: "API or database probe confirms the state." },
] as const;
type Tab = "queue" | "anchors" | "evaluators" | "reports";
type VerdictDraft = {
  item: QualityReviewItemListItem;
  verdict: QualityVerdict;
  comment: string;
  requiredEvidenceSurfaces: string[];
};

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

function QualityHelp({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label} help`}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

type LastVerdict = { verdictId: string; verdict: QualityVerdict };

function inferredVerdictFromStatus(status: string): QualityVerdict | null {
  switch (status) {
    case "changes_requested":
      return "request_changes";
    case "evidence_collecting":
      return "needs_evidence";
    case "anchor_candidate":
    case "resolved_fail":
      return "fail";
    case "resolved_pass":
      return "pass";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}

function reviewCompletionCopy(item: QualityReviewItemListItem, last: LastVerdict | undefined): {
  verdict: QualityVerdict;
  title: string;
  body: string;
  tone: "success" | "info" | "warn";
} | null {
  const verdict = last?.verdict ?? inferredVerdictFromStatus(item.status);
  if (!verdict) return null;

  switch (verdict) {
    case "request_changes":
      return {
        verdict,
        title: "Human review complete",
        body: "Recorded verdict: Request changes. The correction flow is open; no more Quality input is required here unless this verdict was wrong.",
        tone: "warn",
      };
    case "needs_evidence":
      return {
        verdict,
        title: "Evidence request sent",
        body: "Recorded verdict: Needs evidence. Wait for the named evidence surfaces, then review can resume.",
        tone: "info",
      };
    case "fail":
      return {
        verdict,
        title: "Human review complete",
        body: "Recorded verdict: Fail. No more verdict input is required; optionally teach the evaluator if this should become a reusable rule.",
        tone: "warn",
      };
    case "pass":
      return {
        verdict,
        title: "Human review complete",
        body: "Recorded verdict: Pass. This quality item is done.",
        tone: "success",
      };
    case "dismissed":
      return {
        verdict,
        title: "Human review complete",
        body: "Recorded verdict: Dismiss. This item is no longer part of the active quality queue.",
        tone: "info",
      };
    default:
      return null;
  }
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
  const [editingVerdictByItem, setEditingVerdictByItem] = useState<Record<string, boolean>>({});
  const [anchorTitleByItem, setAnchorTitleByItem] = useState<Record<string, string>>({});
  const [lastVerdictByItem, setLastVerdictByItem] = useState<Record<string, { verdictId: string; verdict: QualityVerdict }>>({});
  const [evidenceEdit, setEvidenceEdit] = useState<Record<string, string>>({});
  const [newItem, setNewItem] = useState({ title: "", targetType: "work_product", triggerSource: "manual", targetId: "", failureType: "" });
  const [verdictDraft, setVerdictDraft] = useState<VerdictDraft | null>(null);

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
    (v: { itemId: string; body: { verdict: QualityVerdict; reason?: string; requiredEvidenceSurfaces?: string[] } }) =>
      qualityApi.recordVerdict(v.itemId, v.body),
    "Verdict",
  );
  const promoteMut = makeMut(
    (v: { itemId: string; verdictId: string; title: string }) => qualityApi.promoteAnchor(v.itemId, v.verdictId, v.title),
    "Promote anchor",
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

  function openVerdictDraft(item: QualityReviewItemListItem, verdict: QualityVerdict) {
    setVerdictDraft({
      item,
      verdict,
      comment: qualityVerdictCommentDraft(item, verdict),
      requiredEvidenceSurfaces: [],
    });
  }

  function toggleEvidenceSurface(surface: string) {
    setVerdictDraft((draft) => {
      if (!draft) return draft;
      const selected = draft.requiredEvidenceSurfaces.includes(surface);
      return {
        ...draft,
        requiredEvidenceSurfaces: selected
          ? draft.requiredEvidenceSurfaces.filter((s) => s !== surface)
          : [...draft.requiredEvidenceSurfaces, surface],
      };
    });
  }

  function submitVerdictDraft() {
    if (!verdictDraft) return;
    const { item, verdict, comment } = verdictDraft;
    const requiredEvidenceSurfaces = verdict === "needs_evidence" ? verdictDraft.requiredEvidenceSurfaces : undefined;
    const reason = comment.trim() || undefined;
    setVerdictDraft(null);
    void run(`${item.id}:verdict`, verdictMut.mutateAsync({ itemId: item.id, body: { verdict, reason, requiredEvidenceSurfaces } })).then((result) => {
      if (result?.verdict?.id) {
        setLastVerdictByItem((prev) => ({ ...prev, [item.id]: { verdictId: result.verdict.id, verdict: result.verdict.verdict } }));
        setEditingVerdictByItem((prev) => ({ ...prev, [item.id]: false }));
      }
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
          <QualityHelp label="Quality Board">
            Use Quality Board to make human quality decisions on outputs. This is not the mission execution screen; record rework requests or evidence requests here.
          </QualityHelp>
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
        <QualityHelp label={`${tab} tab`}>
          {tab === "queue" && "Queue contains quality items that need a human decision now. Follow the recommendation when the visible reason is enough; choose Needs evidence only when you cannot judge yet."}
          {tab === "anchors" && "Anchors are reusable precedents created from human verdicts. They help the evaluator catch the same kind of failure next time."}
          {tab === "evaluators" && "Evaluators are candidate automated checks created from anchors. Promote only candidates that pass replay."}
          {tab === "reports" && "Reports are dated summaries of Quality Board state. Regenerate a report after review items change."}
        </QualityHelp>
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
              <QualityHelp label="hide smoke items">
                Hide test-only quality items so the queue focuses on real user-facing output decisions.
              </QualityHelp>
            </label>

            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-semibold text-foreground">Queue review flow</span>
                <QualityHelp label="queue review flow">
                  Judge the target output, record one verdict, then stop. Anchor promotion is optional learning, not required rework routing.
                </QualityHelp>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <span className="rounded bg-background px-1.5 py-0.5">1. Judge target</span>
                <span className="rounded bg-background px-1.5 py-0.5">2. Record verdict</span>
                <span className="rounded bg-background px-1.5 py-0.5">3. Done for reviewer</span>
                <span className="rounded bg-background px-1.5 py-0.5">4. Optional: teach evaluator</span>
              </div>
            </div>

            <details className="rounded-lg border border-border bg-card p-3">
              <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium">
                <Plus className="h-4 w-4" /> Send to Quality Review (manual)
                <QualityHelp label="manual review item">
                  Create a quality review item manually when an output was not queued automatically. Add a title and target id so reviewers know what to inspect.
                </QualityHelp>
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
                const decisionFocus = qualityDecisionFocus(item);
                const displayTitle = qualityItemDisplayTitle(item);
                const requestChangesRecommended = rec.action === "request_changes";
                const expanded = expandedReason[item.id] ?? false;
                const completion = reviewCompletionCopy(item, last);
                const editingVerdict = editingVerdictByItem[item.id] ?? !completion;
                return (
                  <div key={item.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={item.status} />
                      <span className="text-[11px] font-semibold uppercase text-muted-foreground">{item.priority}</span>
                      {smoke && <SmokeBadge />}
                      <span className="text-[11px] text-muted-foreground">why: {item.triggerSource}{item.failureType ? ` · ${item.failureType}` : ""}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-foreground">{displayTitle}</p>

                    {decisionFocus && (
                      <div className="mt-2 rounded border border-border bg-background/45 px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-[12px] font-semibold text-foreground">Decision focus</p>
                          {decisionFocus.source === "fallback" && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">derived from QA text</span>}
                          <QualityHelp label="decision focus">
                            Start here. This block names the output or step to judge, the plan or goal it was checked against, what mismatched, and the action the board recommends.
                          </QualityHelp>
                        </div>
                        <dl className="mt-2 grid gap-1.5">
                          {decisionFocus.rows.map((row) => (
                            <div key={row.label} className="grid gap-0.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                              <dt className="text-[11px] font-medium text-muted-foreground">{row.label}</dt>
                              <dd className={cn(
                                "min-w-0 break-words text-[12px] leading-relaxed",
                                row.mono && "font-mono",
                                row.tone === "warn" ? "text-amber-700 dark:text-amber-400" : row.tone === "muted" ? "text-muted-foreground" : "text-foreground/90",
                              )}>
                                {row.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}

                    {completion ? (
                      <div className={cn(
                        "mt-2 rounded border px-2.5 py-2",
                        completion.tone === "success" && "border-emerald-500/40 bg-emerald-500/5",
                        completion.tone === "info" && "border-blue-500/40 bg-blue-500/5",
                        completion.tone === "warn" && "border-orange-500/40 bg-orange-500/5",
                      )}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[12px] font-semibold text-foreground">{completion.title}</p>
                              <QualityHelp label="review complete">
                                The human verdict has been recorded. You do not need to do another Quality Board action unless you want to correct the verdict or optionally teach the evaluator.
                              </QualityHelp>
                            </div>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">{completion.body}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setEditingVerdictByItem((prev) => ({ ...prev, [item.id]: true }))}
                            className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
                          >
                            Edit verdict
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className={cn("mt-2 rounded border px-2.5 py-1.5", rec.tone === "warn" ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/30")}>
                        <div className="flex items-center gap-1.5">
                          <p className="text-[12px] font-medium text-foreground">Recommended action: {recommendedActionLabel(rec.action)}</p>
                          <QualityHelp label="recommended action">
                            This is the verdict that best matches the visible reason and evidence. If it matches your judgment, choose the matching verdict button.
                          </QualityHelp>
                        </div>
                        <p className={cn("mt-0.5 text-[11px]", rec.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{rec.why}</p>
                      </div>
                    )}

                    {reason && (
                      <div className="mt-2">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[11px] font-medium text-muted-foreground">Raw QA excerpt</p>
                          <QualityHelp label="raw QA excerpt">
                            This is the original trigger text. Use it to audit details after reading Decision focus and Recommended action.
                          </QualityHelp>
                        </div>
                        <div className="mt-0.5 rounded border border-border/60 bg-muted/30 px-2 py-1 text-[12px] text-foreground/80">
                          {expanded || reason.length <= 160 ? reason : `${reason.slice(0, 160)}... `}
                          {reason.length > 160 && (
                            <button type="button" className="ml-1 text-[11px] text-blue-600 underline dark:text-blue-400" onClick={() => setExpandedReason((p) => ({ ...p, [item.id]: !p[item.id] }))}>
                              {expanded ? "less" : "more"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mt-2">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[11px] font-medium text-muted-foreground">Evidence</p>
                        <QualityHelp label="evidence">
                          The trigger reason explains why this item was queued. If the required proof is missing and you cannot judge yet, choose Needs evidence and name the missing surfaces there.
                        </QualityHelp>
                      </div>
                      {item.evidenceRefs.length === 0 ? (
                        <p className={cn("text-[11px]", requestChangesRecommended ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
                          {requestChangesRecommended
                            ? "No structured evidence — but the trigger reason is enough to request changes. Use Needs evidence only if a required proof surface is actually missing."
                            : "No structured evidence — only the trigger reason above. Choose Needs evidence if that means you cannot judge yet."}
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

                    <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{decisionFocus ? "Mission context:" : "Mission:"}</span>
                      <QualityHelp label="mission link">
                        Open the source mission for context. A completed mission does not automatically pass this quality item; judge the target step or output shown above.
                      </QualityHelp>
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

                    {editingVerdict && (
                      <div className={cn("mt-2 flex flex-wrap items-center gap-1.5", completion && "rounded border border-border bg-muted/20 px-2.5 py-2")}>
                        {completion && <span className="mr-1 text-[11px] font-medium text-foreground">Edit recorded verdict</span>}
                        <QualityHelp label="verdict buttons">
                          pass means the output meets the bar. fail means it fails outright. request_changes sends it back for rework. Needs evidence means you cannot judge yet and need more proof. dismissed means duplicate or not relevant.
                        </QualityHelp>
                        {VERDICTS.map((v) => (
                          <button key={v} type="button" disabled={busy === `${item.id}:verdict`} onClick={() => openVerdictDraft(item, v)} className={cn("rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50",
                            v === rec.action && !completion && "ring-2 ring-offset-1 ring-offset-card font-bold ring-foreground/50",
                            v === completion?.verdict && "ring-2 ring-offset-1 ring-offset-card ring-foreground/40",
                            v === "pass" && "border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400",
                            v === "fail" && "border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400",
                            v === "request_changes" && "border-orange-500/40 text-orange-700 hover:bg-orange-500/10 dark:text-orange-400",
                            v === "needs_evidence" && "border-blue-500/40 text-blue-700 hover:bg-blue-500/10 dark:text-blue-400",
                            v === "dismissed" && "border-border text-muted-foreground hover:bg-accent")}>
                            {recommendedActionLabel(v)}
                          </button>
                        ))}
                        {completion && (
                          <button
                            type="button"
                            onClick={() => setEditingVerdictByItem((prev) => ({ ...prev, [item.id]: false }))}
                            className="rounded border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
                          >
                            Cancel edit
                          </button>
                        )}
                      </div>
                    )}

                    {last?.verdictId && (
                      <details className="mt-2 rounded border border-border bg-muted/20 px-2.5 py-2">
                        <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                          Optional: teach evaluator from this verdict
                        </summary>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">Recorded verdict: {recommendedActionLabel(last.verdict)}</span>
                          <input type="text" placeholder="anchor title" value={anchorTitleByItem[item.id] ?? ""} onChange={(e) => setAnchorTitleByItem({ ...anchorTitleByItem, [item.id]: e.target.value })} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[11px]" />
                          <QualityHelp label="promote anchor">
                            Promote a verdict only when it should become reusable precedent for similar failures. This is optional learning, not required to finish the request-changes flow.
                          </QualityHelp>
                          <button type="button" disabled={busy === `${item.id}:anchor`} onClick={() => run(`${item.id}:anchor`, promoteMut.mutateAsync({ itemId: item.id, verdictId: last.verdictId, title: anchorTitleByItem[item.id]?.trim() || `Anchor: ${item.title}` }))} className="rounded border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-400">Promote anchor</button>
                        </div>
                      </details>
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
              <div className="mb-2 flex items-center gap-1.5">
                <h2 className="text-[12px] font-semibold uppercase text-muted-foreground">Candidate versions</h2>
                <QualityHelp label="candidate evaluator versions">
                  Candidate versions are automated evaluator drafts created from anchors. Replay past cases first, then promote only candidates that pass.
                </QualityHelp>
              </div>
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
                          <div className="flex items-center gap-1.5">
                            <button type="button" disabled={v.status !== "candidate" || !hasPassed || busy === `pv:${v.id}`} onClick={() => run(`pv:${v.id}`, promoteVersionMut.mutateAsync({ versionId: v.id }))} className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400" title="A passed replay run is required before production promotion.">
                              {v.status === "production" ? "production" : hasPassed ? "promote to production" : "replay required"}
                            </button>
                            <QualityHelp label="promote evaluator">
                              Production is the live operating evaluator. Promote only when the candidate has passed replay.
                            </QualityHelp>
                          </div>
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
                                <div className="flex items-center gap-1.5">
                                  <button type="button" disabled={busy === `replay:${r.id}`} onClick={() => run(`replay:${r.id}`, replayMut.mutateAsync({ runId: r.id }))} className="rounded border border-blue-500/40 px-1.5 py-0.5 text-blue-700 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400">
                                    <FlaskConical className="mr-1 inline h-3 w-3" />replay
                                  </button>
                                  <QualityHelp label="replay evaluator">
                                    Replay applies a candidate evaluator to past anchor cases to confirm it produces the expected judgment.
                                  </QualityHelp>
                                </div>
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
            <div className="flex items-center gap-1.5">
              <button type="button" disabled={busy === "gen"} onClick={() => run("gen", generateReportMut.mutateAsync({}))} className="rounded border border-border bg-accent px-3 py-1.5 text-[12px] font-medium hover:bg-accent/70 disabled:opacity-50">
                <FileBarChart className="mr-1 inline h-3.5 w-3.5" />Generate today's report
              </button>
              <QualityHelp label="daily report">
                Save the current queue and verdict state as today's report. Regenerate it after review items change so the summary stays current.
              </QualityHelp>
            </div>
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

      <Dialog open={!!verdictDraft} onOpenChange={(open) => !open && setVerdictDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Record {verdictDraft ? recommendedActionLabel(verdictDraft.verdict) : "verdict"}</DialogTitle>
            <DialogDescription>
              {verdictDraft?.verdict === "needs_evidence"
                ? "This is the evidence request flow. Record it when you cannot judge yet, then name the missing evidence surfaces below."
                : verdictDraft?.verdict === "request_changes"
                  ? "This note is saved with the human verdict. Write the rework instruction; do not ask for fresh evidence unless evidence is actually missing."
                  : "This note is saved with the human verdict."}
            </DialogDescription>
          </DialogHeader>
          {verdictDraft && (
            <div className="grid gap-3">
              <div className="rounded border border-border bg-muted/30 px-2.5 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">Review item</p>
                <p className="mt-0.5 break-words text-sm font-medium text-foreground">{qualityItemDisplayTitle(verdictDraft.item)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Verdict: <span className="font-medium text-foreground">{verdictDraft.verdict}</span>
                </p>
              </div>
              <label className="grid gap-1.5">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                  Verdict note
                  <QualityHelp label="verdict note">
                    This text becomes the instruction attached to the verdict. Request changes should say what to fix and where to send the work next.
                  </QualityHelp>
                </span>
                <Textarea
                  value={verdictDraft.comment}
                  onChange={(event) => setVerdictDraft({ ...verdictDraft, comment: event.target.value })}
                  placeholder={qualityVerdictCommentPlaceholder(verdictDraft.verdict)}
                  className="min-h-36 text-sm"
                />
              </label>
              {verdictDraft.verdict === "needs_evidence" && (
                <div className="grid gap-1.5">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                    Required evidence surfaces
                    <QualityHelp label="required evidence surfaces">
                      Select the evidence surfaces that must be checked before a human can judge. Inactive chips are available choices; active chips will be requested.
                    </QualityHelp>
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {EVIDENCE_SURFACE_OPTIONS.map((option) => {
                      const selected = verdictDraft.requiredEvidenceSurfaces.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          title={option.description}
                          onClick={() => toggleEvidenceSurface(option.value)}
                          className={cn(
                            "rounded border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-muted/20 text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Select at least one surface to send the evidence request.
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <button type="button" onClick={() => setVerdictDraft(null)} className="rounded border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button
              type="button"
              disabled={
                !verdictDraft ||
                busy === `${verdictDraft.item.id}:verdict` ||
                (verdictDraft.verdict === "needs_evidence" && verdictDraft.requiredEvidenceSurfaces.length === 0)
              }
              onClick={submitVerdictDraft}
              className="rounded border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Record verdict
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
