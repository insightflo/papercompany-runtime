/**
 * [파일 목적] canonical ResumeNode 그래프에 대한 순수 forward reachability.
 *   전체 그래프(연결 해제된 컴포넌트 포함)를 검증한 뒤 start 에서 도달 가능한 노드 id 를
 *   결정적(사전순)으로 반환한다. DB/시계/엔진 의존 없음, 입력 변형 없음.
 * [주요 흐름]
 *   1. 검증 — 빈 그래프 / 중복 id / 미상 start / 미상 edge 대상(ordinary·conditional 모두) /
 *      자기 간선 / 전역 사이클(전체 그래프 Kahn) → Error('unsupported_graph').
 *      duplicate edge(같은 from→to 가 ordinary+conditional 에 걸쳐 중복)는 오류가 아니라
 *      indegree/Kahn 전에 중복 제거한다(노드 중복과는 무관). 중복 제거는 전역 연결 문자열 키가
 *      아니라 per-parent Set<string>(from 별 to 집합)으로 별도화한다 — NUL 등 임의 문자를 포함한
 *      id 에서도 서로 다른 간선이 절대 충돌하지 않는다.
 *   2. predecessor→child 맵 구축.
 *   3. start 부터 index cursor BFS(재귀 금지) → 방문 집합을 사전순 정렬해 반환(start 포함).
 *      조건 분기는 edge 조건과 무관하게 양쪽 모두 포함한다.
 * [수정시 주의]
 *   - 오류 메시지는 'unsupported_graph' 로 고정 — id/입력 텍스트 유출 금지.
 *   - malformed edge target 을 조용히 버리지 않는다(반드시 reject).
 *   - 입력 nodes / dependencies / conditionalDependencies 를 절대 변형하지 않는다.
 *   - 엔진 import·정규화 금지(입력은 이미 canonical).
 */

import type { ResumeNode } from "./types.js";

export function forwardReachable(nodes: ResumeNode[], startId: string): string[] {
  if (nodes.length === 0) throw new Error("unsupported_graph");

  const ids = new Set<string>();
  for (const n of nodes) {
    if (typeof n.id !== "string" || n.id === "" || ids.has(n.id)) {
      throw new Error("unsupported_graph");
    }
    ids.add(n.id);
  }
  if (!ids.has(startId)) throw new Error("unsupported_graph");

  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of ids) {
    children.set(id, []);
    indegree.set(id, 0);
  }

  // Collision-free per-parent edge identity: key by the exact `from` string,
  // track exact `to` strings in a Set. Never concatenate from+to into one key —
  // `${from}\u0000${to}` conflates distinct edges when ids contain NUL
  // (e.g. a→"b\0c" vs "a\0b"→c).
  const seen = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) throw new Error("unsupported_graph");
    let targets = seen.get(from);
    if (!targets) {
      targets = new Set<string>();
      seen.set(from, targets);
    }
    if (targets.has(to)) return; // duplicate edge — dedup before indegree/Kahn
    targets.add(to);
    children.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  };

  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!ids.has(dep)) throw new Error("unsupported_graph");
      addEdge(dep, n.id);
    }
    for (const cond of n.conditionalDependencies) {
      if (!ids.has(cond.stepId)) throw new Error("unsupported_graph");
      addEdge(cond.stepId, n.id);
    }
  }

  // Kahn over the ENTIRE graph — any cycle anywhere (including disconnected
  // components) rejects. Iterative with index cursor, no recursion.
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  let processed = 0;
  for (let i = 0; i < queue.length; i++) {
    processed += 1;
    for (const child of children.get(queue[i])!) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (processed !== ids.size) throw new Error("unsupported_graph");

  // BFS from start with an index cursor (not recursion). Both conditional
  // branches follow unconditionally — edge conditions are not evaluated here.
  const visited = new Set<string>([startId]);
  const frontier = [startId];
  for (let i = 0; i < frontier.length; i++) {
    for (const child of children.get(frontier[i])!) {
      if (!visited.has(child)) {
        visited.add(child);
        frontier.push(child);
      }
    }
  }
  return Array.from(visited).sort();
}
