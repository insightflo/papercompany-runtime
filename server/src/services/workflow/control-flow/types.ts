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
  | "always"; // 선행 any terminal

const CONDITIONAL_EDGE_WHEN_VALUES: readonly ConditionalEdgeWhen[] = ["success", "failure", "qa_request_changes", "always"];

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
    edges.push({
      stepId,
      ...(when ? { when } : {}),
      ...(isBackEdge ? { isBackEdge: true, maxIterations: maxIterations! } : {}),
    });
  }
  return edges.length > 0 ? edges : undefined;
}
