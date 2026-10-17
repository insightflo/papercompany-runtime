// server/src/services/missions/mission-owner-human-input-card.ts
//
// [목적] mission owner 결정 API의 사람 핸드오프 결정(request_input/escalate)을 operator decision
//   card 로 브리지한다(계획 2026-10-17-human-decision-escalation-contract Stage 1).
// [계약] D2 requestKey=`moi1:{decisionEventId}` + sourceId=decisionEventId(decisionEventId 는
//   sourceContext strict 스키마에 없으므로 넣지 않는다), D3 기본 approve/hold/reject 선택지(reject
//   포함이라 comment required)+humanReview 패킷 필수 매핑, D5 스냅샷 앵커=owner-action 이슈
//   issueId+issueStatus, workflowRunId 는 실제 workflowRuns 행이 확인된 id 만 호출부가 전달한다.
// [fail-closed] 판단 근거(앵커)를 해석할 수 없으면 카드 입력을 만들지 않고 422 로 제출을 거부해
//   오너가 증거와 함께 재제출하게 한다. 카드 생성 자체의 실패는 호출부(agent api)의 post-commit
//   5xx 계약(D4)을 따른다.
import type { Db } from "@paperclipai/db";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
} from "@paperclipai/shared/types/operator-decision";
import { z } from "zod";
import { unprocessable } from "../../errors.js";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";

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
  readonly decision: "request_input" | "escalate";
  readonly ownerActionIssueId: string;
  readonly ownerActionIssueStatus: string;
  /** 미션 오너 에이전트 — 카드 requestedByAgentId(resolve 웨이크 수신자). */
  readonly requestedByAgentId: string;
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
    approvedScope: ["operator_decision.resolve"],
    forbiddenScope: ["agent_substitute_submission", "auto_execution"],
  };
}

function buildDefaultDefinition(evidenceRefs: { label: string; href: string }[]): OperatorDecisionDefinition {
  const option = (id: string, label: string, description: string, fact: string) => ({
    id, label, description,
    facts: [{ label: "선택 시", value: clip(fact, 200), status: "known" as const }],
    evidenceRefs,
  });
  return {
    options: [
      option("approve", "승인", "요청된 다음 단계를 승인합니다", "오너가 승인받은 다음 단계를 자기 권한으로 진행합니다"),
      option("hold", "보류", "진행을 보류하고 현재 상태를 유지합니다", "실행은 보류되고 요청은 대기 상태로 남습니다"),
      option("reject", "반려", "핸드오프 요청을 반려합니다", "요청이 반려되고 사유가 오너에게 전달됩니다"),
    ],
    actions: [
      { id: "approve", label: "승인", outcome: "approve", tone: "primary", requiresSelection: true },
      { id: "hold", label: "보류", outcome: "hold", tone: "neutral", requiresSelection: true },
      { id: "reject", label: "반려", outcome: "reject", tone: "danger", requiresSelection: true },
    ],
    selection: { min: 1, max: 1 },
    // [D3] 기본 선택지에 reject 가 포함되므로 사유를 필수로 받는다(스키마가 정의 단위 모드라 전체 required).
    comment: { mode: "required", label: "결정 사유", placeholder: "승인·보류·반려 사유를 남겨 주세요", maxLength: 2_000 },
    approvedScope: ["operator_decision.resolve"],
    forbiddenScope: ["agent_substitute_submission", "auto_execution"],
  };
}

/**
 * [D2/D3/D5 순수 빌더] 카드 create 입력을 만든다. 앵커 해석 불가 시 422(mapping_failed).
 * 결정적(deterministic)이라 같은 결정 이벤트 재제출 시 같은 requestHash 가 나와 requestKey 멱등
 * replay 이 성립한다.
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
  const definition = input.structuredOptions !== undefined
    ? buildStructuredDefinition(input.structuredOptions)
    : buildDefaultDefinition(evidenceOptionRefs);
  const summaryLines = [
    `요청 사유: ${present(input.reason) ?? "(미제출)"}`,
    `요청된 다음 단계: ${present(input.nextAction) ?? "(미제출)"}`,
    `오너 제출 근거: ${present(input.evidence) ?? "(미제출 — 이슈 본문과 원천 이슈에서 확인)"}`,
  ];
  return {
    schemaVersion: 1,
    requestKey: buildHumanInputDecisionCardRequestKey(decisionEventId),
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
      ...definition,
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
 */
export async function createMissionOwnerHumanInputDecisionCard(db: Db, spec: MissionOwnerHumanInputCardSpec) {
  const cardInput = buildMissionOwnerHumanInputDecisionCard(spec);
  return operatorDecisionWriteService(db).create(spec.companyId, cardInput, { type: "agent", id: spec.requestedByAgentId });
}
