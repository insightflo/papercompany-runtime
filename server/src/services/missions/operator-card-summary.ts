// [display-only] 오너 판정 카드 요약 포맷터. rule 8 준수: 이 텍스트는 표시 전용이며
//   어떤 실행 판단의 근거로 읽히지 않는다. 구조화된 payload 필드를 사람이 읽는
//   고정 축소 카드(증상 ≤2줄 / 선택지 1줄 / 쉬운 해석 1문장 / 근거 링크)로만 바꾼다.
//   구 카드(링크 없는 장문 evidence 등) 입력은 안전하게 폴백 출력한다.
import { extractMissionOwnerDecisionFromText } from "./mission-owner-recovery-events.js";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_PATTERN = /https?:\/\/[^\s)<>"']+/g;
const ISSUE_REF_PATTERN = /(?:^|(?<=[\s(]))\/issues\/\d+/g;
const MAX_EVIDENCE_LINKS = 5;

const SYMPTOM_BUDGET = 200;
const OPTION_BUDGET = 140;
const INTERPRETATION_BUDGET = 120;
const EVIDENCE_BUDGET = 160;
const EVIDENCE_LINKS_BUDGET = 240;
const MISSION_TITLE_BUDGET = 80;
const ISSUE_TITLE_BUDGET = 140;

// 라벨로만 제거한다: 'Human operator must ...' 은 문장 주어이므로 콜론이 붙은 라벨 형태만 제거.
const TITLE_LABEL_PREFIXES = ["mission blocker escalated", "human/operator input requested"];

function stripTitleLabel(text: string): string {
  let out = text;
  for (const label of TITLE_LABEL_PREFIXES) {
    out = out.replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "");
  }
  out = out.replace(/^human\s*operator\s*:\s*/i, "");
  return out.trim();
}

export type OperatorCardSummaryInput = {
  decision: "request_input" | "escalate";
  missionTitle?: string | null;
  issueTitle?: string | null;
  issueIdentifier?: string | null;
  issueId?: string | null;
  reason?: string | null;
  nextAction?: string | null;
  evidence?: string | null;
};

function shortenUuids(text: string): string {
  return text.replace(UUID_PATTERN, (match) => match.slice(0, 8));
}

function cleanProse(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function truncateAtSentenceBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const sentenceEnds = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const last = sentenceEnds[sentenceEnds.length - 1];
  if (last?.index !== undefined && last.index > 0) {
    return head.slice(0, last.index + 1);
  }
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return `${head.slice(0, lastSpace)} …`;
  return `${head} …`;
}

function truncateAtWordBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const lastSpace = head.lastIndexOf(" ");
  return lastSpace > 0 ? head.slice(0, lastSpace) : head;
}

// system terminal report 는 buildTerminalMissionHumanOperatorComment 가 보증하는
//   기계 포맷(### Mission owner decision 블록)이므로 안전하게 필드 분해해 재사용한다.
function unpackStructuredReason(reason: string): { reason?: string; nextAction?: string; evidence?: string } | null {
  const parsed = extractMissionOwnerDecisionFromText(reason);
  if (!parsed || parsed.decision === null) return null;
  return { reason: parsed.reason, nextAction: parsed.nextAction, evidence: parsed.evidence };
}

function symptomContextLine(input: OperatorCardSummaryInput): string {
  const parts: string[] = [];
  if (input.missionTitle?.trim()) {
    parts.push(`미션 ${truncateAtWordBoundary(input.missionTitle.trim(), MISSION_TITLE_BUDGET)}`);
  }
  const identifier = input.issueIdentifier?.trim();
  const title = input.issueTitle?.trim();
  if (identifier && title) {
    parts.push(`이슈 ${identifier} — ${truncateAtWordBoundary(title, ISSUE_TITLE_BUDGET)}`);
  } else if (title) {
    parts.push(`이슈 ${truncateAtWordBoundary(title, ISSUE_TITLE_BUDGET)}`);
  } else if (identifier) {
    parts.push(`이슈 ${identifier}`);
  } else if (input.issueId) {
    parts.push(`이슈 (${shortenUuids(input.issueId)})`);
  }
  if (parts.length === 0) parts.push("미션 진행이 중단되었습니다");
  return parts.join(" · ");
}

// evidence 에 링크가 있으면 링크만 남긴다. 링크는 절대 중간에서 잘지 않고,
//   예산 초과 시 링크 단위로 뒤에서부터 버린다.
function extractEvidenceLinks(evidence: string): string[] {
  const links = new Set<string>();
  for (const match of evidence.matchAll(URL_PATTERN)) links.add(match[0]);
  for (const match of evidence.matchAll(ISSUE_REF_PATTERN)) links.add(match[0]);
  return [...links].slice(0, MAX_EVIDENCE_LINKS);
}

function fitLinks(links: readonly string[], budget: number): string {
  const kept: string[] = [];
  let total = 0;
  for (const link of links) {
    const addition = kept.length === 0 ? link.length : link.length + 3; // " · " separator
    if (total + addition > budget) break;
    kept.push(link);
    total += addition;
  }
  return kept.join(" · ");
}

function interpretationSentence(decision: OperatorCardSummaryInput["decision"]): string {
  return decision === "escalate"
    ? "자동 진행이 막혀서 운영자가 복구 방향을 정해야 미션을 계속할 수 있습니다."
    : "운영자의 입력이 있어야 미션을 계속 진행할 수 있습니다.";
}

export function formatOperatorDecisionSummary(input: OperatorCardSummaryInput): string {
  const unpacked = input.reason ? unpackStructuredReason(input.reason) : null;
  const rawReason = unpacked?.reason ?? input.reason ?? null;
  const rawNextAction = unpacked?.nextAction ?? input.nextAction ?? null;
  const rawEvidence = unpacked?.evidence ?? input.evidence ?? null;

  const symptom = rawReason
    ? truncateAtSentenceBoundary(shortenUuids(stripTitleLabel(cleanProse(rawReason))), SYMPTOM_BUDGET)
    : "(사유 기록 없음)";
  const option = rawNextAction
    ? truncateAtSentenceBoundary(shortenUuids(stripTitleLabel(cleanProse(rawNextAction))), OPTION_BUDGET)
    : input.decision === "escalate"
      ? "운영자가 복구 경로를 선택해야 합니다(입력 수정 후 재시도, 재계획, 담당 재배정, 취소 중 하나)."
      : "운영자 판단이나 입력이 필요합니다.";

  const lines = [
    `증상: ${symptomContextLine(input)}`,
    symptom,
    `선택지: ${option}`,
    `쉬운 해석: ${truncateAtSentenceBoundary(interpretationSentence(input.decision), INTERPRETATION_BUDGET)}`,
  ];
  if (rawEvidence) {
    const links = extractEvidenceLinks(rawEvidence);
    lines.push(links.length > 0
      ? `근거: ${fitLinks(links, EVIDENCE_LINKS_BUDGET)}`
      : `근거: ${truncateAtSentenceBoundary(shortenUuids(cleanProse(rawEvidence)), EVIDENCE_BUDGET)}`);
  }
  return lines.join("\n");
}
