// server/src/services/missions/mission-owner-human-input-card.ts
// Bridges structured mission-owner requests into operator cards. moi1 binds an event and moi2 a saved lifetime.
// Only callers that verified a workflowRuns row may set workflowRunId; unresolved anchors fail with 422.
// Card writes remain post-commit and retain the caller's existing 5xx contract.
import type { Db } from "@paperclipai/db";
import { operatorDecisions } from "@paperclipai/db";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
} from "@paperclipai/shared/types/operator-decision";
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

export const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";
export const MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED = "mission_owner_human_input_card_mapping_failed";

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
};

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

/** Merge an equivalent pending request, replay an exact terminal legacy card, or create normally. */
export async function createMissionOwnerHumanInputDecisionCard(db: Db, spec: MissionOwnerHumanInputCardSpec) {
  const cardInput = buildMissionOwnerHumanInputDecisionCard(spec);
  const merged = await tryMergePendingHumanInputCard(db, spec, cardInput);
  if (merged) return merged;
  const historicalReplay = await replayHistoricalDefaultHumanInputCard(db, spec, cardInput);
  if (historicalReplay) return historicalReplay;
  return operatorDecisionWriteService(db).create(spec.companyId, cardInput, { type: "agent", id: spec.requestedByAgentId });
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
