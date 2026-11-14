// server/src/services/workflow/resume/review-relief.ts
//
// [파일 목적] resume review-relief v1 — 실패 런 재개 preview 의 보수 검토 차단(정책 매니페스트
//   미등록·선행 산출물 미검증·종말 스텝 owner 잔재)을 사람 승인 또는 #720 stuck 판정 성립 시
//   '경고 표시 후 진행'으로 낮춘다. 2026-11 실측: 최근 3일 실패 런 7건 전부가 매니페스트 미등록
//   외부효과 차단으로 eligible=false — 등록 레지스트리가 1건뿐인 이상 재개 경로가 사실상 전면
//   봉쇄된다(오탐 차단). 완화는 아래 계약 밖으로 나가지 않는다.
// [외부 연결] caller: preview.ts assembleResumePreview(apply 경로 재검증도 동일 함수라 자동
//   일관). 설정 원본: instance_settings.experimental(enableResumeReviewReliefV1 전역 또는
//   resumeReviewReliefAllowedMissionIdsV1 미션 단위). 사람 승인 판정은 #721
//   stale-source-wakeup-gate.ts 와 같은 구조화 필드만 본다.
// [불변(계약) — 위반 금지]
//   1) external effect 미확인 스텝(effect-unknown/control 미검증 차단)의 완화는 사람 승인
//      (human_approval basis)이 있을 때뿐이다. stuck 만으로는 완화하지 않는다.
//   2) 활성 실행은 완화하지 않는다: running 비-stuck 스텝, 참조 wakeup/heartbeat 비종말,
//      toolQueue, 타 런 비종말, 대기/진행 resume 실행·요청, delegation, 예산은 전부 유지.
//   3) 플래그 OFF(부재·불량 포함, fail-closed)면 분류 자체를 적용하지 않는다 — 기존 차단
//      목록과 동일하다.
//   4) 자연어 파싱 금지 — 판정은 구조화 필드(플래그 JSON, operator_decisions.status,
//      operator_decision_continuations.state/acceptedAt, 스텝/참조 상태)만 읽는다.
// [수정시 주의]
//   - classifyReviewRelief 는 순수 함수다(DB/시계/플래그 조회 없음). DB 조회는 이 파일의
//     read 계열 함수가 preview 트랜잭션 안에서 수행한다.
//   - 종말 상태 어휘는 preview-facts.ts export 를 쓴다(복제 금지 — 어휘가 갈라지면 잔재
//     판정이 어긋난다).
//   - relief 는 preview 차단 분류에만 개입한다. reset/디스패치/apply 실행 계약은 건드리지
//     않는다. 새 실행(재실행) 경로에 영향이 없다.

import { and, eq, inArray, gte } from "drizzle-orm";
import {
  instanceSettings,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
  type Db,
} from "@paperclipai/db";
import type { ResumeWorkspaceMissionHistory } from "./read-model-workspaces.js";
import type { ResumePreviewBlocker } from "./preview-facts.js";
import {
  TERMINAL_HEARTBEAT_STATUSES,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WAKEUP_STATUSES,
} from "./preview-facts.js";

const DEFAULT_SINGLETON_KEY = "default";

export type ResumeReliefBasisName = "human_approval" | "stuck";

export interface ReviewReliefClassifyInput {
  readonly blockers: readonly ResumePreviewBlocker[];
  readonly humanApproval: boolean;
  readonly stuck: boolean;
  readonly policyMissing: boolean;
  readonly history: ResumeWorkspaceMissionHistory;
}

export interface ReviewReliefClassifyResult {
  readonly hardBlockers: ResumePreviewBlocker[];
  readonly warnings: ResumePreviewBlocker[];
  readonly bases: ResumeReliefBasisName[];
}

/**
 * 인스턴스/미션 설정 게이트 — 기본 off(fail-closed). enableResumeReviewReliefV1(전역) 또는
 *   resumeReviewReliefAllowedMissionIdsV1(미션 단위 부분 롤아웃)이 켜져야 완화가 동작한다.
 *   설정 행 부재·불량 false.
 */
export async function isResumeReviewReliefEnabled(
  db: Pick<Db, "select">,
  missionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY));
  const settings = (Array.isArray(rows) ? rows[0] : undefined)?.experimental;
  if (settings?.enableResumeReviewReliefV1 === true) return true;
  const allowed = settings?.resumeReviewReliefAllowedMissionIdsV1;
  return Array.isArray(allowed) && allowed.includes(missionId);
}

/**
 * [사람 승인 = 구조화 복구 판정] 미션 소속 이슈에 붙은 사람 결정 카드가 resolve 되고
 *   continuation 이 accepted(웨이크 실제 전달)까지 간 기록만 인정한다(#721 과 동일 어휘).
 *   카드 본문·선택지 자연어는 읽지 않는다. since(실패 런 종료 시각) 이전 승인은 이 실패에
 *   대한 판단이 아니므로 인정하지 않는다.
 */
export async function hasAcceptedHumanApprovalForMission(
  db: Pick<Db, "select">,
  input: {
    readonly companyId: string;
    readonly missionId: string;
    readonly since: Date | null;
  },
): Promise<boolean> {
  const missionIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
    ))
    .limit(500);
  if (missionIssues.length === 0) return false;
  const [row] = await db
    .select({ id: operatorDecisions.id })
    .from(operatorDecisions)
    .innerJoin(
      operatorDecisionContinuations,
      eq(operatorDecisionContinuations.operatorDecisionId, operatorDecisions.id),
    )
    .where(and(
      eq(operatorDecisions.companyId, input.companyId),
      eq(operatorDecisions.status, "resolved"),
      inArray(operatorDecisions.issueId, missionIssues.map((issue) => issue.id)),
      eq(operatorDecisionContinuations.companyId, input.companyId),
      eq(operatorDecisionContinuations.state, "accepted"),
      ...(input.since ? [gte(operatorDecisionContinuations.acceptedAt, input.since)] : []),
    ))
    .limit(1);
  return Boolean(row);
}

/** 종말 스텝(failed/skipped)의 owner 참조가 전부 종말(또는 null)인 잔재인가 — 활성이면 false. */
function terminalStepOwnerResidue(history: ResumeWorkspaceMissionHistory, stepRunId: string): boolean {
  const step = history.missionSteps.find((row) => row.id === stepRunId);
  if (!step || !TERMINAL_STEP_STATUSES.has(step.status)) return false;
  const wakeupStatusById = new Map(history.history.wakeups.map((row) => [row.id, row.status]));
  const heartbeatStatusById = new Map(history.history.heartbeats.map((row) => [row.id, row.status]));
  const refsTerminal = (id: string | null, terminal: ReadonlySet<string>, statuses: Map<string, string>): boolean =>
    id === null || (statuses.has(id) && terminal.has(statuses.get(id)!));
  return refsTerminal(step.dispatchOwnerWakeupRequestId, TERMINAL_WAKEUP_STATUSES, wakeupStatusById)
    && refsTerminal(step.dispatchOwnerHeartbeatRunId, TERMINAL_HEARTBEAT_STATUSES, heartbeatStatusById);
}

/** 이슈 체크아웃/실행 참조가 전부 종말(또는 null)인 잔재인가 — 활성이면 false. */
function terminalIssueResidue(history: ResumeWorkspaceMissionHistory, issueId: string): boolean {
  const issue = history.history.issues.find((row) => row.id === issueId);
  if (!issue || issue.status !== "in_progress") return false;
  const heartbeatStatusById = new Map(history.history.heartbeats.map((row) => [row.id, row.status]));
  const refsTerminal = (id: string | null): boolean =>
    id === null || (heartbeatStatusById.has(id) && TERMINAL_HEARTBEAT_STATUSES.has(heartbeatStatusById.get(id)!));
  return refsTerminal(issue.checkoutRunId) && refsTerminal(issue.executionRunId);
}

/**
 * 차단 분류(순수) — 완화 기반이 성립한 경우만 오탐성 보수 차단을 경고로 내린다.
 *   - external_effect_unknown(전역, policyMissing): 경고(양 기반).
 *   - external_effect_unknown / control_tool_effects_unverified(스텝): 사람 승인일 때만 경고.
 *   - missing_evidence(선행 산출물 미검증): 경고(양 기반).
 *   - active_work(스텝 owner 잔재·이슈 잔재): 참조가 전부 종말인 잔재일 때만 경고(양 기반).
 *   - 그 외 전부 유지: 활성 실행·활성 자원·delegation·예산·실행된 스텝·완료되지 않은 선행·
 *     미션/런 상태 등(계약 2·정당 차단).
 */
export function classifyReviewRelief(input: ReviewReliefClassifyInput): ReviewReliefClassifyResult {
  const bases: ResumeReliefBasisName[] = [];
  if (input.humanApproval) bases.push("human_approval");
  if (input.stuck) bases.push("stuck");
  if (bases.length === 0) {
    return { hardBlockers: [...input.blockers], warnings: [], bases: [] };
  }
  const hardBlockers: ResumePreviewBlocker[] = [];
  const warnings: ResumePreviewBlocker[] = [];
  for (const blocker of input.blockers) {
    const stepRunId = typeof blocker.detail?.stepRunId === "string" ? blocker.detail.stepRunId : undefined;
    const stepId = typeof blocker.detail?.stepId === "string" ? blocker.detail.stepId : undefined;
    const issueId = typeof blocker.detail?.issueId === "string" ? blocker.detail.issueId : undefined;
    let relieved = false;
    if (blocker.code === "external_effect_unknown" && stepId === undefined && stepRunId === undefined) {
      // 전역 매니페스트 미등록(policyMissing)차단 — 스텝을 특정하지 않는 전역 보수 게이트.
      relieved = input.policyMissing;
    } else if (blocker.code === "external_effect_unknown" || blocker.code === "control_tool_effects_unverified") {
      relieved = input.humanApproval; // 계약 1 — external 효과 미확인은 사람 승인일 때만.
    } else if (blocker.code === "missing_evidence") {
      relieved = true;
    } else if (blocker.code === "active_work") {
      const targetStepRunId = stepRunId ?? historyStepRunIdFor(input.history, stepId);
      relieved = (targetStepRunId !== undefined && terminalStepOwnerResidue(input.history, targetStepRunId))
        || (issueId !== undefined && terminalIssueResidue(input.history, issueId));
    }
    if (relieved) warnings.push(blocker);
    else hardBlockers.push(blocker);
  }
  return { hardBlockers, warnings, bases };
}

function historyStepRunIdFor(
  history: ResumeWorkspaceMissionHistory,
  stepId: string | undefined,
): string | undefined {
  if (stepId === undefined) return undefined;
  return history.missionSteps.find((row) => row.stepId === stepId)?.id;
}
