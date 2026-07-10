/**
 * [파일 목적] workflow DAG cycle 검출을 control-flow 로 분리(P3). annotated back-edge(isBackEdge + maxIterations≥1)
 *   로 닫히는 cycle(bounded loop)은 허용하고, 그 외 cycle(우연/잘못된)은 거부한다.
 *   P4 loop-driver 가 back-edge 를 재발화시킬 수 있게 구조적 cycle 금지를 relax 하는 것이 목적이다.
 * [주요 흐름] hasDisallowedCycle(steps) — 유효한 bounded back-edge 를 제외한 forward graph 에서
 *   DFS(WHITE/GRAY/BLACK) cycle 이 남는지 검사한다.
 * [외부 연결] consumer: dag-engine.ts validateDag(기존 detectCycle 대체).
 * [수정시 주의]
 *   - **forward 방향이 핵심.** 각 target 의 선행 stepId 에서 target 으로 edge 를 구성한다.
 *   - 허용 조건: isBackEdge===true && maxIterations≥1. normalizeConditionalEdges 가 back-edge 에 maxIterations
 *     동반을 보증하지만, 방어적으로 여기서도 검사한다(빠지면 거부 → 무한 loop 회귀 방지, 가즈아 25h hang 금지).
 *   - 유효 back-edge 를 graph 에서 제거해야 DFS 시작점/step 배열 순서와 무관하게 같은 결과가 나온다.
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
 * [알고리즘] 유효한 bounded back-edge 를 제외하고 forward adjacency 를 만든 뒤 coloring DFS 를 수행한다.
 *   남은 graph 에 cycle 이 있으면 일반/잘못된 edge 로도 순환하므로 거부한다.
 */
export function hasDisallowedCycle(steps: ReadonlyArray<EdgeBearingStep>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const stepIds = new Set(steps.map((step) => step.id));
  const forward = new Map<string, string[]>();
  for (const step of steps) forward.set(step.id, []);
  for (const target of steps) {
    for (const edge of resolveEdges(target)) {
      const from = edge.stepId;
      if (!stepIds.has(from)) continue; // orphan(from 미확인) — validateDag orphan 검사에 위임
      if (isAllowedBackEdge(edge)) continue;
      forward.get(from)!.push(target.id);
    }
  }

  const color = new Map<string, number>();
  for (const step of steps) color.set(step.id, WHITE);

  function dfs(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const to of forward.get(nodeId) ?? []) {
      const nodeColor = color.get(to);
      if (nodeColor === GRAY) {
        return true;
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
