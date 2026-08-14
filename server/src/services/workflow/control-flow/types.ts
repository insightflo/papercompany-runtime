/**
 * [파일 목적] 워크플로 제어 흐름(IF 조건부 edge + bounded back-edge loop)의 데이터 모델.
 *   엔진은 기본적으로 forward-only static DAG. 이 모듈은 (a) 선행 step 결과에 따라 활성화되는
 *   조건부 edge(IF)와 (b) QA 반려 → rework → 재QA 의 bounded loop(back-edge)를 표현하는
 *   edge annotation 타입과 직렬화 보조(normalize)만 제공한다.
 *   엔진 *로직*(활성화 게이트 평가, cycle 허용, loop 재발화, step 리셋)은 같은 control-flow/
 *   아래 다른 모듈(edge-condition/cycle-validator/loop-driver/step-reset)이 담당 — 한 파일에
 *   몰아넣지 않는다(supervision.ts 1100줄 분해 사례 회피).
 * [외부 연결] consumer: dag-engine.ts(WorkflowStep.conditionalDependencies), workflows editor(P-edit),
 *   planning(mission-owner-plan-decisions, rework back-edge 자동 합성).
 * [수정시 주의] legacy `dependencies: string[]` 는 `when:"success"` semantics 를 유지(전역 동작 불변).
 *   back-edge 는 반드시 maxIterations(>=1) 를 동반 — 무한 loop = 가즈아 25h hang 회귀(MEMORY.md).
 */

/** 조건부 edge 발화 조건. 선행 step 의 종료 상태에 대한 한정. */
export type ConditionalEdgeWhen =
  | "success" // 선행 completed (legacy dependencies[] 와 동일)
  | "failure" // 선행 failed|skipped (IF on failure)
  | "qa_request_changes" // 선행이 QA gate 이고 verdict=request_changes (loop 발화용)
  | "always" // 선행 any terminal
  | "condition_true" // 선행이 IF control node 이고 outcome=condition_true (forward 분기)
  | "condition_false"; // 선행이 IF control node 이고 outcome=condition_false (forward 분기)

const CONDITIONAL_EDGE_WHEN_VALUES: readonly ConditionalEdgeWhen[] = ["success", "failure", "qa_request_changes", "always", "condition_true", "condition_false"];

/**
 * [목적] 풍부한 edge: 대상 step + 발화 조건(when) + loop annotation.
 * [입력] stepId(선행 step id), when(기본 success), isBackEdge(ancestor 로의 back-edge=loop),
 *        maxIterations(back-edge 전용 hard cap).
 * [주의] isBackEdge:true 인 edge 는 반드시 maxIterations>=1 동반. 없으면 normalize 가 drop.
 *        cycle-validator 는 annotated back-edge 만 cycle 로 허용, 우연한 cycle 은 거부.
 */
export interface ConditionalEdge {
  stepId: string;
  when?: ConditionalEdgeWhen;
  isBackEdge?: boolean;
  maxIterations?: number;
  /**
   * [qa-cap acceptance opt-in] 이 back-edge 한정의 opt-in(default false). true 일 때만,
   *   cap(maxIterations) 도달 시 공식 workflow verdict API 로 명시적 nonblocking classification +
   *   bounded nonempty limitations 가 제출된 current fresh semantic QA 반려를 completed 로 수용(CAS)한다.
   *   재시도/producer reset/추가 LLM 없음. retry cap 은 hard token boundary 로 그대로 유지.
   */
  allowCapAcceptance?: boolean;
}

/**
 * [목적] step_run.metadata.attempts[] 한 원소 — loop 매 iteration 의 verdict/결함 아카이브.
 *   issue 리셋에도 결함 이력이 잃지 않게 step_run.metadata 에 persist 한다(verdict 는 원래
 *   매 sync 재계산이라 issue 리셋에 날아감). 다음 iteration 가 "뭘 고쳐야 할지" 보게 한다.
 */
export interface StepIterationAttempt {
  iteration: number;
  verdict?: "pass" | "request_changes" | null;
  failureReasons?: string[];
  completedAt: string | null;
}

/** attempts[] 가 step_run.metadata 에 저장될 때 쓰는 키. */
export const STEP_ITERATION_ATTEMPTS_KEY = "controlFlowAttempts";

/**
 * [operator cap boost] operator 가 화면에서 부여하는 일시 추가 QA rework 한도.
 *   step_run.metadata.qaReworkCapBoost 로 저장. 이번 stepRun 세대의 cap 판정에만 더해진다.
 *   workflow 정의의 maxIterations 는 바꾸지 않는다(일시 조정 — 정의 불변).
 */
export interface QaReworkCapBoost {
  /** 추가 허용 rework 횟수 (>=1). */
  amount: number;
  /** 부여 주체/사유 (감사 추적용). */
  reason?: string;
  /** 부여 시각 ISO. */
  grantedAt?: string;
}

/** step_run.metadata 에 boost 를 저장할 때 쓰는 키. */
export const QA_REWORK_CAP_BOOST_KEY = "qaReworkCapBoost";

/**
 * [목적] step_run.metadata 에서 operator cap boost 를 안전하게 읽는다.
 *   스키마 검증 실패/음수/비정수면 0(부여 없음)으로 수렴 — cap 판정을 느슨하게 만들지 않는다.
 */
export function readCapBoostAmount(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const raw = (metadata as Record<string, unknown>)[QA_REWORK_CAP_BOOST_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  const amount = (raw as Record<string, unknown>).amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) return 0;
  return amount;
}

/**
 * [목적] UI/plugin payload 의 conditionalDependencies 를 정규화(normalizeWorkflowStepsForExecution
 *   round-trip). 잘못된 edge 는 drop 하되, back-edge 는 maxIterations 동반을 강제(무한 loop 방지).
 * [입력] raw(unknown). [출력] 유효 edge 배열, 또는 없으면 undefined(필드 생략).
 */
export function normalizeConditionalEdges(raw: unknown): ConditionalEdge[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const edges: ConditionalEdge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const stepId = typeof value.stepId === "string" ? value.stepId.trim() : "";
    if (!stepId) continue;
    const rawWhen = typeof value.when === "string" ? value.when : "";
    const when: ConditionalEdgeWhen | undefined = (CONDITIONAL_EDGE_WHEN_VALUES as readonly string[]).includes(rawWhen)
      ? (rawWhen as ConditionalEdgeWhen)
      : undefined;
    const isBackEdge = value.isBackEdge === true || value.isBackEdge === "true";
    const maxIterationsRaw = value.maxIterations;
    const maxIterations = typeof maxIterationsRaw === "number" && Number.isFinite(maxIterationsRaw) && maxIterationsRaw >= 1
      ? Math.floor(maxIterationsRaw)
      : undefined;
    // back-edge 는 maxIterations 동반 필수. 없으면 무한 loop 위험이라 drop.
    if (isBackEdge && !maxIterations) continue;
    // allowCapAcceptance 는 back-edge 한정의 opt-in boolean. non-back-edge 에선 의미 없으니 무시.
    const allowCapAcceptance = isBackEdge && value.allowCapAcceptance === true;
    edges.push({
      stepId,
      ...(when ? { when } : {}),
      ...(isBackEdge ? { isBackEdge: true, maxIterations: maxIterations!, ...(allowCapAcceptance ? { allowCapAcceptance: true } : {}) } : {}),
    });
  }
  return edges.length > 0 ? edges : undefined;
}
