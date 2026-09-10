import type { WorkflowStep } from "../dag-engine.js";

/**
 * frozen 전체를 forwardReachable 그래프로 투영한다. forward conditional edge 는 incoming(t→s),
 * backedge 는 엔진에서의 outgoing 루프(s→t)이므로 대상 노드 t 에 incoming {stepId: s} 로 건다 —
 * 루프가 그래프 사이클로 나타나 전역 Kahn 검사가 거부한다. 대상 없는 backedge 는 원시 stepId 를
 * 소유 노드에 남겨 unknown-edge 거부를 유도한다.
 */
export function buildGraphNodes(frozenSteps: WorkflowStep[]) {
  const nodes = frozenSteps.map((step) => ({
    id: step.id,
    dependencies: step.dependencies ?? [],
    conditionalDependencies: (step.conditionalDependencies ?? [])
      .filter((edge) => edge.isBackEdge !== true)
      .map((edge) => ({ stepId: edge.stepId })),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const step of frozenSteps) {
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge.isBackEdge !== true) continue;
      const target = nodeById.get(edge.stepId);
      if (target) target.conditionalDependencies.push({ stepId: step.id });
      else nodeById.get(step.id)!.conditionalDependencies.push({ stepId: edge.stepId });
    }
  }
  return nodes;
}

/** step.type 부재는 agent. if/complete=제어(reevaluate), agent/tool=실행(execute). */
export function kindOf(step: WorkflowStep): "agent" | "tool" | "control" | null {
  if (step.type === undefined || step.type === "agent") return "agent";
  if (step.type === "tool") return "tool";
  if (step.type === "if" || step.type === "complete") return "control";
  return null;
}
