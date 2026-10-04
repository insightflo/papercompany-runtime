import { useState } from "react";
import type { BudgetIncident } from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const lang = useCompanyLanguage();
  const scope = humanLabel(lang, "budgetScope", incident.scopeType).label;
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseDollarInput(draftAmount);

  return (
    <Card className="overflow-hidden border-red-500/20 bg-[linear-gradient(180deg,rgba(255,70,70,0.10),rgba(255,255,255,0.02))]">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-red-200/80">
              {L(lang, { en: `${scope} budget hard stop`, ko: `${scope} 예산 초과 자동 정지` })}
            </div>
            <CardTitle className="mt-1 text-base text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-100/70">
              {L(lang, { en: `Spending reached ${formatCents(incident.amountObserved)} against a limit of ${formatCents(incident.amountLimit)}.`, ko: `지출 ${formatCents(incident.amountObserved)}이 상한 ${formatCents(incident.amountLimit)}에 도달해 작업이 자동으로 멈췄습니다.` })}
            </CardDescription>
          </div>
          <div className="rounded-full border border-red-400/30 bg-red-500/10 p-2 text-red-200">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-50/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? L(lang, { en: "Work-context execution is paused. New work in this context will not start until you resolve the budget incident.", ko: "이 프로젝트의 작업 실행이 정지되었습니다. 예산 초과를 해결하기 전에는 새 작업이 시작되지 않습니다." })
              : L(lang, { en: "This scope is paused. New heartbeats will not start until you resolve the budget incident.", ko: "이 범위의 작업이 정지되었습니다. 예산 초과를 해결하기 전에는 새 정기 실행이 시작되지 않습니다." })}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {L(lang, { en: "New budget (USD)", ko: "새 상한(달러)" })}
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed === "number") onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? L(lang, { en: "Applying…", ko: "적용 중…" }) : L(lang, { en: "Raise budget & resume", ko: "상한 올리고 재개" })}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-red-200/80">
              {L(lang, { en: "The new budget must exceed current observed spend.", ko: "새 상한은 현재 지출보다 커야 합니다." })}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={onKeepPaused}>
            {L(lang, { en: "Keep paused", ko: "정지 유지" })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
