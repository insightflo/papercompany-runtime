import type { HumanReviewPacket as HumanReviewPacketValue } from "@paperclipai/shared";
import { AlertTriangle, ArrowUpRight, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { Link } from "../lib/router";
import { L, useCompanyLanguage } from "../lib/companyLanguage";

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return href.startsWith("/")
    ? <Link to={href} className="inline-flex items-center gap-1 font-medium">{children}<ArrowUpRight className="h-3 w-3" /></Link>
    : <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium">{children}<ArrowUpRight className="h-3 w-3" /></a>;
}

/**
 * [사람 카드 축소 Stage 4] symptom 이 있는 신형 패킷 판별. 신형 패킷은 고정 축소 레이아웃
 * (증상 ≤2줄 / 쉬운 해석 1문장 / 상세 근거 링크 칩)으로만 표시하고, symptom 이 없는 구형
 * 저장 카드·승인 카드는 기존 렌더링을 그대로 유지한다(하위호환 게이트).
 */
export function hasCompactSymptom(packet: HumanReviewPacketValue | null | undefined): boolean {
  return typeof packet?.symptom === "string" && packet.symptom.trim().length > 0;
}

/**
 * [사람 카드 UI 중복 정리] 운영자 요청 request.summary 가 Stage 2 신형 축소 형식(증상/선택지/쉬운 해석
 * 고정 라인)인지 판별한다. 신형 요약 행은 본문에 이미 축소 정보가 있으므로 '쉬운 해석 (AI)' 패널을
 * 이중으로 노출하지 않고, 구형 요약(예: "운영자 할 일: …")은 기존대로 패널을 유지한다.
 */
export function hasCompactOperatorSummary(summary: string | null | undefined): boolean {
  if (typeof summary !== "string") return false;
  return /^증상:\s/m.test(summary) && /^선택지:\s/m.test(summary) && /^쉬운 해석:\s/m.test(summary);
}

/** 1문장 클립: 비어 있지 않은 첫 줄을 우선 취한 뒤 문장 종결 부호(`.!?`·`。`) 뒤에 공백 또는 끝이
 *  오는 첫 경계까지 자른다. 소수점·버전 표기(v1.2, 3.14)는 종결 부호 뒤가 공백/끝이 아니므로
 *  잘리지 않고, 문장부호 없는 입력은 첫 줄 전체로 폴백한다(CardHumanSummary.clipOneSentence 와 같은 로직). */
function clipOneSentence(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const boundary = firstLine.match(/^[\s\S]*?[.!?。]+["')\]}]*(?=\s|$)/);
  const clipped = boundary ? boundary[0].trim() : "";
  return clipped.length > 0 ? clipped : firstLine;
}

/** 서버가 nextAction 이 없을 때 채우는 recommendedNextStep 기본 폴백 문구 — 해석 중복 판정에서 제외한다. */
const NEXT_STEP_FALLBACK = "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.";

function normalizeOneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** '쉬운 해석' 원문이 서버 Stage 1 템플릿·선택지 나열을 그대로 반복하는지 판정한다(하나라도 참이면 중복). */
function interpretationRepeatsOptions(packet: HumanReviewPacketValue, optionLabels?: readonly string[]): boolean {
  const interpretation = packet.interpretation;
  // (1) 서버 Stage 1 고정 템플릿 접두사 — "사람 결정(…) 요청 — …"
  if (/^사람 결정\(.+\)\s*요청\s*—/.test(interpretation.trim())) return true;
  // (2) 다음 단계 문구(8자 이상·기본 폴백 아님)가 해석 원문에 그대로 포함 — 선택지 영역이 1회만 담당한다.
  const nextStep = normalizeOneLine(packet.recommendedNextStep);
  if (nextStep.length >= 8 && nextStep !== NEXT_STEP_FALLBACK && normalizeOneLine(interpretation).includes(nextStep)) return true;
  // (3) 다중 선택지 나열 패턴 — (A)…(B)… 나열, 승인·보류·반려, 입력 수정 후 재시도/계획 변경,
  //     옵션 라벨(2자 이상 비공백) 2개 이상이 해석에 동시 포함.
  if (/\([A-D1-4]\)\s*\S[\s\S]*\([B-E2-5]\)\s*\S/.test(interpretation)) return true;
  if (/승인\s*[·,/]\s*보류\s*[·,/]\s*반려/.test(interpretation)) return true;
  if (/입력 수정 후 재시도,\s*계획 변경/.test(interpretation)) return true;
  // (4) 레거시 '승인 여부 판단' 틀 — 요청 문구 재서술이므로 1문장 해석으로 정화한다.
  if (/승인\s*여부를?\s*판단|판단해\s*주세요/.test(interpretation)) return true;
  // (5) 운영자 선택 메타 문구 — 해석은 상황 설명 + 선택 지시만 남긴다.
  if (/운영자가\s*(?:복구\s*경로|방향)|복구\s*경로를\s*선택|Select a recovery path|Human operator must/i.test(interpretation)) return true;
  const labels = [...new Set((optionLabels ?? []).map((label) => label.trim()))].filter((label) => label.length >= 2);
  const contained = labels.filter((label) => interpretation.includes(label));
  return contained.length >= 2;
}

// [카드 UX 핫픽스 ① 2026-11-13] 쉬운 해석 비면 금지 — 정화·클립이 빈 결과를 내면
//   '무엇이 막혔고 무엇을 고르면 어떻게 되는지' 최소 폴백 문장을 표시한다.
//   서버 mission-owner-human-input-card.ts 의 HUMAN_INPUT_INTERPRETATION_FALLBACK 와 동일 문구(표시 전용).
export const COMPACT_INTERPRETATION_FALLBACK =
  "자동 진행이 멈춰 사람의 방향 선택이 필요합니다 — 아래 선택지에서 방향을 고르면 미션 오너가 그 지시대로 진행합니다.";

/**
 * [사람 카드 UI 중복 정리] '쉬운 해석' 표시 문장. 원문이 서버 Stage 1 템플릿·선택지 나열을 반복하면
 * 방향·이유만 담은 고정 1문장으로 대체하고(선택지 나열은 '선택지' 영역이 1회만 표시),
 * 깔끔한 1문장은 원문을 그대로 보존한다. [핫픽스 ①] 결과는 절대 빈 문자열이 아니다.
 */
export function formatCompactInterpretation(packet: HumanReviewPacketValue, optionLabels?: readonly string[]): string {
  if (interpretationRepeatsOptions(packet, optionLabels)) {
    // [카드 해석 정화 C4b] 정화 문장은 '무엇이 막혔는지 + 고르면 어떻게 되는지' 1문장 — 카드의
    // 구조화 선택지 라벨에서 파생한다(요청 문구 재서술 금지).
    const labels = optionLabels ?? [];
    if (labels.some((label) => label.includes("이어서 진행"))) {
      return "자동 진행이 중단된 실행이라, 아래 선택지에서 실패 단계 재개 또는 다른 복구 방법을 고르면 미션 오너가 그 경로로 진행합니다.";
    }
    if (labels.some((label) => label.includes("재계획") || label.includes("입력 수정 후 재시도"))) {
      return "자동 복구 경로가 더 이상 남아 있지 않아 멈췄으며, 아래 선택지에서 복구 방법을 고르면 미션 오너가 해당 절차를 실행합니다.";
    }
    if (/escalate|에스컬레이션/i.test(`${packet.decisionSubject}\n${packet.interpretation}`)) {
      return "자동 진행이 막혀 멈춘 상태이며, 아래 선택지에서 대응 방향을 고르면 미션 오너가 그 결과에 따라 후속 조치를 실행합니다.";
    }
    return "운영자 확인 없이는 다음 단계로 넘어갈 수 없어 대기 중이며, 아래 선택지에서 방향을 고르면 미션 오너가 그에 맞춰 진행합니다.";
  }
  return clipOneSentence(packet.interpretation) || COMPACT_INTERPRETATION_FALLBACK;
}

/** 서버가 근거 미제출 시 unresolvedFacts 에 넣는 기본 폴백 — 전제 안내줄에서는 제외한다
 *  (확인할 내용 성격이며 '선택 전 필요 조건'이 아니다). */
const MISSING_EVIDENCE_FACT = "오너가 제출 근거 텍스트를 남기지 않았습니다 — 이슈 본문에서 직접 확인이 필요합니다.";

/** unresolvedFacts 중 '선택지' 위에 띄울 전제 안내 문구 — 기본 폴백·공백 항목은 걸러낸다. */
function extractPrerequisiteNotices(packet: HumanReviewPacketValue): string[] {
  return packet.unresolvedFacts
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== MISSING_EVIDENCE_FACT);
}

// [카드 UX 핫픽스 ②] 증상 표시줄은 한국어 완결을 보장한다 — 외국어 위주(라틴>0, 한글 비중 25% 미만)
//   줄이 섞인 구 저장 카드도 같은 규칙으로 근거 링크 안내로 대체한다
//   (서버 formatSymptom 의 isForeignDominantLine·안내 문구와 동일, 표시 전용 복사본).
const SYMPTOM_EVIDENCE_POINTER = "요청 원문(영어 포함)은 아래 '상세 근거'의 이슈 링크 본문에서 확인해 주세요.";
const SYMPTOM_STATUS_FALLBACK = "미션 진행이 멈춰 오너가 사람의 방향 결정을 요청했습니다.";
function isForeignDominantLine(line: string): boolean {
  const hangul = (line.match(/[가-힯]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return latin > 0 && hangul * 3 < latin;
}

/** 표시용 증상 줄 정규화 — 외국어 위주 줄을 근거 안내로 대체한 최대 2줄을 돌려준다. */
export function normalizeCompactSymptom(symptom: string): string[] {
  const lines = symptom.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  const kept = lines.filter((line) => !isForeignDominantLine(line));
  if (kept.length === lines.length) return lines;
  if (kept.length > 0) return [...kept.slice(0, 1), SYMPTOM_EVIDENCE_POINTER].slice(0, 2);
  return [SYMPTOM_STATUS_FALLBACK, SYMPTOM_EVIDENCE_POINTER];
}

/** 해석 원문 뒤에 붙는 복구 권고 경고(빈 줄 이후 단락) — 카드에 보이게 유지하되 해석 문장과 분리해 연하게 표시한다. */
function extractAdvisoryNotice(interpretation: string): string {
  const rest = interpretation.split(/\n\s*\n/).slice(1).join(" ").trim();
  return /입증하지\s*않습니다/.test(rest) ? rest : "";
}

/** 증상 블록 — 개행은 보존하되 최대 2줄만 표시한다(서버가 ≤2줄로 자르고, UI 는 line-clamp-2 로 방어).
 *  전제 안내가 있으면 증상 바로 아래 컴팩트 안내줄로 표시한다(컴팩트 카드에서 '선택지' 직전에 배치).
 *  [핫픽스 ②] 표시 전 외국어 위주 줄을 근거 링크 안내로 정규화한다. */
export function HumanReviewSymptomBlock({ packet }: { packet: HumanReviewPacketValue }) {
  const lang = useCompanyLanguage();
  const notices = extractPrerequisiteNotices(packet);
  return (
    <div data-testid="human-review-symptom">
      <p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Symptom", ko: "증상" })}</p>
      <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm">{normalizeCompactSymptom(packet.symptom ?? "").join("\n")}</p>
      {notices.length > 0 && (
        <div
          data-testid="human-review-prerequisite-notice"
          className="mt-2 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 쉬운 해석 블록 — 1문장 강조. 선택지 나열이 원문에 겹치면 방향·이유 문장으로만 대체하고
 *  선택지는 '선택지' 영역이 1회만 표시한다. 상세 진단은 카드 밖 근거 링크에서만 확인한다. */
export function HumanReviewInterpretationBlock({ packet, optionLabels }: { packet: HumanReviewPacketValue; optionLabels?: readonly string[] }) {
  const lang = useCompanyLanguage();
  const advisory = extractAdvisoryNotice(packet.interpretation);
  return (
    <div data-testid="human-review-interpretation" className="border-l-2 border-primary bg-primary/5 p-2">
      <p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Plain-language read", ko: "쉬운 해석" })}</p>
      <p className="mt-1 text-sm font-medium">{formatCompactInterpretation(packet, optionLabels)}</p>
      {advisory && (
        <p data-testid="human-review-interpretation-notice" className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{advisory}</p>
      )}
    </div>
  );
}

/** 상세 근거 칩 — 라벨 링크만 표시하고 장문 location/description 은 펼치지 않는다. */
export function HumanReviewEvidenceChips({ packet }: { packet: HumanReviewPacketValue }) {
  const lang = useCompanyLanguage();
  if (packet.evidence.length === 0) return null;
  return (
    <div data-testid="human-review-evidence-chips">
      <p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Detailed evidence", ko: "상세 근거" })}</p>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {packet.evidence.map((item) => (
          <li key={`${item.href}:${item.location}`} className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 text-xs" data-testid="human-review-evidence-chip">
            <SourceLink href={item.href}>{item.label}</SourceLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HumanReviewPacket({ packet, variant = "full" }: { packet: HumanReviewPacketValue | null; variant?: "full" | "compact" }) {
  const lang = useCompanyLanguage();
  if (!packet) return (
    <section className="mt-3 border border-amber-500/50 bg-amber-500/10 p-4" data-testid="human-review-incomplete">
      <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><div>
        <h3 className="text-sm font-semibold">{L(lang, { en: "Insufficient review information to approve", ko: "판단 정보가 부족해 승인할 수 없습니다" })}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{L(lang, { en: "Ask the requester to provide the decision subject, exact source locations, interpretation, approval/rejection/error impacts and next steps.", ko: "판단 주제, 근거 원본의 정확한 위치, 해석, 승인·거절·오판 영향과 다음 단계를 요청자에게 보완받아야 합니다." })}</p>
      </div></div>
    </section>
  );
  // [사람 카드 축소 Stage 4] 신형(symptom 있는) 패킷은 고정 축소 레이아웃만 표시한다.
  if (hasCompactSymptom(packet)) {
    return (
      <section className="mt-3 space-y-3 border border-border bg-background p-4" data-testid="human-review-packet" data-packet-layout="compact-symptom">
        <HumanReviewSymptomBlock packet={packet} />
        <HumanReviewInterpretationBlock packet={packet} />
        <HumanReviewEvidenceChips packet={packet} />
      </section>
    );
  }
  // [카드 표시 결함 ①②] 검증·정책 한정문(unresolvedFacts 전제 안내)은 해석·다음 단계 문장이 아닌
  //   별도 '검토 필요' 안내 블록에만 표시한다 — #717 축소 카드의 전제 안내줄과 같은 규칙.
  const prerequisiteNotices = extractPrerequisiteNotices(packet);
  return (
    <section className="mt-3 space-y-4 border border-border bg-background p-4" data-testid="human-review-packet">
      <div><p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "What is being decided?", ko: "무엇을 판단하나요?" })}</p><h3 className="mt-1 text-base font-semibold">{packet.decisionSubject}</h3></div>
      {variant === "compact" && prerequisiteNotices.length > 0 && (
        <div
          data-testid="human-review-prerequisite-notice"
          className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          {prerequisiteNotices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}
      <div><p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Current interpretation", ko: "현재 해석" })}</p><p className="mt-1 whitespace-pre-line text-sm">{packet.interpretation}</p></div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Evidence & source location", ko: "판단 근거와 원본 위치" })}</p>
        <ul className="mt-2 space-y-2">{packet.evidence.map((item) => <li key={`${item.href}:${item.location}`} className="border-l-2 border-primary/40 pl-3 text-sm">
          <SourceLink href={item.href}>{item.label}</SourceLink><p className="mt-0.5 text-xs text-muted-foreground">{L(lang, { en: "Source location", ko: "원본 위치" })}: {item.location}</p>{item.description && <p className="mt-0.5 whitespace-pre-line text-xs">{item.description}</p>}
        </li>)}</ul>
      </div>
      {/* [compact] 운영자 결정 카드에서는 승인하면/거절하면/잘못 판단하면 + 확인할 내용 블록이
          공간만 차지한다고 하여 제거했다(2026-10-20 운영자 요청). 승인 흐름(ApprovalCard 등)은 full 유지. */}
      {variant === "full" && (
        <div className="grid gap-2 md:grid-cols-3">
          <div className="border border-green-600/30 bg-green-600/5 p-3"><p className="flex items-center gap-1 text-xs font-semibold"><CheckCircle2 className="h-3.5 w-3.5" />{L(lang, { en: "If approved", ko: "승인하면" })}</p><p className="mt-1 text-xs">{packet.impact.ifApproved}</p></div>
          <div className="border border-border p-3"><p className="flex items-center gap-1 text-xs font-semibold"><XCircle className="h-3.5 w-3.5" />{L(lang, { en: "If rejected", ko: "거절하면" })}</p><p className="mt-1 text-xs">{packet.impact.ifRejected}</p></div>
          <div className="border border-destructive/30 bg-destructive/5 p-3"><p className="flex items-center gap-1 text-xs font-semibold"><AlertTriangle className="h-3.5 w-3.5" />{L(lang, { en: "If wrong", ko: "잘못 판단하면" })}</p><p className="mt-1 text-xs">{packet.impact.ifWrong}</p></div>
        </div>
      )}
      {variant === "full" && (packet.unresolvedFacts.length > 0 || packet.questions.length > 0) && <div className="border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p className="flex items-center gap-1 font-semibold"><HelpCircle className="h-4 w-4" />{L(lang, { en: "To confirm", ko: "확인할 내용" })}</p><ul className="mt-1 list-disc pl-5">{[...packet.unresolvedFacts, ...packet.questions].map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Next step", ko: "다음 단계" })}</dt><dd>{packet.recommendedNextStep}</dd></div><div><dt className="text-xs font-semibold text-muted-foreground">{L(lang, { en: "Required reviewer", ko: "필요한 검토자" })}</dt><dd>{packet.requiredReviewer}</dd></div></dl>
    </section>
  );
}
