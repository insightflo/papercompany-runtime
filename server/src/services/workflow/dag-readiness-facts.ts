import type { workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import type { PersistedWorkflowStep } from "./execution-steps.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { deriveIfControlOutcome } from "./dag-step-observation.js";
import { classifyStepActivation, deriveMechanicalQaRejection, resolveFailureRecoveryChannel, type PredFacts, type PredStatus } from "./control-flow/edge-condition.js";
import { isControlNodeGraceWaitBlockingDispatch } from "./control-flow/gate-work-product-grace.js";
import { isRetryDelayBlockingDispatch } from "./retry-launch-dispatch.js";

export type ValidationVerdict = "pass" | "request_changes";

export interface ValidationVerdictObservation {
  verdict: ValidationVerdict | null;
  observedAt: Date | null;
}

export function isValidationGateCandidate(input: {
  issueTitle?: string | null;
  issueOriginKind?: string | null;
  step?: WorkflowStep | null;
}): boolean {
  if (
    input.issueOriginKind === "mission_main_executor_plan" ||
    input.issueOriginKind === "mission_main_executor_oversight" ||
    input.issueOriginKind === "mission_main_executor_unblock"
  ) {
    return false;
  }

  if (input.step) return isQaLikeStep(input.step);
  return isQaLikeStep({ title: input.issueTitle });
}

/**
 * [목적] edge-condition 평가용 선행(pred) facts 맵 구성 — dag-engine adapter.
 *   stepRunMap(실행 상태) + step 정의 → {status, isQaGate, verdict}. 순수 edge-condition 모듈이
 *   DB/stepRun 타입을 모르게 한다(역참조/결합 회피).
 * [주의] verdict 는 P2 에선 null(P4 가 validation verdict 를 step_run.metadata 에 persist 한 뒤 공급).
 *   isQaGate 는 isValidationGateCandidate({step}) 로 step-only 추정 — qa_request_changes 평가용이며,
 *   P2 핵심 IF(success/failure/always) 평가엔 관여하지 않는다.
 * [수정시 영향] findRunnableSteps + skip-propagation pass 가 동일한 맵을 소비한다.
 */
export function buildPredFactsMap(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation>,
  v1EnforcementEnabled?: boolean,
  issueStatusByIssueId?: Map<string, string>,
): Map<string, PredFacts> {
  const facts = new Map<string, PredFacts>();
  for (const step of steps) {
    const run = stepRunMap.get(step.id);
    // P4: live validation verdict 로 qa_request_changes edge 를 정밀 평가(generic failure/infra 에러 loop 방지).
    //   맵 미제공 시 null → edge-condition 의 P2 fallback(QA gate && status:failed) 으로 떨어진다.
    const liveVerdict = run?.issueId
      ? validationVerdictsByIssueId?.get(run.issueId)?.verdict ?? null
      : null;
    // [mechanical QA rejection — 2026-10-17] 이슈 없는 기계 QA tool step 의 콘텐츠 반려(화이트리스트 실패
    //   서명)는 verdict="request_changes" 를 도출해 기존 qa_request_changes 백엔지·재작업 계약·cap 과
    //   Agent QA 판정과 같은 모양으로 흐른다(kenfold 780dada3 — 반려가 재작업 없이 종결되던 gap).
    //   infra 서명은 도출하지 않는다: verdict null + verdictChecked 유지 → P4 가드(재작업 미발화) 불변.
    const verdict = liveVerdict
      ?? (run && deriveMechanicalQaRejection({ step, run }) ? "request_changes" as const : null);
    facts.set(step.id, {
      status: (run?.status ?? "pending") as PredStatus,
      isQaGate: isValidationGateCandidate({ step }),
      verdict,
      // validationVerdictsByIssueId 맵이 제공됐으면(P4) verdictChecked=true. 맵에 이 이슈가 없으면
      // liveVerdict=null 이고 edge-condition 은 이를 "조사했으나 판정 없음(infra 실패)"으로 해석한다.
      verdictChecked: validationVerdictsByIssueId !== undefined,
      // IF control node outcome: 오직 completed 된 IF step 의 검증된 controlNodeResult 에서만 유도.
      // agent/tool/잘못된 metadata/누락 시 undefined → condition_true/false edge 양쪽 모두 비활성(fail-closed).
      ...deriveIfControlOutcome(step, run),
      // Phase 3 enforcement: when v1EnforcementEnabled, set dispatchReady from
      // the step-run's dispatch_ready_at (evidence + settlement). When disabled,
      // omit (undefined → treated as true → legacy behavior).
      ...(v1EnforcementEnabled ? { dispatchReady: run?.dispatchReadyAt != null } : {}),
      // [B2 좁은 회복 채널] failed 선행에만 — 연결 실행 이슈의 비종결 여부를 사실망에 최소 전달한다.
      //   v1 대기 규칙이 failed 선행을 대기로 분류하는 것은 이 채널이 열려 있을 때뿐이다(이슈 없는
      //   엔진 측 실패/종결 이슈 실패는 기존 하드 실패 분류). 미공급 맵은 fail-closed 로 open 취급.
      ...(v1EnforcementEnabled && run?.status === "failed"
        ? {
          failureRecoveryChannel: resolveFailureRecoveryChannel({
            issueId: run.issueId,
            issueStatus: run.issueId ? issueStatusByIssueId?.get(run.issueId) : undefined,
          }),
        }
        : {}),
    });
  }
  return facts;
}


export function findRunnableSteps(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  options: {
    launchedStepIds?: Set<string>;
    validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation>;
    v1EnforcementEnabled?: boolean;
    issueStatusByIssueId?: Map<string, string>;
  } = {},
): WorkflowStep[] {
  // [IF/loop] edge-aware 활성화 게이트. classifyStepActivation 은 legacy dependencies[] 에 대해
  // 기존 `dependencies.every(completed)` 와 byte-identical 이므로 legacy 회귀가 없고, conditional edge 가
  // 있는 step 만 when 평가(failure/always 발화 또는 waiting)로 분기된다.
  const predsByStepId = buildPredFactsMap(steps, stepRunMap, options.validationVerdictsByIssueId, options.v1EnforcementEnabled, options.issueStatusByIssueId);
  return steps.filter((step) => {
    if (options.launchedStepIds && !options.launchedStepIds.has(step.id)) return false;
    if (step.triggerOn === "escalation") return false;
    const stepRun = stepRunMap.get(step.id);
    if (!stepRun || stepRun.status !== "pending") return false;
    // A selector may point through a completed intermediary instead of a direct dependency.
    // Keep the consumer pending while that exact producer is being reworked.
    const selectorStepIds = Object.keys((step as PersistedWorkflowStep).workProductSelectors ?? {});
    if (selectorStepIds.some((stepId) => stepRunMap.get(stepId)?.status !== "completed")) return false;
    if (stepRun.issueId == null && step.type === "if"
      && isControlNodeGraceWaitBlockingDispatch(stepRun.metadata, new Date())) return false;
    if (isRetryDelayBlockingDispatch(stepRun.metadata, new Date())) return false;
    return classifyStepActivation(step, predsByStepId).runnable;
  });
}
