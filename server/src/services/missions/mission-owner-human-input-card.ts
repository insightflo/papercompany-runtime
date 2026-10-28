// server/src/services/missions/mission-owner-human-input-card.ts
//
// [목적] mission owner 결정 API의 사람 핸드오프 결정(request_input/escalate)을 operator decision
//   card 로 브리지한다(계획 2026-10-17-human-decision-escalation-contract Stage 1).
// [계약] D2 legacy requestKey=moi1:{decisionEventId}, C08 수명은 moi2:{lifetimeId}. sourceId 는
//   원 결정 이벤트다(sourceContext 에 decisionEventId 를 넣지 않는다). D3 기본 approve/hold/reject 선택지(reject
//   포함이라 comment required)+humanReview 패킷 필수 매핑, D5 스냅샷 앵커=owner-action 이슈
//   issueId+issueStatus, workflowRunId 는 실제 workflowRuns 행이 확인된 id 만 호출부가 전달한다.
// [fail-closed] 판단 근거(앵커)를 해석할 수 없으면 카드 입력을 만들지 않고 422 로 제출을 거부해
//   오너가 증거와 함께 재제출하게 한다. 카드 생성 자체의 실패는 호출부(agent api)의 post-commit
//   5xx 계약(D4)을 따른다.
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
import { buildDefaultOwnerHumanDefinition } from "./mission-owner-human-default-definition.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./workflow-restart-option.js";

export const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";
export const MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED = "mission_owner_human_input_card_mapping_failed";

// [D2] 결정 이벤트 1건 = 카드 1건 — 멱등 키 규약.
export function buildHumanInputDecisionCardRequestKey(decisionEventId: string): string {
  return `moi1:${decisionEventId}`;
}

// [D3] payload 구조화 options 가 있으면 우선 사용한다. 생산자가 아직 없는 선택적 입력이라
//   형식 위반 시 조용히 기본 선택지로 떨어뜨리지 않고 422 로 거부한다(fail-closed).
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

/**
 * [D2/D3/D5 순수 빌더] 카드 create 입력을 만든다. 앵커 해석 불가 시 422(mapping_failed).
 * 같은 legacy 결정 이벤트 또는 같은 수명의 불변 입력은 같은 requestHash 를 만든다.
 * C08 수명 입력은 create 트랜잭션에서 저장된 원문과 현재 권위를 다시 대조한다.
 */
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
  // [요청자 추천] 선택지를 넘기는 요청은 근거와 함께 추천도 제시한다 — 판단 부담만 사람에게 넘기지
  //   않는다. 대응 옵션이 없는 optionId 는 조용히 무시한다(fail-open: 발화 누락 방지 계약 유지).
  //   최종 정의는 입력에 결정적이므로 requestKey 멱등 replay 규약도 그대로다.
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

/**
 * [D4] 카드 생성은 자체 트랜잭션(write.create)에서 실행되므로 결정 ledger 트랜잭션 밖(post-commit)에서
 *   호출해야 한다. replay(동일 companyId+requestKey+requestHash)면 기존 카드를 반환한다.
 *
 * [중복 병합 2026-10-18] 생성 직전 같은 (companyId, missionId, 앵커 issueId, decision 종류)의 pending
 *   카드가 있으면 새 생성 대신 기존 카드를 최신화(updatedAt=now, sourceContext.missionOwnerHumanInput.
 *   repeatCount 증가)하고 기존 카드를 반환한다 — 같은 건이 계류 중인데 시차를 두고 카드가 반복
 *   쌓이는 라이브 문제(2026-10-18 operator inbox) 대응. 병합은 카드 생성·표시 계층만의 동작이며
 *   발화·감사 이벤트·원장 기록은 억제하지 않는다(호출부는 매 이벤트마다 그대로 기록한다).
 *   안전 방향 설계: decision 종류가 다르거나(제목이 결정 종류별로 결정적이라 제목 동등성으로 대조)
 *   앵커 이슈가 다르거나, 기존이 pending 이 아니면(resolved/cancelled), 대조 쿼리가 실패하면
 *   전부 신규 생성(fail-open) — 잘못된 중복판정으로 띄워야 할 카드를 발화 못 시키는 일은 없다.
 *   같은 eventId 멱등 replay 는 기존 requestKey 규약을 그대로 따른다(갱신 없이 기존 카드 반환).
 */
export async function createMissionOwnerHumanInputDecisionCard(db: Db, spec: MissionOwnerHumanInputCardSpec) {
  const cardInput = buildMissionOwnerHumanInputDecisionCard(spec);
  const merged = await tryMergePendingHumanInputCard(db, spec, cardInput);
  if (merged) return merged;
  return operatorDecisionWriteService(db).create(spec.companyId, cardInput, { type: "agent", id: spec.requestedByAgentId });
}

// [중복 병합] 병합 대조 키 전체가 일치하는 pending 카드 1건(여러 장이면 최신)을 찾는다. 제목은
//   buildMissionOwnerHumanInputDecisionCard 가 decision 종류별로 결정적으로 만들므로 동등성
//   비교가 곧 종류 비교다(제목 형식이 바뀌면 매칭이 실패해 신규 생성되는 fail-open 방향).
async function tryMergePendingHumanInputCard(
  db: Db,
  spec: MissionOwnerHumanInputCardSpec,
  cardInput: CreateOperatorDecisionInput,
) {
  // Lifetime cards carry their own current binding and must replay through the verified writer.
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
    // 같은 eventId 멱등 replay — 기존 requestKey 규약 그대로 갱신 없이 반환한다.
    if (existing.requestKey === cardInput.requestKey) {
      return { decision: await operatorDecisionReadService(db).getRequired(existing.id), replayed: true };
    }
    const previous = existing.sourceContext?.missionOwnerHumanInput?.repeatCount;
    const repeatCount = (typeof previous === "number" && Number.isFinite(previous) && previous >= 0 ? previous : 0) + 1;
    const now = new Date();
    // CAS on pending — 대조 후 결·취소로 바뀌었으면 병합하지 않고 신규 생성으로 돌아간다.
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
    // fail-open — 대조/갱신에 실패하면 최악이 현행과 동일한 중복 생성이다(발화 누락은 없다).
    return null;
  }
}
