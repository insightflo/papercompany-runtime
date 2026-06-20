/**
 * [파일 목적] workflow DAG cycle 검출을 control-flow 로 분리(P3). annotated back-edge(isBackEdge + maxIterations≥1)
 *   로 닫히는 cycle(bounded loop)은 허용하고, 그 외 cycle(우연/잘못된)은 거부한다.
 *   P4 loop-driver 가 back-edge 를 재발화시킬 수 있게 구조적 cycle 금지를 relax 하는 것이 목적이다.
 * [주요 흐름] hasDisallowedCycle(steps) — forward 방향 DFS(WHITE/GRAY/BLACK). cycle 을 닫는 closing edge 가
 *   허용된 back-edge 면 통과, 일반 edge 면 거부.
 * [외부 연결] consumer: dag-engine.ts validateDag(기존 detectCycle 대체).
 * [수정시 주의]
 *   - **forward 방향이 핵심.** depends-on(역방향) DFS 에선 isBackEdge 가 descending edge 에 붙어서 closing-edge
 *     검사와 어노테이션이 어긋난다(producer↔qa 사례에서 역방향은 일반 edge 가 cycle 을 닫는 것으로 보임).
 *     forward(Y→X, X 가 edge.stepId=Y 에 의존)에서는 closing edge 가 곧 isBackEdge 이다.
 *   - 허용 조건: isBackEdge===true && maxIterations≥1. normalizeConditionalEdges 가 back-edge 에 maxIterations
 *     동반을 보증하지만, 방어적으로 여기서도 검사한다(빠지면 거부 → 무한 loop 회귀 방지, 가즈아 25h hang 금지).
 *   - orphan(edge.stepId 가 steps 에 없음)은 validateDag 의 orphan 검사가 담당; 여기선 forward edge 생성 시 skip.
 */
import { resolveEdges, type EdgeBearingStep } from "./edge-condition.js";
import type { ConditionalEdge } from "./types.js";

/** 허용된 annotated back-edge 인지. normalize 보증 + 방어적 maxIterations≥1 검사. */
function isAllowedBackEdge(edge: ConditionalEdge): boolean {
  return edge.isBackEdge === true
    && typeof edge.maxIterations === "number"
    && edge.maxIterations >= 1;
}

/**
 * [목적] 허용되지 않은 cycle(우연한 cycle)이 하나라도 있으면 true. annotated back-edge 로 닫히는 cycle 은 허용(false).
 * [입력] steps(EdgeBearingStep; dag-engine WorkflowStep 구조적 호환).
 * [알고리즘] forward 방향 coloring DFS.
 *   1. forward adjacency 구성: 각 step X 의 수입 edge{stepId:Y}(resolveEdges)에 대해 forward edge Y→X 를 만들고
 *      그 edge 의 isAllowedBackEdge 여부를 옮긴다(legacy dependencies[] 는 when:"success" 로 환산, back-edge 아님).
 *   2. DFS 중 target 이 GRAY(현재 경로 상 조상)이면 cycle. 그때 closing edge 가 backEdge 면 continue(허용),
 *      아니면 true(거부) 반환.
 *   3. target WHITE 면 재귀, BLACK 이면 skip.
 */
export function hasDisallowedCycle(steps: ReadonlyArray<EdgeBearingStep>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const stepIds = new Set(steps.map((step) => step.id));
  const forward = new Map<string, Array<{ to: string; backEdge: boolean }>>();
  for (const step of steps) forward.set(step.id, []);
  for (const target of steps) {
    for (const edge of resolveEdges(target)) {
      const from = edge.stepId;
      if (!stepIds.has(from)) continue; // orphan(from 미확인) — validateDag orphan 검사에 위임
      forward.get(from)!.push({ to: target.id, backEdge: isAllowedBackEdge(edge) });
    }
  }

  const color = new Map<string, number>();
  for (const step of steps) color.set(step.id, WHITE);

  function dfs(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const { to, backEdge } of forward.get(nodeId) ?? []) {
      const nodeColor = color.get(to);
      if (nodeColor === GRAY) {
        if (backEdge) continue; // annotated back-edge 가 닫는 cycle → 허용(bounded loop)
        return true; // 일반 edge 가 닫는 cycle → 거부(우연한 cycle)
      }
      if (nodeColor === WHITE) {
        if (dfs(to)) return true;
      }
      // BLACK: 이미 완료 → skip
    }
    color.set(nodeId, BLACK);
    return false;
  }

  for (const step of steps) {
    if (color.get(step.id) === WHITE) {
      if (dfs(step.id)) return true;
    }
  }
  return false;
}
