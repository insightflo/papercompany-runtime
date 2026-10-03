// server/src/services/missions/revision-plan-decision-state.ts
//
// [파일 목적] mission-owner-plan-decisions.ts(recordLatestAuthorizedMissionOwnerPlanDecision)의 revision
//   decision 상태 전이 중 응집된 두 조각을 옮긴다(변경지도 구조 교정 — 대형 파일 축소, 행동 불변).
//   (1) validateRevisionPlanDeltaOrRecordRejection: 버전 있는 수정 변경안(revisionDelta) 검증 →
//       현재 템플릿 상속 적용(유일한 templateStepId 대응, 생략된 연결만) → 상속된 유효 유닛 대상
//       입력 연결 검증 → 거부 원장(mission_plan_decision_submissions) 기록 → invalid 응답 반환.
//   (2) buildRevisionDecisionRefs: 새 decision 의 활성 계획 refs 병합(selectedExecutionUnits replace)과
//       이전 decision 권위(paqoWorkflow/crossCompanyDelegations/planQa) 제거.
// [연결] 호출 위치는 원본 그대로 유지한다: (1) 은 source-ref/execution-placement 검증 뒤, autofill/PLAN-QA
//   앞. (2) 는 새 decision(decisionHash 불일치)의 revision 생성 직전.
// [수정시 주의] decisionHash, 원장 sourceCommentId 와 응답 commentId 구분, 모든 diagnostics 부가 필드,
//   반환 형태, 검증된 revisionDelta 보존/부재 시 제거 규칙을 바꾸지 않는다. 변경안이 없는 일반 미션
//   경로는 validateRevisionPlanDelta 가 ok+null 을 돌려주므로 그대로 통과한다(회귀 없음).
import { mergeMissionPlanRefs } from "../mission-plan-artifacts.js";
import { upsertMissionPlanDecisionSubmission } from "./mission-plan-decision-ledger.js";
import {
  validateRevisionPlanDelta,
  validateRevisionPlanDeltaWiring,
  type RevisionPlanDeltaDiagnostic,
} from "./revision-plan-delta.js";
import { applyRevisionDeltaUnitInputs } from "./revision-plan-delta-inputs.js";
import { inheritCurrentTemplateWiring } from "./revision-plan-template-inheritance.js";
import type { PlanningArtifactTool } from "./mission-plan-publication-contract.js";

type MissionPlanDecisionLedgerSubmission = Omit<
  Parameters<typeof upsertMissionPlanDecisionSubmission>[0],
  "status" | "rejectionReason" | "diagnostics"
>;

/** record 경로가 그대로 반환할 invalid 응답 형태(원본 반환 형태 보존). */
export type RevisionPlanDeltaInvalidResponse = {
  status: "invalid";
  reason: string;
  planningIssueId: string | null;
  commentId: string | null;
  decisionHash: string;
  diagnostics: RevisionPlanDeltaDiagnostic[];
};

/** [슬라이스1] 변경안 검증 결과: 통과하면 원본 delta 와 상속·입력연결 검증까지 통과한 유효 유닛, 거부하면 invalid 응답. */
export type RevisionPlanDeltaGate =
  | { ok: true; delta: Record<string, unknown> | null; units: Record<string, unknown>[] }
  | { ok: false; response: RevisionPlanDeltaInvalidResponse };

// [슬라이스1] 버전 있는 수정 변경안(revisionDelta) 검증 + 현재 템플릿 상속 적용. 실행 배치(도구/권한)
//   검증이 통과한 뒤, PLAN-QA 생성·의도 검사·구조 검증·물화 이전에 계약 위반과 상속 불가 대응을
//   구조화 거절한다(거부는 PLAN-QA 를 만들지 않는다). 통과하면 유일한 templateStepId 대응에 따라
//   생략된 연결을 상속하고 변경안 단위의 지시·해석 입력을 적용한 유효 유닛을 돌려준다(autofill/PLAN-QA/물화/refs 가
//   같은 초안을 본다). 변경안이 없으면 기존 선택적 경로를 그대로 둔다(일반 미션 회귀 없음).
export async function validateRevisionPlanDeltaOrRecordRejection(input: {
  /** 제출 원장 필수 필드 묶음(db/companyId/missionId/planningIssueId/decisionHash/decision 등). */
  readonly ledgerSubmission: MissionPlanDecisionLedgerSubmission;
  /** 응답 commentId — 원장 sourceCommentId 와 구분되는 값이다(원본 구분 보존). */
  readonly commentId: string | null;
  readonly missionSourceWorkflowRunId: string | null;
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly tools: readonly PlanningArtifactTool[];
}): Promise<RevisionPlanDeltaGate> {
  const validation = await validateRevisionPlanDelta({
    db: input.ledgerSubmission.db,
    companyId: input.ledgerSubmission.companyId,
    missionSourceWorkflowRunId: input.missionSourceWorkflowRunId,
    decision: input.ledgerSubmission.decision,
    selectedExecutionUnits: input.selectedExecutionUnits,
    tools: input.tools,
  });
  if (validation.ok) {
    if (validation.delta === null) return { ok: true, delta: null, units: [...input.selectedExecutionUnits] };
    const inheritance = await inheritCurrentTemplateWiring({
      db: input.ledgerSubmission.db,
      companyId: input.ledgerSubmission.companyId,
      delta: validation.delta,
      selectedExecutionUnits: input.selectedExecutionUnits,
      decision: input.ledgerSubmission.decision,
    });
    const wiringDiagnostics = inheritance.ok
      ? validateRevisionPlanDeltaWiring({ delta: validation.delta, selectedExecutionUnits: inheritance.units })
      : inheritance.diagnostics;
    if (inheritance.ok && wiringDiagnostics.length === 0) {
      return {
        ok: true,
        delta: validation.delta,
        units: applyRevisionDeltaUnitInputs(validation.delta, inheritance.units),
      };
    }
    const reason = inheritance.ok ? wiringDiagnostics[0]!.code : inheritance.reason;
    const diagnostics = inheritance.ok ? wiringDiagnostics : inheritance.diagnostics;
    await upsertMissionPlanDecisionSubmission({
      ...input.ledgerSubmission,
      status: "rejected",
      rejectionReason: reason,
      diagnostics,
    });
    return {
      ok: false,
      response: {
        status: "invalid",
        reason,
        planningIssueId: input.ledgerSubmission.planningIssueId,
        commentId: input.commentId,
        decisionHash: input.ledgerSubmission.decisionHash,
        diagnostics,
      },
    };
  }
  await upsertMissionPlanDecisionSubmission({
    ...input.ledgerSubmission,
    status: "rejected",
    rejectionReason: validation.reason,
    diagnostics: validation.diagnostics,
  });
  return {
    ok: false,
    response: {
      status: "invalid",
      reason: validation.reason,
      planningIssueId: input.ledgerSubmission.planningIssueId,
      commentId: input.commentId,
      decisionHash: input.ledgerSubmission.decisionHash,
      diagnostics: validation.diagnostics,
    },
  };
}

/** 선택 초안 refs 중 병합에 필요한 최소 구조(PlanRevisionDraft.refs 와 구조적으로 호환된다). */
type RevisionDecisionDraftRefs = {
  ownerPlanDecision: Record<string, unknown>;
  [key: string]: unknown;
};

// 새 decision 는 이전 decision 의 materialization 결과(paqoWorkflow/crossCompanyDelegations)와 이전 planQa
// 게이트 상태를 계승하지 않는다. planQa 는 binding tx 가 현재 decision 기준으로 다시 쓴다.
// PASS 시 idempotent branch 에서 새 decision 기준으로 materialize 한다.
export function buildRevisionDecisionRefs(input: {
  readonly activePlanRefs: unknown;
  readonly effectiveDraftRefs: RevisionDecisionDraftRefs;
  readonly decisionHash: string;
  readonly revisionDelta: Record<string, unknown> | null;
}): ReturnType<typeof mergeMissionPlanRefs> {
  const refs = mergeMissionPlanRefs(
    input.activePlanRefs,
    {
      ...input.effectiveDraftRefs,
      ownerPlanDecision: { ...input.effectiveDraftRefs.ownerPlanDecision, decisionHash: input.decisionHash },
      // [슬라이스1] 검증을 통과한 버전 있는 변경안은 활성 계획 refs 에 그대로 보존된다.
      ...(input.revisionDelta ? { revisionDelta: input.revisionDelta } : {}),
    },
    { selectedExecutionUnits: "replace" },
  );
  delete (refs as Record<string, unknown>).paqoWorkflow;
  delete (refs as Record<string, unknown>).crossCompanyDelegations;
  delete (refs as Record<string, unknown>).planQa;
  // 새 decision 이 변경안을 포함하지 않으면 이전 변경안 계약이 활성 계획을 계속 지배하지 않는다.
  if (!input.revisionDelta) delete (refs as Record<string, unknown>).revisionDelta;
  return refs;
}
