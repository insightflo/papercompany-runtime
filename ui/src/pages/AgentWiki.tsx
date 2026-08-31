// ui/src/pages/AgentWiki.tsx
//
// [목적] Core agent 자가학습 wiki 조회 페이지(별도 메뉴). 어떤 실패 패턴이 (company, agent)
//   단위로 얼마나 축적되고 있는지(entries) + 최근 실패 발생 추이(timeseries)를 한 화면에서 본다.
//   위키는 CORE(heartbeat hook → recordFailure 축적 → adapter 실행 전 prompt 주입)이므로
//   plugin이 아닌 독립 메뉴로 노출한다.
// [외부 연결] agentWikiApi → GET /api/companies/:id/agent-wiki.
import { Fragment, useMemo, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { agentWikiApi } from "../api/agentWiki";
import { knowledgePatternsApi, type KnowledgePatternCardDto } from "../api/knowledgePatterns";
import { useCompany } from "../context/CompanyContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

const DAY_OPTIONS = [7, 14, 30];

const STATUS_STYLE: Record<string, string> = {
  active: "bg-red-500/15 text-red-400",
  resolved: "bg-emerald-500/15 text-emerald-400",
  closed: "bg-zinc-500/15 text-zinc-400",
};

const CHART_COLORS = ["#f85149", "#58a6ff", "#d29922", "#3fb950", "#bc8cff", "#ff7b72", "#79c0ff", "#e3b341"];

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "-";
}

function AgentWikiTimeseries({ points }: { points: { day: string; errorCode: string | null; count: number }[] }) {
  const model = useMemo(() => {
    const codes = Array.from(new Set(points.map((p) => p.errorCode ?? "(none)")));
    const codeColor: Record<string, string> = {};
    codes.forEach((c, i) => (codeColor[c] = CHART_COLORS[i % CHART_COLORS.length]));
    const days = Array.from(new Set(points.map((p) => p.day))).sort();
    const byDay: Record<string, Record<string, number>> = {};
    days.forEach((d) => (byDay[d] = {}));
    points.forEach((p) => {
      const key = p.errorCode ?? "(none)";
      byDay[p.day][key] = (byDay[p.day][key] ?? 0) + p.count;
    });
    const max = Math.max(1, ...days.map((d) => Object.values(byDay[d]).reduce((a, b) => a + b, 0)));
    return { codes, codeColor, days, byDay, max };
  }, [points]);

  if (!model.days.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">최근 실패 기록이 없습니다.</p>;
  }

  const W = 920, H = 240, PL = 34, PR = 12, PT = 16, PB = 30;
  const slot = (W - PL - PR) / model.days.length;
  const BW = Math.max(6, slot - 6);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 240 }} preserveAspectRatio="xMidYMid meet">
        <text x={PL} y={PT - 4} fill="#8b949e" fontSize="11">{model.max} ← max</text>
        {model.days.map((d, i) => {
          const x = PL + i * slot;
          let y = H - PB;
          const segs: ReactElement[] = [];
          model.codes.forEach((c) => {
            const v = model.byDay[d][c] ?? 0;
            if (!v) return;
            const h = (v / model.max) * (H - PT - PB);
            segs.push(
              <rect key={`${d}-${c}`} x={x} y={y - h} width={BW} height={h} fill={model.codeColor[c]}>
                <title>{d} · {c}: {v}</title>
              </rect>,
            );
            y -= h;
          });
          const labelTick = Math.ceil(model.days.length / 8);
          return (
            <g key={d}>
              {segs}
              {i % labelTick === 0 || i === model.days.length - 1 ? (
                <text x={x} y={H - PB + 16} fill="#8b949e" fontSize="10">{d.slice(5)}</text>
              ) : null}
            </g>
          );
        })}
        <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="#30363d" />
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {model.codes.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: model.codeColor[c] }} />
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}


const KIND_STYLE: Record<string, string> = {
  failure_mode: "bg-red-500/15 text-red-400",
  success_recipe: "bg-emerald-500/15 text-emerald-400",
  constraint: "bg-blue-500/15 text-blue-400",
};

const SOURCE_LABEL: Record<string, string> = {
  mission_owner_compile: "오너 컴파일",
  agent_candidate: "에이전트 제안",
  operator: "운영자",
  auto_rework_draft: "자동 초안",
};

function PatternCardsSection({ companyId }: { companyId: string }) {
  const [q, setQ] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["knowledge-patterns", companyId, q, includeSuperseded],
    queryFn: () => knowledgePatternsApi.list(companyId, { q, includeSuperseded }),
  });

  // [P1] 자동 초안 승인 — 사람 전용 활성화 경로. 성공 시 카드 목록 재조회.
  const approveMutation = useMutation({
    mutationFn: (patternId: string) => knowledgePatternsApi.approve(companyId, patternId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge-patterns", companyId] });
    },
  });

  const patterns = data?.patterns ?? [];
  const draftCount = patterns.filter((card) => card.status === "draft").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          🗂️ 사고→패턴 카드 ({patterns.length}){draftCount > 0 ? <span className="ml-2 text-xs font-semibold text-amber-400">초안 {draftCount}건 승인 대기</span> : null}
        </CardTitle>
        <CardDescription>
          오너/운영자가 큐레이션한 사고 패턴 원장(append-only). 기계 교정 반복 감지 시 자동 초안이
          생성되며 사람 승인 전까지는 검색·주입 어디에도 쓰이지 않습니다. 실행 프롬프트 주입은 별도
          계약(게이트+측정 롤아웃)으로만 — 위 자가학습 교훈(자동 주입)과는 별개 층입니다.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="제목·증상·근본원인 검색"
            className="h-8 w-64"
          />
          <Button variant={includeSuperseded ? "default" : "outline"} size="sm" onClick={() => setIncludeSuperseded((v) => !v)}>
            대체 이력 포함
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중…</p>
        ) : isError ? (
          <p className="text-sm text-red-400">조회 실패: {(error as Error)?.message ?? "unknown"}</p>
        ) : patterns.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">등록된 패턴 카드가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2">종류</th>
                  <th className="px-2 py-2">제목 / 요약</th>
                  <th className="px-2 py-2">태그</th>
                  <th className="px-2 py-2">출처</th>
                  <th className="px-2 py-2">생성(KST)</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((card: KnowledgePatternCardDto) => {
                  const createdKst = new Date(card.createdAt).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
                  const superseded = !!card.supersededById;
                  const isDraft = card.status === "draft";
                  const expanded = expandedId === card.id;
                  return (
                    <Fragment key={card.id}>
                      <tr
                        className={cn("cursor-pointer border-b align-top hover:bg-muted/40", superseded && "opacity-60")}
                        onClick={() => setExpandedId(expanded ? null : card.id)}
                      >
                        <td className="px-2 py-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", KIND_STYLE[card.kind] ?? "bg-zinc-500/15 text-zinc-400")}>
                            {card.kind}
                          </span>
                          {isDraft ? <div className="mt-1 text-[10px] font-semibold text-amber-400">초안(승인 대기)</div> : null}
                          {superseded ? <div className="mt-1 text-[10px] text-muted-foreground">대체됨</div> : null}
                        </td>
                        <td className="max-w-[420px] px-2 py-2 font-medium">
                          {card.title}
                          <div className="text-[11px] font-normal text-muted-foreground">{card.summary}</div>
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {card.scopeTags.length > 0 ? card.scopeTags.map((t) => `#${t}`).join(" ") : "-"}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {SOURCE_LABEL[card.source] ?? card.source}
                          {isDraft ? (
                            <div className="mt-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                                disabled={approveMutation.isPending}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  approveMutation.mutate(card.id);
                                }}
                              >
                                승인
                              </Button>
                              {approveMutation.isError ? <div className="mt-1 text-[10px] text-red-400">승인 실패</div> : null}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{createdKst}</td>
                      </tr>
                      {expanded ? (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={5} className="px-4 py-3 text-xs">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div><span className="font-semibold text-amber-400">증상</span><div className="text-muted-foreground">{card.symptoms ?? "-"}</div></div>
                              <div><span className="font-semibold text-amber-400">근본원인</span><div className="text-muted-foreground">{card.rootCause ?? "-"}</div></div>
                              <div><span className="font-semibold text-emerald-400">해결/통한 것</span><div className="text-muted-foreground">{card.whatWorked ?? "-"}</div></div>
                              <div>
                                <span className="font-semibold text-blue-400">증거 참조</span>
                                <div className="text-muted-foreground">
                                  {card.evidence.length === 0 ? "-" : card.evidence.map((ref, i) => (
                                    <div key={i}>{ref.type}:{ref.id}{ref.note ? ` (${ref.note})` : ""}</div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentWiki() {
  const { selectedCompanyId } = useCompany();
  const [days, setDays] = useState(14);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agent-wiki", selectedCompanyId, days],
    queryFn: () => agentWikiApi.get(selectedCompanyId!, days),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <p className="p-6 text-sm text-muted-foreground">회사를 선택하세요.</p>;
  }

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Brain className="h-5 w-5" /> Agent 자가학습 Wiki
          </h1>
          <p className="text-sm text-muted-foreground">
            반복 실패에서 자동 축적된 교훈. 같은 step을 만나면 에이전트 프롬프트에 자동 주입됩니다.
          </p>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((d) => (
            <Button key={d} variant={d === days ? "default" : "outline"} size="sm" onClick={() => setDays(d)}>
              {d}일
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">불러오는 중…</p>
      ) : isError ? (
        <p className="text-sm text-red-400">조회 실패: {(error as Error)?.message ?? "unknown"}</p>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["교훈 entry 수", data.summary.totalEntries],
              ["활성(active)", data.summary.activeEntries],
              ["해결(resolved)", data.summary.resolvedEntries],
              ["누적 발생", data.summary.totalHits],
            ].map(([label, value]) => (
              <Card key={label as string}>
                <CardContent className="py-4">
                  <div className="text-2xl font-bold text-primary">{value as number}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{label as string}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <PatternCardsSection companyId={selectedCompanyId} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">📚 축적된 교훈 ({data.entries.length})</CardTitle>
              <CardDescription>pattern · errorCode · 발생횟수 · 상태 · 최근 · 원인 · 주입 교훈</CardDescription>
            </CardHeader>
            <CardContent>
              {data.entries.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">아직 축적된 교훈이 없습니다.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-2">패턴</th>
                        <th className="px-2 py-2">에러코드</th>
                        <th className="px-2 py-2">발생</th>
                        <th className="px-2 py-2">상태</th>
                        <th className="px-2 py-2">최근(KST)</th>
                        <th className="px-2 py-2">원인</th>
                        <th className="px-2 py-2">해결가이드(주입 교훈)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.entries.map((e) => {
                        const lastKst = e.lastSeenAt ? new Date(e.lastSeenAt).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }) : "-";
                        return (
                          <tr key={e.id} className="border-b align-top">
                            <td className="px-2 py-2 font-medium">
                              {e.pattern}
                              <div className="text-[11px] font-normal text-muted-foreground">agent {shortId(e.agentId)}</div>
                            </td>
                            <td className="px-2 py-2"><code className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.errorCode ?? "-"}</code></td>
                            <td className="px-2 py-2 font-bold text-amber-400">{e.frequency}회</td>
                            <td className="px-2 py-2">
                              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_STYLE[e.status] ?? STATUS_STYLE.closed)}>
                                {e.status}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground">{lastKst}</td>
                            <td className="max-w-[280px] px-2 py-2 text-xs text-muted-foreground">{e.cause}</td>
                            <td className="max-w-[320px] px-2 py-2 text-xs text-muted-foreground">{e.solution}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">📈 최근 실패 발생 추이 ({days}일)</CardTitle>
              <CardDescription>일자별 실패 heartbeat run (errorCode 색상). 추이 하락 = 교훈 주입이 효과.</CardDescription>
            </CardHeader>
            <CardContent>
              <AgentWikiTimeseries points={data.timeseries} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
