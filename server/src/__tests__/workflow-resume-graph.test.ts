import { describe, expect, it } from "vitest";
import { forwardReachable } from "../services/workflow/resume/graph.js";
import type { ResumeNode } from "../services/workflow/resume/types.js";

/**
 * [purpose] Task5b 순수 forward reachability 계약 테스트 — canonical ResumeNode 그래프
 *   검증(빈 그래프/중복 id/미상 start/미상 edge 대상/자기 간선/전역 사이클), 간선 중복 제거,
 *   배열 순서 무관성, 조건 분기 양쪽 포함, 결정적 사전순 출력, 입력 불변, 비재귀 순회.
 */

function node(id: string, deps: string[] = [], condDeps: string[] = []): ResumeNode {
  return {
    id,
    dependencies: [...deps],
    conditionalDependencies: condDeps.map((stepId) => ({ stepId })),
  };
}

function idsOf(result: string[]): string {
  return result.join(",");
}

/** 런타임 한정 deep-freeze — unsafe cast 없이 원래 ResumeNode 타입을 유지한다. */
function deepFreezeNode(n: ResumeNode): ResumeNode {
  Object.freeze(n.dependencies);
  for (const cond of n.conditionalDependencies) Object.freeze(cond);
  Object.freeze(n.conditionalDependencies);
  return Object.freeze(n);
}

describe("forwardReachable — reachability", () => {
  it("returns seven lexically sorted nodes reachable from clips-gate", () => {
    const nodes = [
      node("audit-log"),
      node("clips-gate"),
      node("publish", ["clips-gate"]),
      node("assemble", ["clips-gate"]),
      node("render-a", ["assemble"]),
      node("render-b", ["assemble"]),
      node("plan", ["render-a", "render-b"]),
      node("if-router", [], ["plan"]),
    ];
    expect(idsOf(forwardReachable(nodes, "clips-gate"))).toBe(
      "assemble,clips-gate,if-router,plan,publish,render-a,render-b",
    );
  });

  it("includes both conditional-only branches regardless of edge conditions", () => {
    const nodes = [
      node("router"),
      node("on-true", [], ["router"]),
      node("on-false", [], ["router"]),
    ];
    expect(idsOf(forwardReachable(nodes, "router"))).toBe("on-false,on-true,router");
  });

  it("deduplicates mixed duplicate ordinary+conditional edges before indegree", () => {
    const nodes = [node("a"), node("c", ["a"], ["a"])];
    expect(idsOf(forwardReachable(nodes, "a"))).toBe("a,c");
  });

  it("does not conflate distinct edges when ids contain NUL characters", () => {
    // from="a" to="b\0c" 와 from="a\0b" to="c" 는 연결 키로 합치면 충돌한다 —
    // 별개 간선이므로 둘 다 살아 있어야 한다(parent reviewed reproduction).
    const nodes = [
      node("a"),
      node("b\0c", ["a"]),
      node("a\0b"),
      node("c", ["a\0b"]),
    ];
    expect(idsOf(forwardReachable(nodes, "a\0b"))).toBe("a\0b,c");
  });

  it("visits each transitive diamond join exactly once", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
    expect(idsOf(forwardReachable(nodes, "a"))).toBe("a,b,c,d");
  });

  it("excludes unrelated nodes outside the reachable subgraph", () => {
    const nodes = [
      node("start"),
      node("next", ["start"]),
      node("other-root"),
      node("skipped-other", [], ["other-root"]),
    ];
    expect(idsOf(forwardReachable(nodes, "start"))).toBe("next,start");
  });

  it("is independent of node array order", () => {
    const ordered = [
      node("clips-gate"),
      node("assemble", ["clips-gate"]),
      node("render-a", ["assemble"]),
      node("render-b", ["assemble"]),
    ];
    const shuffled = [ordered[3], ordered[0], ordered[2], ordered[1]];
    expect(idsOf(forwardReachable(shuffled, "clips-gate"))).toBe(
      idsOf(forwardReachable(ordered, "clips-gate")),
    );
  });

  it("handles long chains iteratively without recursion", () => {
    const depth = 20_000;
    const pad = (i: number) => `n-${String(i).padStart(5, "0")}`;
    const nodes: ResumeNode[] = [];
    for (let i = 0; i < depth; i++) {
      nodes.push(node(pad(i), i === 0 ? [] : [pad(i - 1)]));
    }
    const result = forwardReachable(nodes, "n-00000");
    expect(result).toHaveLength(depth);
    expect(result[0]).toBe("n-00000");
    expect(result).toContain(pad(depth - 1));
  });

  it("does not mutate the input nodes", () => {
    const nodes = [node("a"), node("b", ["a"], ["a"])];
    const before = JSON.stringify(nodes);
    forwardReachable(nodes, "a");
    expect(JSON.stringify(nodes)).toBe(before);
  });

  it("traverses the Task5b runtime plan fixture from clips-gate", () => {
    // flow-clips -> clips-gate -> assemble + clips-blocked;
    // assemble -> assemble-gate + assemble-blocked;
    // assemble-gate -> final-review -> publish; unrelated plan-blocked/complete-blocked.
    const nodes = [
      node("flow-clips"),
      node("clips-gate", ["flow-clips"]),
      node("assemble", ["clips-gate"]),
      node("clips-blocked", ["clips-gate"]),
      node("assemble-blocked", ["assemble"]),
      node("assemble-gate", ["assemble"]),
      node("final-review", ["assemble-gate"]),
      node("publish", ["final-review"]),
      node("plan-blocked"),
      node("complete-blocked"),
    ];
    expect(idsOf(forwardReachable(nodes, "clips-gate"))).toBe(
      "assemble,assemble-blocked,assemble-gate,clips-blocked,clips-gate,final-review,publish",
    );
  });

  it("runs on a deeply frozen graph without mutating it", () => {
    // Object.freeze 이므로 어떤 입력 변형이든 TypeError 로 즉시 실패한다.
    const nodes: ResumeNode[] = [
      deepFreezeNode(node("a")),
      deepFreezeNode(node("b", ["a"], ["a"])),
      deepFreezeNode(node("c", ["b"])),
    ];
    Object.freeze(nodes);
    expect(Object.isFrozen(nodes)).toBe(true);
    expect(Object.isFrozen(nodes[0])).toBe(true);
    expect(Object.isFrozen(nodes[0].dependencies)).toBe(true);
    expect(Object.isFrozen(nodes[1].conditionalDependencies)).toBe(true);
    expect(Object.isFrozen(nodes[1].conditionalDependencies[0])).toBe(true);
    expect(idsOf(forwardReachable(nodes, "a"))).toBe("a,b,c");
  });
});

describe("forwardReachable — rejects unsupported graphs", () => {
  const validPair = [node("a"), node("b", ["a"])];

  function expectUnsupported(nodes: ResumeNode[], startId: string): void {
    expect(() => forwardReachable(nodes, startId)).toThrowError(new Error("unsupported_graph"));
  }

  it("rejects an empty graph", () => expectUnsupported([], "a"));
  it("rejects a missing start", () => expectUnsupported(validPair, "ghost"));
  it("rejects duplicate node ids", () => expectUnsupported([node("a"), node("a")], "a"));
  it("rejects a missing ordinary dependency target", () =>
    expectUnsupported([node("a", ["ghost"])], "a"));
  it("rejects a missing conditional dependency target", () =>
    expectUnsupported([node("a", [], ["ghost"])], "a"));
  it("rejects a self-edge", () => expectUnsupported([node("a", ["a"])], "a"));
  it("rejects an empty node id", () => expectUnsupported([node("a"), node("")], "a"));
  it("rejects an empty dependency target", () => expectUnsupported([node("a", [""])], "a"));
  it("rejects a cycle reachable from start", () =>
    expectUnsupported([node("a"), node("b", ["a", "c"]), node("c", ["b"])], "a"));
  it("rejects a cycle in a disconnected component", () =>
    expectUnsupported([...validPair, node("x", ["y"]), node("y", ["x"])], "a"));
  it("keeps duplicate edges legal (dedup, not rejection)", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"], ["a"])];
    expect(idsOf(forwardReachable(nodes, "a"))).toBe("a,b,c");
  });
});
