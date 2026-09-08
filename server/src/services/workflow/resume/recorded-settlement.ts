import type { ResumeExecutionHistory } from "./read-model.js";
import {
  allRequiredStages,
  C_STAGE,
  O_STAGE,
  Q_STAGE,
  STAGE_CLASS,
  type FinalizationStageClass,
} from "../../heartbeat-finalization/stage-classifier.js";

/**
 * [파일 목적] Task5c3a 기록된(recorded) heartbeat 정산 증거의 순수 검증기 — 미래 resume
 *   preview 가 실제 DB rows(finalizations/finalizationSteps/heartbeats) 위에서 이 함수로
 *   "기록된 정산이 증명되는가"를 확인한다. 동기·순수: DB/fs/env/time/OS/network 읽기 없음,
 *   callback 없음, hash/sign 없음, ordinary unsupported record 에 예외를 던지지 않는다.
 * [명시적 한계 — 이 검사의 통과는 그 이상을 주장하지 않는다]
 *   - blockers 없음 = 기록된 행들이 "이" 검사를 통과했을 뿐이다. fresh resource/wakeup/tool/
 *     issue/delegation/run 검사, lineage 완전성, evidence, budget, effect registry, signer,
 *     routes 는 이후 슬라이스 소관이다. 빈 결과는 완전한 quiescence/적격성 증명이 아니다.
 *   - 이력 부재는 과거 작업 부재를 증명하지 않는다(absent history never certifies no prior work).
 *   - settlement.ts/finalization-state/quiescence-probe/recovery 등 mutating/OS 모듈을 import
 *     하지 않는다. 필요한 required kind/class 는 stage-classifier 의 순수 allRequiredStages 만
 *     재사용한다. 기존 reader/signer/eligibility/finalization 엔진은 일절 변경하지 않는다.
 * [규칙 근거] settlement.ts: finalizationVersion1 + settledAt 가 정상 내구 정산, 모든 Q 에 done 행,
 *   dead_letter Q 는 절대 차단, C 는 done|equivalent_failed, O 는 선택. recovery.ts: 정산은
 *   terminal v1 + settledAt null 만 재선택하고 parent state 를 completed 로 만들지 않는다 —
 *   정상 수용 parent 는 임대 없는 pending 이므로 여기서도 exactly 그 상태만 요구한다.
 *   owner-capability.ts: executorOwnerReleasedAt 만 소유 역량 해제 증명이고 만료 임대 단독은 아니다.
 * [검사 규칙(번호 순, heartbeat 당 첫 실패 규칙 1개)] 1) scope/link 정합성 → scope_mismatch/
 *   settlement_scope_mismatch(reader 가 대부분 거부하지만 독립 호출 방어). 2) terminal status.
 *   3) v1+settledAt+ownerRelease+terminalDecision 내구 증명. 4) pending 무임대 v1 parent 가
 *   execution identity 에 정확 결속. 5) 기록된 모든 stage 의 kind/class/state/lease 와
 *   required Q/C 충족. 수행 대상은 입력 heartbeat 전부(구세대/legacy JSON-only 포함, generation
 *   필터 없음)이며 caller 배열은 절대 변이하지 않고 copy 를 id codepoint 순으로 정렬해 본다.
 */

export type RecordedSettlementInput = Pick<
  ResumeExecutionHistory,
  "scope" | "heartbeats" | "finalizations" | "finalizationSteps"
>;

export type RecordedSettlementBlockerReason =
  | "settlement_scope_mismatch"
  | "heartbeat_not_terminal"
  | "settlement_unproven"
  | "finalization_identity_unproven"
  | "finalization_stages_unproven";

export type RecordedSettlementBlocker = {
  code: "active_work" | "scope_mismatch";
  heartbeatRunId: string;
  reason: RecordedSettlementBlockerReason;
};

type HeartbeatRow = ResumeExecutionHistory["heartbeats"][number];
type FinalizationRow = ResumeExecutionHistory["finalizations"][number];
type FinalizationStepRow = ResumeExecutionHistory["finalizationSteps"][number];

const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const PARENT_PENDING_STATE = "pending";

/** Q_STAGE/C_STAGE/O_STAGE export 기반 kind→class 사가(미지 kind 부재 = 차단). */
const KIND_TO_CLASS: Readonly<Record<string, FinalizationStageClass>> = {
  [Q_STAGE.executorQuiescence]: STAGE_CLASS.quiescence,
  [Q_STAGE.workspaceOperationsSettled]: STAGE_CLASS.quiescence,
  [Q_STAGE.runtimeServicesStopped]: STAGE_CLASS.quiescence,
  [Q_STAGE.missionRuntimeIdle]: STAGE_CLASS.quiescence,
  [C_STAGE.issuePromotion]: STAGE_CLASS.compensable,
  [C_STAGE.workflowEvidenceSync]: STAGE_CLASS.compensable,
  [C_STAGE.missionHandoff]: STAGE_CLASS.compensable,
  [O_STAGE.livePublication]: STAGE_CLASS.optional,
};

/** class 별 허용 기록 state — Q 는 done 만, C 는 done|equivalent_failed, O 는 +dead_letter. */
const ALLOWED_STATES: Readonly<Record<FinalizationStageClass, ReadonlySet<string>>> = {
  [STAGE_CLASS.quiescence]: new Set(["done"]),
  [STAGE_CLASS.compensable]: new Set(["done", "equivalent_failed"]),
  [STAGE_CLASS.optional]: new Set(["done", "equivalent_failed", "dead_letter"]),
};

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byIdCodepoint(a: { id: string }, b: { id: string }): number {
  return compareStrings(a.id, b.id);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 누적기 — 동일 (heartbeatRunId, code, reason) 중복 제거. 구분자 연결 문자열 키를 만들지 않고
 * 중첩 Map/Set 으로만 판정한다. 반환 배열은 최종적으로 heartbeatRunId→code→reason codepoint 정렬.
 */
function createBlockerSink() {
  const blockers: RecordedSettlementBlocker[] = [];
  const emitted = new Map<string, Map<RecordedSettlementBlocker["code"], Set<RecordedSettlementBlockerReason>>>();
  function emit(code: RecordedSettlementBlocker["code"], heartbeatRunId: string, reason: RecordedSettlementBlockerReason): void {
    let byCode = emitted.get(heartbeatRunId);
    if (!byCode) {
      byCode = new Map();
      emitted.set(heartbeatRunId, byCode);
    }
    let byReason = byCode.get(code);
    if (!byReason) {
      byReason = new Set();
      byCode.set(code, byReason);
    }
    if (byReason.has(reason)) return;
    byReason.add(reason);
    blockers.push({ code, heartbeatRunId, reason });
  }
  return { blockers, emit };
}

/** 규칙 5 본체 — 모든 기록 stage 의 gates + 실제 분류기 기반 required Q/C 충족 검사. */
function recordedStagesUnproven(heartbeat: HeartbeatRow, stages: FinalizationStepRow[]): boolean {
  for (const stage of stages) {
    const canonicalClass = KIND_TO_CLASS[stage.stageKind];
    if (canonicalClass === undefined || stage.stageClass !== canonicalClass) return true;
    if (!ALLOWED_STATES[canonicalClass].has(stage.state)) return true;
    // 만료 포함 임대 잔존은 활성 작업 — epoch 카운터(leaseEpoch) 단독은 이력으로 허용.
    if (stage.leaseOwner !== null || stage.leaseToken !== null || stage.leaseExpiresAt !== null) return true;
  }
  for (const required of allRequiredStages(heartbeat)) {
    // Optional O 는 부재 허용(요구하지 않음) — 존재해도 위 gates 를 통과해야 한다.
    if (required.stageClass === STAGE_CLASS.optional) continue;
    const satisfied = stages.some((stage) =>
      stage.stageKind === required.kind
      && stage.stageClass === required.stageClass
      && ALLOWED_STATES[required.stageClass].has(stage.state));
    if (!satisfied) return true;
  }
  return false;
}

/** 계약 전체 — 기록된 정산 검증 순수 진입점. 유효 기록은 [] (적격 플래그가 아니다). */
export function checkRecordedHeartbeatSettlements(input: RecordedSettlementInput): RecordedSettlementBlocker[] {
  const scope = input.scope;
  const { blockers, emit } = createBlockerSink();

  // caller 배열 보존 — 반드시 copy 를 정렬한다(id codepoint 비교, locale/normalize 없음).
  const heartbeats = [...input.heartbeats].sort(byIdCodepoint);
  const finalizations = [...input.finalizations].sort(byIdCodepoint);
  const finalizationSteps = [...input.finalizationSteps].sort(byIdCodepoint);

  const heartbeatIds = new Set(heartbeats.map((row) => row.id));
  const parentById = new Map<string, FinalizationRow>();
  // parent.id 가 서로 다른 heartbeat 의 parent 행에서 반복되면 last-wins lookup 은 두 번째 행만
  // 남겨 앞 heartbeat 를 지우므로, index 구축 중 그 id 를 모호(id ambiguity)로 기록해 둔다.
  const ambiguousParentIds = new Set<string>();
  const parentsByHeartbeatId = new Map<string, FinalizationRow[]>();
  for (const parent of finalizations) {
    if (parentById.has(parent.id)) ambiguousParentIds.add(parent.id);
    else parentById.set(parent.id, parent);
    const list = parentsByHeartbeatId.get(parent.heartbeatRunId);
    if (list) list.push(parent);
    else parentsByHeartbeatId.set(parent.heartbeatRunId, [parent]);
  }

  // stage 의 두 FK 는 독립적 — parent 링크가 수집된 heartbeat 와 다른 id 를 부르면 정합성 위반.
  const parentOfStage = (stage: FinalizationStepRow): FinalizationRow | undefined =>
    parentById.get(stage.heartbeatRunFinalizationId);
  const stageLinkConflicted = (stage: FinalizationStepRow): boolean => {
    const parent = parentOfStage(stage);
    // 모호한 parent id 는 last-wins 결과를 unambiguous authority 로 쓰지 않는다 — 링크 위반.
    return parent === undefined
      || ambiguousParentIds.has(stage.heartbeatRunFinalizationId)
      || parent.heartbeatRunId !== stage.heartbeatRunId;
  };

  // 행 단위 scope 방어(고아/회사 오염) — 수집된 heartbeat 밖 id 로 귀속된다.
  for (const parent of finalizations) {
    if (parent.companyId !== scope.companyId || !heartbeatIds.has(parent.heartbeatRunId)) {
      emit("scope_mismatch", parent.heartbeatRunId, "settlement_scope_mismatch");
    }
  }
  for (const stage of finalizationSteps) {
    const parent = parentOfStage(stage);
    const viaHeartbeat = heartbeatIds.has(stage.heartbeatRunId);
    const viaParent = parent !== undefined && heartbeatIds.has(parent.heartbeatRunId);
    if (
      stage.companyId !== scope.companyId
      || (!viaHeartbeat && !viaParent)
      || stageLinkConflicted(stage)
    ) {
      emit("scope_mismatch", stage.heartbeatRunId, "settlement_scope_mismatch");
    }
  }

  for (const heartbeat of heartbeats) {
    const parents = parentsByHeartbeatId.get(heartbeat.id) ?? [];
    const stages = finalizationSteps.filter((stage) =>
      stage.heartbeatRunId === heartbeat.id || parentOfStage(stage)?.heartbeatRunId === heartbeat.id);

    // 규칙 1 — heartbeat + 연관 parent/stage 전부의 회사/링크/중복 parent 정합성. parent id 가
    //   heartbeat 경계에서 모호하면(서로 다른 heartbeat 의 parent 가 같은 id) stages 유무와
    //   입력 순서 무관하게 여기서 먼저 거부한다 — 하위 규칙보다 우선.
    if (
      heartbeat.companyId !== scope.companyId
      || parents.length > 1
      || parents.some((parent) =>
        ambiguousParentIds.has(parent.id) || parent.companyId !== scope.companyId)
      || stages.some((stage) =>
        stage.companyId !== scope.companyId || stageLinkConflicted(stage))
    ) {
      emit("scope_mismatch", heartbeat.id, "settlement_scope_mismatch");
      continue;
    }

    // 규칙 2 — terminal status(미지 포함 비단말은 활성 작업).
    if (!TERMINAL_OUTCOMES.has(heartbeat.status)) {
      emit("active_work", heartbeat.id, "heartbeat_not_terminal");
      continue;
    }

    // 규칙 3 — 내구 정산+소유 해제+단말 결정 증명. processPid/exitCode/stdout/payload/임대만료로
    //   증명을 추정하지 않는다(비null processPid 는 이력값으로 그대로 허용).
    if (
      heartbeat.finalizationVersion !== 1
      || !isValidDate(heartbeat.settledAt)
      || !isValidDate(heartbeat.executorOwnerReleasedAt)
      || !isValidDate(heartbeat.terminalDecidedAt)
      || heartbeat.terminalOutcome === null
      || !TERMINAL_OUTCOMES.has(heartbeat.terminalOutcome)
      || heartbeat.terminalOutcome !== heartbeat.status
    ) {
      emit("active_work", heartbeat.id, "settlement_unproven");
      continue;
    }

    // 규칙 4 — 정확히 하나의 parent, v1, pending, 무임대, heartbeat identity 와 정확 결속.
    const parent = parents[0];
    if (
      parent === undefined
      || parent.finalizationVersion !== 1
      || !isSafeNonNegativeInteger(heartbeat.executionEpoch)
      || parent.executionEpoch !== heartbeat.executionEpoch
      || !isNonEmptyString(heartbeat.executionToken)
      || parent.executionToken !== heartbeat.executionToken
      || parent.terminalOutcome !== heartbeat.terminalOutcome
      || !isNonEmptyString(heartbeat.terminalDecisionSource)
      || parent.terminalDecisionSource !== heartbeat.terminalDecisionSource
      || parent.state !== PARENT_PENDING_STATE
      || parent.finalizerOwner !== null
      || parent.finalizerLeaseToken !== null
      || parent.finalizerLeaseExpiresAt !== null
    ) {
      emit("active_work", heartbeat.id, "finalization_identity_unproven");
      continue;
    }

    // 규칙 5 — 모든 연관 stage 검사 + required Q/C 충족(스코프 의존, 실제 분류기 사용).
    if (recordedStagesUnproven(heartbeat, stages)) {
      emit("active_work", heartbeat.id, "finalization_stages_unproven");
    }
  }

  return blockers.sort((a, b) =>
    compareStrings(a.heartbeatRunId, b.heartbeatRunId)
    || compareStrings(a.code, b.code)
    || compareStrings(a.reason, b.reason));
}
