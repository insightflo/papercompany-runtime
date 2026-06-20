/**
 * [파일 목적] 워크플로 IF(조건부 edge) 활성화 평가 — 순수 함수만 제공(DB/Date/부작용 없음).
 *   엔진은 기본적으로 forward-only static DAG 이고 step 은 "모든 legacy dependency 가 completed" 일 때
 *   활성화된다. 이 모듈은 선행 step 의 *종료 상태*에 따라 대상 step 의 활성화 상태를 3가지로 판정한다:
 *     - runnable  : 이번 sync 에 발화해야 한다(선행이 조건을 만족).
 *     - skippable : false-branch — 더 이상 발화할 수 없으니 skipped 로 마감해야 한다.
 *     - waiting   : 선행 중 아직 terminal 아닌 것이 있어 판정 보류(건드리지 않는다).
 * [주요 흐름]
 *   1. resolveEdges(step) — legacy dependencies[] 를 when:"success" edge 로 환산, conditionalDependencies 와 합친다.
 *   2. classifyStepActivation(step, preds) — §활성화 규칙 적용 → {runnable, skippable, waiting}.
 *   3. findSkippableSteps(...) — dag-engine 의 skip-propagation pass 가 호출하는 batch selector.
 * [외부 연결] consumer: dag-engine.ts(findRunnableSteps 게이트 + syncWorkflowRunState 의 skip-pass).
 *   순수/역참조 없음 — types.ts 만 의존. dag-engine.ts 의 WorkflowStep 은 구조적 호환(EdgeBearingStep)으로 받는다.
 * [수정시 주의]
 *   - legacy `dependencies: string[]` 는 when:"success" 로 환산하며, conditionalDependencies 가 없는 step
 *     에 대해선 기존 동작(dependencies.every(completed))과 byte-identical 이어야 한다 — 45개 legacy 테스트 회귀 금지.
 *   - skip 은 오직 conditionalDependencies 를 가진 step 에만 적용(legacy-only step 은 기존처럼 pending 대기 = 회복 가능).
 *   - 가즈아 25h hang 회귀 금지: skip 은 단조(pending→skipped terminal)하며, resetUnlaunchedTerminalStepRuns 는
 *     dag-engine 측에서 metadata.controlFlowSkipped sentinel 로 우회한다. 이 모듈 자체는 부작용이 없다.
 *   - qa_request_changes 평가는 P4(verdict persist + step-reset)를 대비해 pred.verdict 를 인자로 받되,
 *     P2 에선 verdict 미지속이므로 "QA gate && status:failed" 로 평가한다(오늘날 엔진이 request_changes→failed 마킹).
 *     P4 에서 verdict 를 넘기기만 하면 이 함수 시그니처 변경 없이 정확해진다.
 */

import type { ConditionalEdge, ConditionalEdgeWhen } from "./types.js";

/** 대상 step 이 의존하는 선행 step 의 실행 상태(엔진 stepRun.status 와 정렬). */
export type PredStatus = "completed" | "failed" | "skipped" | "pending" | "running";

/** terminal 상태 — 이 상태여야만 edge 의 when 을 결정적으로 평가할 수 있다. */
const TERMINAL_PRED_STATUSES: ReadonlySet<PredStatus> = new Set(["completed", "failed", "skipped"]);

/**
 * 선행 step 1개에 대한 평가 입력. 호출자(dag-engine adapter)가 stepRunMap/issue/verdict 로부터 조립한다.
 * - status: 선행 stepRun.status.
 * - isQaGate: isValidationGateCandidate(step) 결과(qa_request_changes 평가용).
 * - verdict: P4 에서만 공급. P2 에선 null → status 기반 fallback.
 */
export interface PredFacts {
  status: PredStatus;
  isQaGate: boolean;
  verdict: "pass" | "request_changes" | null;
}

/**
 * edge-condition 이 필요로 하는 step 의 최소 구조. dag-engine 의 WorkflowStep 이 구조적 호환된다.
 * 역참조(circular import) 없이 이 모듈을 순수하게 유지하기 위해 최소 필드만 선언한다.
 */
export interface EdgeBearingStep {
  id: string;
  dependencies?: string[];
  conditionalDependencies?: ConditionalEdge[];
}

/** step 의 모든 수입 edge: legacy dependencies[](→ when:"success") ∪ conditionalDependencies. */
export function resolveEdges(step: EdgeBearingStep): ConditionalEdge[] {
  const edges: ConditionalEdge[] = [];
  const legacy = Array.isArray(step.dependencies) ? step.dependencies : [];
  for (const stepId of legacy) {
    if (typeof stepId === "string" && stepId.length > 0) {
      edges.push({ stepId, when: "success" });
    }
  }
  const conditional = Array.isArray(step.conditionalDependencies) ? step.conditionalDependencies : [];
  for (const edge of conditional) {
    if (edge && typeof edge.stepId === "string" && edge.stepId.length > 0) {
      edges.push(edge);
    }
  }
  return edges;
}

/** 워크플로 전체에 conditionalDependencies 를 가진 step 이 하나라도 있는지 — P2 신규 동작의 게이트. */
export function workflowHasConditionalEdges(steps: ReadonlyArray<EdgeBearingStep>): boolean {
  return steps.some(
    (step) => Array.isArray(step.conditionalDependencies) && step.conditionalDependencies.length > 0,
  );
}

/**
 * [목적] 단일 edge 의 when 이 (terminal) 선행 facts 에 대해 성립하는지.
 * [주의] 선행이 terminal 임은 호출자(classifyStepActivation/conditionalEdgeHolds)가 보증한다. 여기선 방어적으로 non-terminal 이면 false.
 */
function edgeHolds(when: ConditionalEdgeWhen | undefined, pred: PredFacts): boolean {
  if (!TERMINAL_PRED_STATUSES.has(pred.status)) return false;
  switch (when ?? "success") {
    case "success":
      return pred.status === "completed";
    case "failure":
      // failure = 선행이 failed 또는 skipped. skipped 가 failure 에 흡수되는 것이 skip cascade 를 종식시킨다.
      return pred.status === "failed" || pred.status === "skipped";
    case "always":
      // always = 순수 joiner. 이 edge 자체는 선행 terminal 이면 성립(legacy "completed 필수" 와 달리 실패/스킵도 허용).
      // 단, 같은 step 에 sibling success edge 가 있고 그 선행이 terminal-but-not-completed 이면
      // classifyStepActivation 의 hardRequiredFailed 가 전체 runnable 을 거부한다(최소놀람: success 게이트가 우선).
      return true;
    case "qa_request_changes":
      // P4: pred.verdict==="request_changes". P2: verdict 미지속 → QA gate && status:failed 로 평가.
      if (pred.verdict != null) return pred.verdict === "request_changes";
      return pred.isQaGate && pred.status === "failed";
    default:
      return false;
  }
}

/**
 * [목적] 단일 conditional edge(back-edge 포함) 의 when 이 (terminal) 선행 facts 에 대해 성립하는지 —
 *   edgeHolds 의 public 래퍼. loop-driver 가 back-edge 발화 여부를 classifyStepActivation 과 무관하게 직접
 *   판정하기 위해 사용한다(P5: classifyStepActivation 은 back-edge 를 forward-gate 에서 제외하도록 수정됨).
 * [주의] pred 가 undefined 거나 non-terminal 이면 false(방어적).
 */
export function conditionalEdgeHolds(edge: ConditionalEdge, pred: PredFacts | undefined): boolean {
  return pred ? edgeHolds(edge.when, pred) : false;
}

export interface StepActivation {
  runnable: boolean;
  skippable: boolean;
  waiting: boolean;
}

/**
 * [목적] 대상 step 의 활성화 상태를 판정. 호출자는 step 이 현재 "pending + issueId==null"(아직 발화 전) 임을
 *   별도로 보장한다 — 이 함수는 순수하게 edge 수학만 다룬다.
 * [입력] step, predsByStepId(모든 선행 stepId → PredFacts; 없으면 비-terminal 로 취급).
 * [출력] { runnable, skippable, waiting }.
 * [활성화 규칙]
 *   - edges 가 없는 entry step → runnable(legacy 동작: dependencies.every([]) === true 와 동일).
 *   - 그 외: 모든 수입 edge 의 선행이 terminal 이어야 결정 가능. 하나라도 비-terminal 이면 waiting.
 *   - satisfied    = ∃ edge whose when holds.
 *   - hardRequiredFailed = ∃ SUCCESS edge whose pred terminal-but-NOT-completed.
 *     (legacy success 게이트가 꺼지면 rescue 용 failure/always edge 로 우회하지 않는다 — 최소놀람 원칙.
 *      즉 sibling success edge 의 실패가 always/failure rescue 보다 우선한다.)
 *   - runnable   = !waiting && satisfied && !hardRequiredFailed.
 *   - skippable  = !waiting && !runnable  (모든 선행이 terminal 이되 만족 edge 없음 = 도달 불가/unreachable).
 * [skip 정책과 legacy 보존] 이 함수는 순수 "도달 불가" 여부만 반환한다. 실제 skip 적용은 dag-engine 의
 *   skip-propagation pass(workflowHasConditionalEdges 게이트)가 결정한다:
 *     (a) 순수 legacy 워크플로 → pass 가 no-op → legacy step 은 pending 대기(회복 가능)로 보존.
 *     (b) conditional 이 하나라도 있는 워크플로 → 도달 불가 step(legacy 포함)을 skip 해 finalize 가 terminal 에
 *         수렴(가즈아 60min reconciler kill 회피). 단, skip 된 step 은 sentinel 로 sticky 해져 회복되지 않는다 →
 *         QA requeue 등 회복은 P4 step-reset( sentinel clear )에서 처리.
 */
export function classifyStepActivation(
  step: EdgeBearingStep,
  predsByStepId: ReadonlyMap<string, PredFacts>,
): StepActivation {
  // [P5] back-edge 는 forward 활성화 게이트가 아니다 — 오직 loop-driver 가 resolveEdges 를 직접 읊어 발화한다.
  //   back-edge 를 forward 게이트에 포함하면 root producer 가 back-edge 선행(QA, 시작 전 pending) 을 기다려
  //   producer→QA deadlock(dead-on-arrival) 이 된다. forward 평가에서 제외한다.
  const edges = resolveEdges(step).filter((edge) => edge.isBackEdge !== true);
  if (edges.length === 0) {
    return { runnable: true, skippable: false, waiting: false };
  }

  let waiting = false;
  let satisfied = false;
  let hardRequiredFailed = false;
  for (const edge of edges) {
    const pred = predsByStepId.get(edge.stepId);
    if (!pred || !TERMINAL_PRED_STATUSES.has(pred.status)) {
      // 선행이 아직 terminal 아님 — 이 step 은 지금 결정할 수 없다.
      waiting = true;
      continue;
    }
    if (edgeHolds(edge.when, pred)) {
      satisfied = true;
    } else if ((edge.when ?? "success") === "success") {
      // success edge 가 terminal 이되 completed 가 아니면 hard-required 실패.
      hardRequiredFailed = true;
    }
  }

  if (waiting) {
    return { runnable: false, skippable: false, waiting: true };
  }

  const runnable = satisfied && !hardRequiredFailed;
  // skippable = 도달 불가(all preds terminal && !runnable). 적용 주체는 dag-engine skip-pass(workflow-gated).
  const skippable = !runnable;
  return { runnable, skippable, waiting: false };
}

/**
 * [목적] skip-propagation 이 한 번에 마감할 step 들을 고른다.
 * [입력] steps, predsByStepId, options.
 *   - launchedStepIds: dynamic-owner-plad 모드에서 발화 대상 제한(dag-engine 이 전달).
 *   - isStepEligible: dag-engine 이 "현재 pending + issueId==null + 아직 terminal 아님" 조건을 주입하는 훅.
 *     순수 모듈이 stepRun/DB 를 모르게 하기 위한 것이다.
 * [출력] activation.skippable && eligible 인 step 들.
 */
export function findSkippableSteps<T extends EdgeBearingStep>(
  steps: ReadonlyArray<T>,
  predsByStepId: ReadonlyMap<string, PredFacts>,
  options: {
    launchedStepIds?: Set<string>;
    isStepEligible?: (step: T) => boolean;
  } = {},
): T[] {
  return steps.filter((step) => {
    if (options.launchedStepIds && !options.launchedStepIds.has(step.id)) return false;
    if (options.isStepEligible && !options.isStepEligible(step)) return false;
    return classifyStepActivation(step, predsByStepId).skippable;
  });
}
