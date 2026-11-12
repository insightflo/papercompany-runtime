// server/src/services/missions/mission-owner-human-input-card-precompact.ts
// [레거시 호환 2026-11-12] 구형 mission_owner_human_input 카드의 C08 재구성 대조용, 얼린 빌더 모음.
// - buildPreCompactMissionOwnerHumanInputDecisionCard: PR #703(e0116f92, 사람 카드 축소 Stage 1)
//   배포 이전에 발행된 구조화 카드(be79dd99 등)용. 본문은 e0116f92~1(= 226bef66)의
//   buildMissionOwnerHumanInputDecisionCard 를 함수명만 바꿔 그대로 옮겼다
//   (전문 description·요약 3줄·symptom 없는 humanReview·원본 선택지 설명).
// - buildStage1CompactMissionOwnerHumanInputDecisionCard: #703 배포 이후~C4 빌더 변경 이전에
//   발행된 Stage-1 축소 카드(f44d6f91 등)용. 본문은 dd563dcf 의 동일 함수를 함수명만 바꿔
//   그대로 옮겼다(symptom 2줄·1줄 선택지 설명·축소 description·1문장 interpretation).
// 새 카드는 절대 이 형식들로 발행되지 않는다 — 현행 빌더(mission-owner-human-input-card.ts)가
// 유일한 발행 경로이며, 이 모듈은 cardMatchesInput/현재성 대조의 후보 재구성에만 쓰인다.
// 원본이 바이트 단위로 동일해야 requestHash 비교가 성립하므로 내부 로직은 일절 손대지 않는다.
// 얼린 빌더는 현행 빌더와 헬퍼를 공유하지 않는다 — 현행 빌더가 바뀌어도 이 형식은 불변이어야 하고,
// 입력 스펙에 이후 추가되는 필드(예: prerequisiteNotice)는 당시 없던 값이므로 읽지 않는다.
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
} from "@paperclipai/shared/types/operator-decision";
import { z } from "zod";
import { unprocessable } from "../../errors.js";
import {
  buildHumanInputDecisionCardRequestKey,
  MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  type MissionOwnerHumanInputCardSpec,
} from "./mission-owner-human-input-card.js";
import { buildDefaultOwnerHumanDefinition } from "./mission-owner-human-default-definition.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./workflow-restart-option.js";

const structuredOptionSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).nullable().optional(),
}).strict();

const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;
const present = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

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
function buildStructuredDefinition(optionsInput: unknown): OperatorDecisionDefinition {
  const parsed = z.array(structuredOptionSchema).min(1).max(50).safeParse(optionsInput);
  if (!parsed.success) mappingFailure("payload 구조화 options 형식 위반");
  const options = parsed.data!.map((option) => ({
    id: option.id,
    label: option.label,
    description: option.description ?? null,
    facts: [],
    evidenceRefs: [],
  }));
  return {
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
  };
}
/** Build a validated card request; natural-language fields never select an operation. */
export function buildPreCompactMissionOwnerHumanInputDecisionCard(input: MissionOwnerHumanInputCardSpec): CreateOperatorDecisionInput {
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
      description: clip(present(input.reason) ?? "결정 요청 사유는 이슈 본문에서 확인해 주세요", 1_000),
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
      description: clip(present(input.evidence) ?? "", 1_000),
    });
  }
  const evidenceOptionRefs = evidence.map((ref) => ({ label: ref.label, href: ref.href }));
  // 실행 선택지는 생산자가 구조화해 전달한 options만 사용한다. nextAction은 표시·검토 문구이며
  // operation/target 권한으로 파싱하지 않는다.
  const definition = input.structuredOptions !== undefined
    ? buildStructuredDefinition(input.structuredOptions)
    : buildDefaultOwnerHumanDefinition(evidenceOptionRefs, input.workflowRunId);
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
  const summaryLines = [
    `요청 사유: ${present(input.reason) ?? "(미제출)"}`,
    `요청된 다음 단계: ${present(input.nextAction) ?? "(미제출)"}`,
    `오너 제출 근거: ${present(input.evidence) ?? "(미제출 — 이슈 본문과 원천 이슈에서 확인)"}`,
  ];
  return {
    schemaVersion: 1,
    requestKey: input.lifetimeId !== undefined
      ? `moi2:${input.lifetimeId}`
      : buildHumanInputDecisionCardRequestKey(decisionEventId),
    priority: "high",
    interactionType: "single_select",
    title: clip(`사람 결정 승인 요청 — ${decisionLabel}`, 200),
    description: clip([
      `## 미션 오너의 사람 결정 요청(${decisionLabel})`,
      "",
      ...summaryLines,
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
        decisionSubject: clip(`미션 오너의 사람 결정 요청 — ${decisionLabel} 승인 여부`, 300),
        evidence,
        interpretation: clip([
          `미션 오너 에이전트가 사람 결정(${decisionLabel})을 요청했습니다.`,
          ...summaryLines,
        ].join("\n"), 4_000),
        impact: {
          ifApproved: "선택한 방향이 미션 오너 에이전트에 전달되고, 오너가 자기 권한 경로(기존 실행 API)로 다음 단계를 진행합니다.",
          ifRejected: "요청이 반려됩니다. 반려 사유가 오너에게 전달되고 오너는 대기·보고 상태를 유지하거나 다시 에스컬레이션합니다.",
          ifWrong: "잘못된 방향이 전달되면 오너가 잘못된 다음 단계를 진행할 수 있습니다. 반려·보류로 실행을 막고 사유를 남길 수 있습니다.",
        },
        unresolvedFacts: present(input.evidence) ? [] : ["오너가 제출 근거 텍스트를 남기지 않았습니다 — 이슈 본문에서 직접 확인이 필요합니다."],
        questions: ["이 사람 결정 요청을 승인할까요?"],
        recommendedNextStep: clip(present(input.nextAction) ?? "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.", 2_000),
        requiredReviewer: "human-operator",
      },
    },
    issueId: input.ownerActionIssueId,
    continuationMode: "issue_current_assignee",
  };
}

// [Stage-1 축소 2026-11-12 동결] dd563dcf 의 축소 헬퍼 그대로 — 문장/절 경계 우선 클립.
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

/** 증상 최대 2줄 — 빈 줄 제거·줄별 trim, 개행 최대 1개, 전체 ≤220자 경계 클립. 미제출이면 undefined. */
function formatSymptom(reason: string | undefined): string | undefined {
  const lines = (reason ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  if (lines.length === 0) return undefined;
  return clipAtBoundary(lines.join("\n"), 220) || undefined;
}

function buildStage1StructuredDefinition(optionsInput: unknown): OperatorDecisionDefinition {
  const parsed = z.array(structuredOptionSchema).min(1).max(50).safeParse(optionsInput);
  if (!parsed.success) mappingFailure("payload 구조화 options 형식 위반");
  const options = parsed.data!.map((option) => ({
    id: option.id,
    label: option.label,
    // [사람 카드 축소 Stage 1] 선택지 설명은 항상 1줄 — 개행을 공백으로 치환한다.
    description: option.description != null ? (toOneLine(option.description, 1_000) || null) : null,
    facts: [],
    evidenceRefs: [],
  }));
  return {
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
  };
}

/** Build a validated card request; natural-language fields never select an operation. */
export function buildStage1CompactMissionOwnerHumanInputDecisionCard(input: MissionOwnerHumanInputCardSpec): CreateOperatorDecisionInput {
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
  const definition = input.structuredOptions !== undefined
    ? buildStage1StructuredDefinition(input.structuredOptions)
    : buildDefaultOwnerHumanDefinition(evidenceOptionRefs, input.workflowRunId);
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
  const requestedNextAction = present(input.nextAction);
  const interpretation = toOneLine(requestedNextAction
    ? `사람 결정(${decisionLabel}) 요청 — 다음 단계로 "${requestedNextAction}"의 승인 여부를 판단해 주세요.`
    : `사람 결정(${decisionLabel}) 요청 — 연결된 이슈의 근거로 승인·보류·반려를 판단해 주세요.`, 200);
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
        unresolvedFacts: present(input.evidence) ? [] : ["오너가 제출 근거 텍스트를 남기지 않았습니다 — 이슈 본문에서 직접 확인이 필요합니다."],
        questions: ["이 사람 결정 요청을 승인할까요?"],
        recommendedNextStep: clip(present(input.nextAction) ?? "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.", 2_000),
        requiredReviewer: "human-operator",
      },
    },
    issueId: input.ownerActionIssueId,
    continuationMode: "issue_current_assignee",
  };
}

/** C08 대조 후보 재구성 — 최신순(Stage-1 축소 → pre-#703 구조화). 저장된 cardInput 으로
 *  발행 당시 형식을 그대로 되살려 반환하며, 변조된 카드는 어떤 후보와도 일치하지 않는다. */
export function buildLegacyMissionOwnerHumanInputDecisionCardVariants(
  input: MissionOwnerHumanInputCardSpec,
): CreateOperatorDecisionInput[] {
  return [
    buildStage1CompactMissionOwnerHumanInputDecisionCard(input),
    buildPreCompactMissionOwnerHumanInputDecisionCard(input),
  ];
}
