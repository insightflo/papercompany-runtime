import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ChevronDown, ChevronUp, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { approvalsApi, type HumanSummaryView } from "@/api/approvals";
import { agentsApi } from "@/api/agents";
import { L, useCompanyLanguage } from "../lib/companyLanguage";

/**
 * [휴먼카드 초보자 해석본 — 표시 전용 블록]
 * 계약: 카드 승인·거절 동작과 무관하게 표시만 담당. 해석 실패/없음이면 원문 폴백(이 블록만 조용히 사라진다).
 * 어댑터·모델 선택과 '다시 해석'은 board 권한 API(retranslate)만 쓴다.
 */

const SUPPORTED_ADAPTERS: Array<{ id: string; label: string; supported: boolean }> = [
  { id: "pi_local", label: "Pi (local)", supported: true },
  { id: "claude_local", label: "Claude (local)", supported: false },
  { id: "codex_local", label: "Codex (local)", supported: false },
];

/** 신형(Stage 3) 고정 축소 형식: 증상 ≤2줄 / 선택지 1줄 / 쉬운 해석 1문장. */
type CompactSummary = { symptom: string[]; optionsLine: string; interpretation: string };

/** summary_json 신형 판별 — 세 필드가 온전한 경우만 신형 렌더. 구 5섹션 행은 레거시 렌더 폴백. */
function asCompactSummary(value: unknown): CompactSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const symptom = (Array.isArray(v.symptom)
    ? v.symptom.flatMap((item) => String(item).split(/\r?\n/))
    : typeof v.symptom === "string" ? v.symptom.split(/\r?\n/) : [])
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  const single = (x: unknown) => (typeof x === "string" ? x.replace(/\s*\r?\n\s*/g, " ").trim() : "");
  const optionsLine = single(v.optionsLine);
  const interpretation = single(v.interpretation);
  if (symptom.length === 0 || !optionsLine || !interpretation) return null;
  return { symptom, optionsLine, interpretation };
}

export function CardHumanSummary({
  approvalId,
  companyId,
  summary: initialSummary,
  retranslate: retranslateFn,
  fetchCurrent,
}: {
  approvalId: string;
  companyId?: string | null;
  summary?: HumanSummaryView | null;
  /** 카드 종류별 재해석 API(기본: 승인 카드). 표시 전용 — 결정 동작과 무관. */
  retranslate?: (id: string, body: { adapterType?: string; model?: string }) => Promise<{ humanSummary: HumanSummaryView | null }>;
  /** 재해석 후 완료까지 폴링할 현재 카드 조회(기본: 승인 카드 GET). */
  fetchCurrent?: (id: string) => Promise<HumanSummaryView | null | undefined>;
}) {
  const lang = useCompanyLanguage();
  const [summary, setSummary] = useState<HumanSummaryView | null | undefined>(initialSummary);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adapter, setAdapter] = useState(initialSummary?.adapterType || "pi_local");
  const [model, setModel] = useState(initialSummary?.model || "");
  const [models, setModels] = useState<Array<{ id: string; label?: string }>>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setSummary(initialSummary); }, [initialSummary]);

  const pollUntilSettled = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const next = fetchCurrent
          ? await fetchCurrent(approvalId)
          : await approvalsApi.get(approvalId).then((fresh) => (fresh as { humanSummary?: HumanSummaryView | null }).humanSummary);
        if (next && next.status !== "pending") {
          setSummary(next);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        /* 표시 전용 — 조회 실패는 조용히 무시(원문 폴백) */
      }
      if (tries >= 15 && pollRef.current) clearInterval(pollRef.current);
    }, 4000);
  }, [approvalId, fetchCurrent]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    agentsApi.adapterModels(companyId, adapter)
      .then((rows) => { if (alive) setModels(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setModels([]); });
    return () => { alive = false; };
  }, [companyId, adapter]);

  if (!summary) return null; // 원문 폴백: 해석 없으면 아무것도 그리지 않는다

  const s = summary.summary;
  const compact = asCompactSummary(s); // 신형 3항목 행 판별(구 행은 null → 레거시 렌더)
  return (
    <div className="mt-3 rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-blue-900 dark:text-blue-200">
          <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          {L(lang, { en: "Easy summary (AI)", ko: "쉬운 해석 (AI)" })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {summary.status === "pending"
              ? L(lang, { en: "summarizing…", ko: "해석 중…" })
              : summary.status === "failed"
                ? L(lang, { en: "summary failed — see original above", ko: "해석 실패 — 아래 원문으로 판단" })
                : `${summary.adapterType}${summary.model ? ` · ${summary.model}` : ""}`}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-1.5 text-blue-950 dark:text-blue-100">
          {summary.status === "done" && s && (compact ? (
            <>
              <div className="space-y-0.5">
                {compact.symptom.map((line, i) => (
                  <p key={i} className={i === 0 ? "font-medium" : "text-[13px] leading-relaxed"}>{line}</p>
                ))}
              </div>
              <p className="text-[13px] leading-relaxed">
                <span className="font-medium">{L(lang, { en: "Options: ", ko: "선택지: " })}</span>
                {compact.optionsLine}
              </p>
              <p className="text-[13px] leading-relaxed">{compact.interpretation}</p>
              <p className="text-[12px] text-muted-foreground">
                {L(lang, {
                  en: "Detailed evidence is in the issue linked to this card.",
                  ko: "상세 근거는 이 카드에 연결된 이슈 링크에서 확인하세요.",
                })}
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">{s.oneLine}</p>
              <p className="text-[13px] leading-relaxed">{s.whatHappening}</p>
              <p className="text-[13px] leading-relaxed">
                <span className="font-medium">{L(lang, { en: "Decision needed: ", ko: "결정 필요: " })}</span>
                {s.decisionNeeded}
              </p>
              {s.options?.length ? (
                <ul className="text-[13px] leading-relaxed list-disc pl-4">
                  {s.options.map((o, i) => (
                    <li key={i}><span className="font-medium">{o.label}</span> — {o.meaning}</li>
                  ))}
                </ul>
              ) : null}
              {s.cautions?.length ? (
                <ul className="text-[12px] text-amber-800 dark:text-amber-300 list-disc pl-4">
                  {s.cautions.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              ) : null}
            </>
          ))}
          {summary.status === "failed" && summary.error && (
            <p className="text-[11px] text-muted-foreground break-all">{summary.error}</p>
          )}

          {/* 어댑터·모델 선택 + 다시 해석 (표시 전용 — 카드 결정 동작과 무관) */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-blue-200 dark:border-blue-900/60">
            <select
              aria-label={L(lang, { en: "adapter", ko: "어댑터" })}
              className="h-6 rounded border border-border bg-transparent text-[11px] px-1"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
            >
              {SUPPORTED_ADAPTERS.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.supported}>
                  {a.label}{a.supported ? "" : ` (${L(lang, { en: "later", ko: "지원 예정" })})`}
                </option>
              ))}
            </select>
            <select
              aria-label={L(lang, { en: "model", ko: "모델" })}
              className="h-6 max-w-56 rounded border border-border bg-transparent text-[11px] px-1"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{L(lang, { en: "(default)", ko: "(기본 모델)" })}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] px-2"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const call = retranslateFn ?? approvalsApi.retranslateSummary;
                  const res = await call(approvalId, { adapterType: adapter, model });
                  setSummary(res.humanSummary ?? null);
                  pollUntilSettled();
                } catch {
                  /* 표시 전용 — 실패는 상태 표시로 충분 */
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              {L(lang, { en: "Re-summarize", ko: "다시 해석" })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
