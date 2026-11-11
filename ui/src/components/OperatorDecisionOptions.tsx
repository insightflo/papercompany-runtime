import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { cn } from "../lib/utils";
import { OperatorDecisionFacts, uniqueDecisionFacts } from "./OperatorDecisionFacts";

interface OperatorDecisionOptionsProps {
  decision: OperatorDecisionView;
  selectedOptionIds: string[];
  onToggle: (optionId: string) => void;
  disabled: boolean;
  descriptionId: string;
  errorId: string;
  commonFacts: OperatorDecisionView["definition"]["options"][number]["facts"];
  /** [사람 카드 축소 Stage 4] 신형 축소 카드 — 옵션 설명·추천 사유를 1줄로 고정해 장문 펼침을 막는다. */
  singleLineDescriptions?: boolean;
}

/**
 * 결정 카드 선택지 목록(role=radio/checkbox 행) — OperatorDecisionCard 에서 추출했다(Stage 4).
 * [클릭 안정성] 네이티브 라디오/체크박스 대신 React 상태 기반 행(role=radio/checkbox)을 쓴다.
 * 과거 controlled input + label 조합에서 클릭이 등록되지 않거나(체크 표시는 남았는데 제출 시 미선택 처리되는)
 * 문서 단위 라디오 name 충돌로 표시와 상태가 어긋나는 사례가 보고되었다(2026-10-20 운영자 보고).
 * 선택 상태의 유일한 소스를 React 상태로 두어 그런 불일치 경로를 원천 차단한다.
 */
export function OperatorDecisionOptions({
  decision,
  selectedOptionIds,
  onToggle,
  disabled,
  descriptionId,
  errorId,
  commonFacts,
  singleLineDescriptions = false,
}: OperatorDecisionOptionsProps) {
  const lang = useCompanyLanguage();
  const optionGroups = decision.definition.optionGroups ?? null;
  if (decision.interactionType === "action") return null;
  const renderOption = (option: OperatorDecisionView["definition"]["options"][number], asRadio: boolean) => {
    const checked = selectedOptionIds.includes(option.id);
    return (
      <div
        key={option.id}
        role={asRadio ? "radio" : "checkbox"}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={`${descriptionId} ${errorId}`}
        tabIndex={disabled ? -1 : 0}
        data-operator-decision-option={option.id}
        onClick={() => { if (!disabled) onToggle(option.id); }}
        onKeyDown={(event) => {
          if (disabled || (event.key !== " " && event.key !== "Enter")) return;
          event.preventDefault();
          onToggle(option.id);
        }}
        className={`block cursor-pointer border p-3 ${checked ? "border-primary bg-primary/5" : "border-border"}${disabled ? " pointer-events-none opacity-50" : ""}`}
      >
        <span className="flex items-start gap-2">
          <span aria-hidden className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${asRadio ? "rounded-full" : "rounded-sm"} ${checked ? "border-primary" : "border-border"}`}>
            {checked && (asRadio
              ? <span className="h-2 w-2 rounded-full bg-primary" />
              : <span className="text-[10px] leading-none text-primary">✓</span>)}
          </span>
          <span>
            <span className="block text-sm font-medium">
              {option.label}
              {/* [요청자 추천] 배지+사유 한 줄 — 표시일 뿐이고 선택·resolve 구조는 바꾸지 않는다. */}
              {option.recommended === true && (
                <span
                  data-operator-decision-recommended
                  className="ml-1.5 align-middle border border-primary px-1.5 py-0.5 text-[11px] font-medium text-primary"
                >
                  {L(lang, { en: "Recommended", ko: "추천" })}
                </span>
              )}
            </span>
            {option.description && <span className={cn("block text-xs text-muted-foreground", singleLineDescriptions && "line-clamp-1")}>{option.description}</span>}
            {option.recommended === true && option.recommendationReason && (
              <span data-operator-decision-recommendation-reason className={cn("mt-0.5 block text-xs text-muted-foreground", singleLineDescriptions && "line-clamp-1")}>
                {L(lang, { en: `Recommended because: ${option.recommendationReason}`, ko: `추천 사유: ${option.recommendationReason}` })}
              </span>
            )}
          </span>
        </span>
        <OperatorDecisionFacts facts={uniqueDecisionFacts(option.facts, commonFacts)} />
        {option.evidenceRefs.map((ref) => (
          <a key={ref.href} className="mt-2 block text-xs" href={ref.href} target="_blank" rel="noreferrer">
            {ref.label}
          </a>
        ))}
      </div>
    );
  };
  if (optionGroups && optionGroups.length > 0) {
    const grouped = new Set(optionGroups.flatMap((group) => group.optionIds));
    const ungrouped = decision.definition.options.filter((option) => !grouped.has(option.id));
    return (
      <div className="mt-4 space-y-4">
        {optionGroups.map((group) => (
          <fieldset key={group.id} className="space-y-2" aria-describedby={`${descriptionId} ${errorId}`}>
            <legend className="text-sm font-medium">{group.label ?? group.id}
              <span className="ml-1 text-xs text-muted-foreground">
                {group.selection?.min === group.selection?.max && group.selection?.max === 1 ? L(lang, { en: "(Select 1)", ko: "(1개 선택)" }) : ""}
              </span>
            </legend>
            {decision.definition.options
              .filter((option) => group.optionIds.includes(option.id))
              .map((option) => renderOption(option, group.selection?.max === 1))}
          </fieldset>
        ))}
        {ungrouped.length > 0 && (
          <fieldset className="space-y-2" aria-describedby={`${descriptionId} ${errorId}`}>
            <legend className="text-sm font-medium">{L(lang, { en: "Options", ko: "선택지" })}</legend>
            {ungrouped.map((option) => renderOption(option, decision.interactionType === "single_select"))}
          </fieldset>
        )}
      </div>
    );
  }
  return (
    <fieldset className="mt-4 space-y-2" aria-describedby={`${descriptionId} ${errorId}`}>
      <legend className="text-sm font-medium">{L(lang, { en: "Options", ko: "선택지" })}</legend>
      {decision.definition.options.map((option) => renderOption(option, decision.interactionType === "single_select"))}
    </fieldset>
  );
}
