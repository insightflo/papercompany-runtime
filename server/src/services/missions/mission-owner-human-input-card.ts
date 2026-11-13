// server/src/services/missions/mission-owner-human-input-card.ts
// Bridges structured mission-owner requests into operator cards. moi1 binds an event and moi2 a saved lifetime.
// Only callers that verified a workflowRuns row may set workflowRunId; unresolved anchors fail with 422.
// Card writes remain post-commit and retain the caller's existing 5xx contract.
import type { Db } from "@paperclipai/db";
import { activityLog, operatorDecisions } from "@paperclipai/db";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
} from "@paperclipai/shared/types/operator-decision";
import type { OperatorDecisionSourceContextJson } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { unprocessable } from "../../errors.js";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";
import { operatorDecisionReadService } from "../operator-decisions-read.js";
import { buildDefaultOwnerHumanDefinition, buildHistoricalDefaultOwnerHumanInputVariant } from "./mission-owner-human-default-definition.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { stripOperatorDecisionServerContext } from "../operator-decision-server-context.js";
import { sameOwnerHumanValue } from "./owner-human-request-contract.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./workflow-restart-option.js";
import { isPrerequisiteNoticeOption } from "./terminal-recovery-card-options.js";
import { extractMissionOwnerDecisionFromText } from "./mission-owner-recovery-events.js";

export const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";
export const MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED = "mission_owner_human_input_card_mapping_failed";
export const MISSION_OWNER_HUMAN_INPUT_INSUFFICIENT_OPTIONS = "mission_owner_human_input_insufficient_options";
export const PENDING_MISSION_HUMAN_INPUT_UQ = "operator_decisions_pending_mission_human_input_uq";

/** [C1 2026-11-08] 미션당 pending 카드 1장 부분 고유 인덱스 위반(23505) 판정 — 충돌 시 사유 누적 분기. */
export function isPendingMissionHumanCardUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
  return (candidate.code === "23505" || candidate.code === 23505)
    && (candidate.constraint === PENDING_MISSION_HUMAN_INPUT_UQ
      || candidate.constraint_name === PENDING_MISSION_HUMAN_INPUT_UQ
      || (typeof candidate.message === "string" && candidate.message.includes(PENDING_MISSION_HUMAN_INPUT_UQ)));
}

export function buildHumanInputDecisionCardRequestKey(decisionEventId: string): string {
  return `moi1:${decisionEventId}`;
}

// Invalid structured options fail with 422; prose is never parsed into choices.
const structuredOptionSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).nullable().optional(),
}).strict();

export type MissionOwnerHumanInputCardSpec = {
  readonly companyId: string;
  readonly missionId: string;
  readonly decisionEventId: string;
  /** C08 persisted lifetime; omitted by existing moi1 callers. Creation rechecks its authority. */
  readonly lifetimeId?: string;
  readonly decision: "request_input" | "escalate";
  readonly ownerActionIssueId: string;
  readonly ownerActionIssueStatus: string;
  /** 미션 오너 에이전트 — 카드 requestedByAgentId(resolve 웨이크 수신자). */
  readonly requestedByAgentId: string;
  /** 발신 주체 — 시스템 경로(terminal supervise 등)는 "system". 실행 선택지는
   *  structuredOptions로만 전달하며 nextAction 자연어에서 파생하지 않는다. */
  readonly actorType?: "agent" | "system";
  readonly reason?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
  readonly issueTitle?: string | null;
  readonly issueIdentifier?: string | null;
  readonly sourceIssueId?: string | null;
  /** [D5] 실제 workflowRuns 행 존재가 호출부에서 확인된 id 만. heartbeatRuns.id 는 절대 아니다. */
  readonly workflowRunId?: string | null;
  /** [D3] payload 구조화 options(선택적 — 없으면 기본 approve/hold/reject). */
  readonly structuredOptions?: unknown;
  /** [요청자 추천] 카드 선택지 중 추천할 옵션 id(선택). 대응 옵션이 없으면 무시된다(fail-open). */
  readonly recommendedOptionId?: string | null;
  /** 추천 사유 — recommended 옵션에만 붙는다(스키마 최대 1,000자로 잘린다). */
  readonly recommendationReason?: string | null;
  /** [C4a] 전제·안내 문구 — 선택지로 노출하지 않고 카드 안내줄(unresolvedFacts)로만 표시한다.
   *  structuredOptions 안에 전제 문구가 섞여 들어와도 같은 안내줄로 이동한다. */
  readonly prerequisiteNotice?: string | null;
};

const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;
const present = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

// [사람 카드 축소 Stage 1 2026-11-11] 고정 축소 형식 헬퍼 — 문장/절 경계 우선 클립.
// 경계 없으면 하드 클립하며, 결과는 언제나 비지 않은 1자 이상이다.
const SENTENCE_BOUNDARY = /[.!?]/;
const CLAUSE_BOUNDARY = /[,;:·—]/;

function clipAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const window = value.slice(0, max);
  const floor = Math.floor(max / 2);
  const lastBoundary = (pattern: RegExp): number => {
    for (let index = window.length - 1; index >= floor; index -= 1) {
      if (pattern.test(window[index]!)) return index + 1;
    }
    return -1;
  };
  const cut = Math.max(lastBoundary(SENTENCE_BOUNDARY), lastBoundary(CLAUSE_BOUNDARY));
  return (cut > 0 ? window.slice(0, cut) : window).trim() || value.slice(0, max);
}

/** 1줄 정규화 — 개행을 공백으로 치환하고 공백 연속을 정리한 뒤 경계 클립. */
const toOneLine = (value: string, max: number) =>
  clipAtBoundary(value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim(), max);

// [카드 UX 핫픽스 2026-11-13 ②] 증상은 항상 한국어 완결 문장 — 외국어 위주 줄이나 단어 중간에서
//   잘린 줄은 원문 잘림으로 보고 제외하고, 원문 위치 안내줄로 대체한다. 제외된 원문(영어 포함)은
//   잘리지 않은 채 카드 '상세 근거'의 오너 결정 요청 이슈 링크 본문에서 확인하게 한다.
export const SYMPTOM_EVIDENCE_POINTER = "요청 원문(영어 포함)은 아래 '상세 근거'의 이슈 링크 본문에서 확인해 주세요.";
export const SYMPTOM_STATUS_FALLBACK = "미션 진행이 멈춰 오너가 사람의 방향 결정을 요청했습니다.";
// [카드 UX 핫픽스 ①] 쉬운 해석이 비면 안 된다 — 파생 결과가 비어 나올 때 쓰는 최소 폴백 문장
//   ('무엇이 막혔고 무엇을 고르면 어떻게 되는지' 고정 안내).
export const HUMAN_INPUT_INTERPRETATION_FALLBACK =
  "자동 진행이 멈춰 사람의 방향 선택이 필요합니다 — 아래 선택지에서 방향을 고르면 미션 오너가 그 지시대로 진행합니다.";

/** 라틴 문자가 있고 한글이 25% 미만인 줄은 외국어 위주로 본다(영어 문장에 한국어 조사 하나 얹힌 경우도 걸러진다). */
export function isForeignDominantLine(line: string): boolean {
  const hangul = (line.match(/[가-힯]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return latin > 0 && hangul * 3 < latin;
}

/** 증상 최대 2줄 — 빈 줄 제거·줄별 trim, 개행 최대 1개, 전체 ≤220자 경계 클립. 미제출이면 undefined.
 *  reason 이 구조화 결정 블록("### Mission owner decision" 등)이면 실제 사유 문장만 꺼내 표시한다.
 *  [핫픽스 ②] 외국어 위주 줄·단어 중간 잘림 줄은 제외하고 근거 링크 안내로 대체한다(한국어 완결 보장). */
function formatSymptom(reason: string | undefined): string | undefined {
  const unpacked = reason ? extractMissionOwnerDecisionFromText(reason) : null;
  const raw = unpacked?.decision ? (unpacked.reason ?? reason) : reason;
  const sourceLines = (raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s*Mission owner decision$/i.test(line))
    .slice(0, 2);
  if (sourceLines.length === 0) return undefined;
  const joined = sourceLines.join("\n");
  const clipped = clipAtBoundary(joined, 220);
  if (!clipped) return undefined;
  const clippedLines = clipped.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2);
  // 단어 중간 잘림 판정: 경계 부호 없는 하드 클립(마지막 표시 글자와 원문 다음 글자가 같은 단어 조각).
  const clippedMidToken = clipped.length < joined.length
    && /[A-Za-z0-9_가-힯-]$/.test(clipped)
    && /^[A-Za-z0-9_가-힯-]/.test(joined.slice(clipped.length));
  const kept = clippedLines.filter((line, index) => {
    if (isForeignDominantLine(line)) return false;
    if (clippedMidToken && index === clippedLines.length - 1) return false;
    return true;
  });
  if (kept.length === clippedLines.length) return clippedLines.join("\n") || undefined;
  const lines = kept.length > 0 ? [...kept.slice(0, 1), SYMPTOM_EVIDENCE_POINTER]
    : [SYMPTOM_STATUS_FALLBACK, SYMPTOM_EVIDENCE_POINTER];
  return lines.slice(0, 2).join("\n");
}

function extractEvidenceUrl(evidence: string | undefined): string | null {
  const text = present(evidence);
  if (!text) return null;
  const match = /https?:\/\/[^\s"'<>()[\]{}]+/i.exec(text);
  return match ? clip(match[0], 2_000) : null;
}

function mappingFailure(detail: string): never {
  throw unprocessable(
    `사람 결정 카드의 판단 근거를 해석할 수 없어 카드를 만들 수 없습니다(${detail}). 결정 이벤트·owner-action 이슈·미션 식별자를 갖춰 다시 제출해 주세요.`,
    { code: MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED },
  );
}

function buildStructuredDefinition(
  optionsInput: unknown,
  actorType: MissionOwnerHumanInputCardSpec["actorType"],
): { definition: OperatorDecisionDefinition; prerequisiteNotices: string[] } {
  const parsed = z.array(structuredOptionSchema).min(1).max(50).safeParse(optionsInput);
  if (!parsed.success) mappingFailure("payload 구조화 options 형식 위반");
  // [C4a] 전제·안내 문구가 선택지 배열에 섞여 들어오면 카드 옵션에서 즉시 제거하고
  //   안내 문구(unresolvedFacts)로 이동한다 — 선택지는 실행 가능한 행동만 담는다.
  const extractedNotices: string[] = [];
  const actionableRaw = parsed.data!.filter((option) => {
    if (!isPrerequisiteNoticeOption(option)) return true;
    extractedNotices.push(option.description
      ? toOneLine(option.description, 300)
      : toOneLine(option.label, 300));
    return false;
  });
  // [C4a] 실옵션 <2 게이트 — 시스템 발신 카드이거나 전제 문구 분리가 일어난 경로에서
  //   남은 실제 행동 선택지가 2개 미만이면 카드 자체를 발행하지 않는다(fail-loud 422).
  if (actionableRaw.length === 0
    || ((extractedNotices.length > 0 || actorType === "system") && actionableRaw.length < 2)) {
    throw unprocessable(
      "실제 실행 가능한 행동 선택지가 2개 미만이어서 사람 결정 카드를 발행하지 않습니다(시스템 처리 또는 대기 대상).",
      { code: MISSION_OWNER_HUMAN_INPUT_INSUFFICIENT_OPTIONS },
    );
  }
  const options = actionableRaw.map((option) => ({
    id: option.id,
    label: option.label,
    // [사람 카드 축소 Stage 1] 선택지 설명은 항상 1줄 — 개행을 공백으로 치환한다.
    description: option.description != null ? (toOneLine(option.description, 1_000) || null) : null,
    facts: [],
    evidenceRefs: [],
  }));
  return {
    definition: {
      options,
      actions: [{ id: "submit", label: "선택 제출", outcome: "submit", tone: "primary", requiresSelection: true }],
      selection: { min: 1, max: 1 },
      comment: { mode: "optional", label: "결정 사유", placeholder: "선택 이유나 오너에게 전달할 지시를 남겨 주세요", maxLength: 2_000 },
      approvedScope: [
        "operator_decision.resolve",
        ...(options.some((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID)
          ? [WORKFLOW_RESTART_FROM_START_SCOPE]
          : []),
      ],
      forbiddenScope: ["agent_substitute_submission", "auto_execution"],
    },
    prerequisiteNotices: extractedNotices,
  };
}

/** [C4a] 쉬운 해석 — 구조화 선택지 id 집합과 decision 만으로 '무엇이 막혔는지 +
 *  고르면 어떻게 되는지' 1문장을 만든다. 요청 산문(nextAction)은 절대 넣지 않고,
 *  '승인 여부 판단' 템플릿도 쓰지 않으며, 선택지 라벨을 나열하지 않는다(나열은
 *  카드의 '선택지' 영역이 1회만 담당). */
function buildOptionDerivedInterpretation(
  decision: "request_input" | "escalate",
  options: ReadonlyArray<{ readonly id: string }>,
): string {
  const ids = new Set(options.map((option) => option.id));
  if (ids.has("resume-this-run")) {
    return "자동 진행이 중단된 실행이라, 아래 선택지에서 실패 단계 재개 또는 다른 복구 방법을 고르면 미션 오너가 그 경로로 진행합니다.";
  }
  if (ids.has("replan-mission") || ids.has("retry-revised-input")) {
    return "자동 복구 경로가 더 이상 남아 있지 않아 멈췄으며, 아래 선택지에서 복구 방법을 고르면 미션 오너가 해당 절차를 실행합니다.";
  }
  if (ids.has(WORKFLOW_RESTART_FROM_START_OPTION_ID)) {
    return decision === "escalate"
      ? "자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면 미션 오너가 선택한 경로로 복구를 이어갑니다."
      : "자동으로 결정할 수 없는 진행 사항이 생겨 멈췄으며, 아래 선택지에서 방향을 고르면 미션 오너가 그 지시대로 다음 단계를 실행합니다.";
  }
  return decision === "escalate"
    ? "자동 진행이 막혀 멈춘 상태이며, 아래 선택지에서 대응 방향을 고르면 미션 오너가 그 결과에 따라 후속 조치를 실행합니다."
    : "운영자 확인 없이는 다음 단계로 넘어갈 수 없어 대기 중이며, 아래 선택지에서 방향을 고르면 미션 오너가 그에 맞춰 진행합니다.";
}

/** Build a validated card request; natural-language fields never select an operation. */
export function buildMissionOwnerHumanInputDecisionCard(input: MissionOwnerHumanInputCardSpec): CreateOperatorDecisionInput {
  if (!present(input.decisionEventId)) mappingFailure("결정 이벤트 식별자 없음");
  if (!present(input.missionId)) mappingFailure("미션 식별자 없음");
  if (!present(input.ownerActionIssueId)) mappingFailure("owner-action 이슈 식별자 없음");
  if (!present(input.ownerActionIssueStatus)) mappingFailure("owner-action 이슈 상태 없음");
  const decisionEventId = input.decisionEventId.trim();
  const decisionLabel = input.decision === "escalate" ? "에스컬레이션(escalate)" : "입력·승인 요청(request_input)";
  const issueLocation = clip([
    input.issueIdentifier ?? null,
    input.issueTitle ?? "owner-action 이슈",
  ].filter(Boolean).join(" · "), 300);
  const evidenceUrl = extractEvidenceUrl(input.evidence);
  const evidence: { label: string; href: string; location: string; description: string | null }[] = [
    {
      label: "오너 결정 요청(owner-action 이슈)",
      href: `/issues/${input.ownerActionIssueId}`,
      location: issueLocation,
      // [사람 카드 축소 Stage 1] 근거 원문 전체를 덤프하지 않고 1줄 참조 안내만 남긴다.
      description: "상세 진단·근거 원문은 이 이슈 본문에서 확인해 주세요",
    },
  ];
  if (input.sourceIssueId) {
    evidence.push({
      label: "원천(source) 이슈",
      href: `/issues/${input.sourceIssueId}`,
      location: "원천 이슈 상세",
      description: "오너가 회수·재시도를 요청한 원천 작업 이슈",
    });
  }
  if (input.workflowRunId) {
    evidence.push({
      label: "작업 흐름 실행(workflow run)",
      href: `/issues/${input.sourceIssueId ?? input.ownerActionIssueId}`,
      location: clip(`workflow run ${input.workflowRunId}`, 300),
      description: "실제 행 존재가 확인된 workflowRuns 실행 기록",
    });
  }
  if (evidenceUrl) {
    evidence.push({
      label: "오너 제출 근거 링크",
      href: evidenceUrl,
      location: "결정 제출 evidence 본문",
      // [사람 카드 축소 Stage 1] 제출 evidence 전문 대신 1줄 링크 참조 안내.
      description: "오너가 제출한 외부 근거 원문 링크입니다",
    });
  }
  const evidenceOptionRefs = evidence.map((ref) => ({ label: ref.label, href: ref.href }));
  // 실행 선택지는 생산자가 구조화해 전달한 options만 사용한다. nextAction은 표시·검토 문구이며
  // operation/target 권한으로 파싱하지 않는다.
  const structuredBuild = input.structuredOptions !== undefined
    ? buildStructuredDefinition(input.structuredOptions, input.actorType)
    : null;
  const definition = structuredBuild?.definition
    ?? buildDefaultOwnerHumanDefinition(evidenceOptionRefs, input.workflowRunId);
  // [C4a] 전제·안내 문구 수신 — 스펙 필드 전달분 + structuredOptions 에서 분리한 문구를
  //   합쳐 중복 제거하고 카드 안내줄(unresolvedFacts)로만 표시한다.
  const prerequisiteNotices = [...new Set([
    ...(present(input.prerequisiteNotice) ? [toOneLine(input.prerequisiteNotice!, 300)] : []),
    ...(structuredBuild?.prerequisiteNotices ?? []),
  ])];
  // Only an explicitly requested option can receive the nonbinding recommendation marker.
  const recommendedId = present(input.recommendedOptionId);
  const recommendationReason = present(input.recommendationReason);
  const requestedRecommendationExists = recommendedId
    ? definition.options.some((option) => option.id === recommendedId)
    : false;
  const options = recommendedId && requestedRecommendationExists
    ? definition.options.map((option) => option.id === recommendedId
      ? { ...option, recommended: true, ...(recommendationReason ? { recommendationReason: clip(recommendationReason, 1_000) } : {}) }
      : { ...option, recommended: undefined, recommendationReason: undefined })
    : definition.options;
  const recommendedDefinition = { ...definition, options };
  // [사람 카드 축소 Stage 1] 고정 축소 형식 — 증상 2줄(symptom), 해석 1문장. 상세 원문은 링크로만 참조.
  const symptom = formatSymptom(input.reason);
  // [사람 카드 해석 C4a] 쉬운 해석은 증상·선택지와 같은 구조화 옵션 목록에서 파생한다 —
  //   요청 산문(nextAction)을 패러프레이즈·인용하지 않고 '승인 여부 판단' 템플릿도 쓰지 않는다.
  const interpretation = toOneLine(
    buildOptionDerivedInterpretation(input.decision, recommendedDefinition.options), 200)
    || HUMAN_INPUT_INTERPRETATION_FALLBACK;
  return {
    schemaVersion: 1,
    requestKey: input.lifetimeId !== undefined
      ? `moi2:${input.lifetimeId}`
      : buildHumanInputDecisionCardRequestKey(decisionEventId),
    priority: "high",
    interactionType: "single_select",
    title: clip(`사람 결정 승인 요청 — ${decisionLabel}`, 200),
    // [사람 카드 축소 Stage 1] 장문 원문 본붙을 제거한 최소 고정 문구 — 필수 보드 제출 계약과
    // 상세 근거 링크 안내만 남긴다(원문은 이슈·근거 링크에서 확인).
    description: clip([
      `## 미션 오너의 사람 결정 요청(${decisionLabel})`,
      "",
      "증상·선택지·쉬운 해석은 카드 패킷을 그대로 표시하며, 상세 진단과 근거 원문은 연결된 이슈·근거 링크에서 확인해 주세요.",
      "",
      "선택은 운영자의 방향 지시입니다(boardSubmission: agent_required). 사람이 오너의 결정 레코드를 대신 제출하지 않으며,",
      "resolve 결과가 웨이크로 미션 오너 에이전트에게 전달되고 오너가 자기 권한 경로(기존 실행 API)로 실행합니다.",
    ].join("\n"), 4_000),
    sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
    sourceId: decisionEventId,
    sourceContext: {
      missionId: input.missionId,
      workflowId: null,
      workflowRunId: input.workflowRunId ?? null,
      artifactRefs: [],
      targetSnapshot: {
        issueId: input.ownerActionIssueId,
        issueStatus: input.ownerActionIssueStatus,
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      },
    },
    definition: {
      ...recommendedDefinition,
      humanReview: {
        schemaVersion: "human-review-v1",
        ...(symptom ? { symptom } : {}),
        decisionSubject: clip(`미션 오너의 사람 결정 요청 — ${decisionLabel} 승인 여부`, 300),
        evidence,
        interpretation,
        impact: {
          ifApproved: "선택한 방향이 미션 오너 에이전트에 전달되고, 오너가 자기 권한 경로(기존 실행 API)로 다음 단계를 진행합니다.",
          ifRejected: "요청이 반려됩니다. 반려 사유가 오너에게 전달되고 오너는 대기·보고 상태를 유지하거나 다시 에스컬레이션합니다.",
          ifWrong: "잘못된 방향이 전달되면 오너가 잘못된 다음 단계를 진행할 수 있습니다. 반려·보류로 실행을 막고 사유를 남길 수 있습니다.",
        },
        unresolvedFacts: [
          ...prerequisiteNotices,
          ...(present(input.evidence)
            ? []
            : ["오너가 제출 근거 텍스트를 남기지 않았습니다 — 이슈 본문에서 직접 확인이 필요합니다."]),
        ],
        questions: ["이 사람 결정 요청을 승인할까요?"],
        recommendedNextStep: clip(present(input.nextAction) ?? "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.", 2_000),
        requiredReviewer: "human-operator",
      },
    },
    issueId: input.ownerActionIssueId,
    continuationMode: "issue_current_assignee",
  };
}

/** Merge an equivalent pending request, replay an exact terminal legacy card, or create normally. */
export async function createMissionOwnerHumanInputDecisionCard(db: Db, spec: MissionOwnerHumanInputCardSpec) {
  const cardInput = buildMissionOwnerHumanInputDecisionCard(spec);
  try {
    const merged = await tryMergePendingHumanInputCard(db, spec, cardInput);
    if (merged) return merged;
    const historicalReplay = await replayHistoricalDefaultHumanInputCard(db, spec, cardInput);
    if (historicalReplay) return historicalReplay;
    return await operatorDecisionWriteService(db).create(spec.companyId, cardInput, { type: "agent", id: spec.requestedByAgentId });
  } catch (error) {
    // [C1 2026-11-08] 미션당 pending 카드 1장 부분 고유 인덱스가 동시 제출의 두 번째 insert 를
    // 거부한다(R2 게이트의 SELECT→INSERT 레이스). legacy(moi1) 발행은 새 카드 대신 기존 pending
    // 카드에 사유를 누적하고 그 카드를 반환한다 — R2 의 재요청 처리와 같은 계약.
    // 현재 수명(moi2) 발행은 create 트랜잭션 안에서 교체 대상을 먼저 회수하므로 여기서
    // 위반되면 예상 밖이다 — 조용히 접히면 stale 카드로 resolve 교착이 생길 수 있어 그대로
    // 노출한다(기존 카드 쓰기 5xx 계약 유지).
    if (!isPendingMissionHumanCardUniqueViolation(error)) throw error;
    if (cardInput.requestKey.startsWith("moi2:")) throw error;
    const bumped = await bumpPendingMissionHumanCard(db, spec.companyId, spec.missionId);
    const existing = bumped ? await findPendingMissionHumanCard(db, spec.companyId, spec.missionId) : null;
    if (!existing) throw error;
    return { decision: await operatorDecisionReadService(db).getRequired(existing.id), replayed: true };
  }
}

// [R2 2026-11-08] 미션 단위 열린 사람 카드 1장 계약의 조회·사유 누적 헬퍼.
// 게이트(새 발행 차단)는 submitMissionOwnerDecision 가, 사유 누적(repeatCount)은
// 기존 카드 행·요청키를 바꾸지 않고 이 메타데이터만 갱신한다 — resolve 권한 불변.
export async function findPendingMissionHumanCard(
  db: Pick<Db, "select">,
  companyId: string,
  missionId: string,
): Promise<{ id: string; requestKey: string; sourceContext: OperatorDecisionSourceContextJson } | null> {
  const [existing] = await db.select({
    id: operatorDecisions.id,
    requestKey: operatorDecisions.requestKey,
    sourceContext: operatorDecisions.sourceContext,
  }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId),
    eq(operatorDecisions.status, "pending"),
    eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
    sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
  )).orderBy(desc(operatorDecisions.createdAt)).limit(1);
  return existing ?? null;
}

/** [R2 2026-11-08] 기존 pending 카드에 반복 사유 누적 — repeatCount 만 증가(카드 행 불변). */
export async function bumpPendingMissionHumanCard(
  db: Db,
  companyId: string,
  missionId: string,
): Promise<boolean> {
  const existing = await findPendingMissionHumanCard(db, companyId, missionId);
  if (!existing) return false;
  const previous = existing.sourceContext?.missionOwnerHumanInput?.repeatCount;
  const repeatCount = (typeof previous === "number" && Number.isFinite(previous) && previous >= 0 ? previous : 0) + 1;
  const [updated] = await db.update(operatorDecisions).set({
    updatedAt: new Date(),
    sourceContext: {
      ...existing.sourceContext,
      missionOwnerHumanInput: { repeatCount },
    },
  }).where(and(
    eq(operatorDecisions.id, existing.id),
    eq(operatorDecisions.status, "pending"),
  )).returning({ id: operatorDecisions.id });
  return Boolean(updated);
}

/** [C1 2026-11-08] 미션의 남은 pending 사람 카드 1장을 회수(cancelled)한다 — 미션당 pending 1장
 * 부분 고유 인덱스 계약의 표면 교체. 현재 수명·갱신 카드 발행 경로가 같은 트랜잭션에서 호출한다. */
export async function withdrawPendingMissionHumanCard(
  db: Pick<Db, "select" | "update" | "insert">,
  companyId: string,
  missionId: string,
  audit: { actorId: string; reason: string; details?: Record<string, unknown> },
): Promise<{ id: string; requestKey: string } | null> {
  const existing = await findPendingMissionHumanCard(db, companyId, missionId);
  if (!existing) return null;
  const now = new Date();
  const [updated] = await db.update(operatorDecisions).set({
    status: "cancelled", cancelledAt: now, updatedAt: now,
  }).where(and(
    eq(operatorDecisions.companyId, companyId),
    eq(operatorDecisions.id, existing.id),
    eq(operatorDecisions.status, "pending"),
  )).returning({ id: operatorDecisions.id });
  if (!updated) return null;
  await db.insert(activityLog).values({
    companyId, actorType: "system" as const, actorId: audit.actorId,
    action: "operator_decision.cancelled", entityType: "operator_decision", entityId: existing.id,
    details: { schemaVersion: 1, operatorDecisionId: existing.id, requestKey: existing.requestKey,
      missionId, reason: audit.reason, ...(audit.details ?? {}) },
  });
  return { id: existing.id, requestKey: existing.requestKey };
}

async function replayHistoricalDefaultHumanInputCard(db: Db, spec: MissionOwnerHumanInputCardSpec,
  cardInput: CreateOperatorDecisionInput) {
  const historical = buildHistoricalDefaultOwnerHumanInputVariant(cardInput);
  if (!historical || !historical.requestKey.startsWith("moi1:")) return null;
  const expected = validateAndHashOperatorDecisionCreate(historical);
  const [card] = await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, spec.companyId), eq(operatorDecisions.requestKey, historical.requestKey),
  )).limit(1);
  if (!card) return null;
  let stored: CreateOperatorDecisionInput;
  try {
    stored = validateAndHashOperatorDecisionCreate({
      schemaVersion: card.schemaVersion, requestKey: card.requestKey, priority: card.priority,
      interactionType: card.interactionType, title: card.title, description: card.description,
      sourceType: card.sourceType, sourceId: card.sourceId,
      sourceContext: stripOperatorDecisionServerContext(card.sourceContext), definition: card.definition,
      issueId: card.issueId, continuationMode: card.continuationMode,
    }).input;
  } catch {
    return null;
  }
  if (card.requestHash !== expected.requestHash || !sameOwnerHumanValue(stored, expected.input)
    || card.requestedByAgentId !== spec.requestedByAgentId || card.requestedByUserId !== null
    || card.qualityActionId !== null || card.qualityBinding !== null) return null;
  return operatorDecisionWriteService(db).create(spec.companyId, historical, {
    type: "agent", id: spec.requestedByAgentId,
  });
}

async function tryMergePendingHumanInputCard(
  db: Db,
  spec: MissionOwnerHumanInputCardSpec,
  cardInput: CreateOperatorDecisionInput,
) {
  if (cardInput.requestKey.startsWith("moi2:")) return null;
  try {
    const [existing] = await db.select({
      id: operatorDecisions.id,
      requestKey: operatorDecisions.requestKey,
      sourceContext: operatorDecisions.sourceContext,
    }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, spec.companyId),
      eq(operatorDecisions.status, "pending"),
      eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
      eq(operatorDecisions.issueId, spec.ownerActionIssueId),
      eq(operatorDecisions.title, cardInput.title),
      sql`${operatorDecisions.sourceContext}->>'missionId' = ${spec.missionId}`,
    )).orderBy(desc(operatorDecisions.createdAt)).limit(1);
    if (!existing) return null;
    if (existing.requestKey === cardInput.requestKey) {
      return { decision: await operatorDecisionReadService(db).getRequired(existing.id), replayed: true };
    }
    const previous = existing.sourceContext?.missionOwnerHumanInput?.repeatCount;
    const repeatCount = (typeof previous === "number" && Number.isFinite(previous) && previous >= 0 ? previous : 0) + 1;
    const now = new Date();
    const [updated] = await db.update(operatorDecisions).set({
      updatedAt: now,
      sourceContext: {
        ...existing.sourceContext,
        missionOwnerHumanInput: {
          repeatCount,
          lastSeenDecisionEventId: spec.decisionEventId,
        },
      },
    }).where(and(
      eq(operatorDecisions.id, existing.id),
      eq(operatorDecisions.status, "pending"),
    )).returning({ id: operatorDecisions.id });
    if (!updated) return null;
    return { decision: await operatorDecisionReadService(db).getRequired(existing.id), replayed: true };
  } catch {
    return null;
  }
}
