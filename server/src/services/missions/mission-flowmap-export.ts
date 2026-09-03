// server/src/services/missions/mission-flowmap-export.ts
//
// [파일 목적] 미션 워크플로우 run → repo-flowmap 규격 JSON(단일 진실원) → 고정 렌더러 단일 HTML 변환.
//   (repo-flowmap 스킬 흡수 안 A — 미션 실행흐름을 file:// 에서도 동작하는 대화형 흐름도로 내보낸다.)
// [주요 흐름] buildMissionRunFlowmap(레벨 계산→layers/nodes/flows 매핑, IF/back-edge 는 cond 상태로)
//   → validateFlowmap(self-check) → renderFlowmapHtml(template.html 의 /* FLOWMAP_JSON */ 1회 인라인).
// [고정 계약] 렌더러(server/src/flowmap-assets/template.html)는 수정하지 않는다. "<" 는 \u003c escape.
//   node/edge 매핑은 데이터로 표현한다. edge state 는 cond(양쪽 다 정상 경로)만 사용 — failover/blocked 아님.
// [외부 연결] consumer: missions.ts(buildMissionRunFlowmapHtml), routes/missions.ts(다운로드 라우트).
// [수정시 주의] validator 통과 없이는 렌더하지 않는다(렌더러가 잘못된 edge 를 조용히 drop 한다).
import { readFileSync } from "node:fs";
import { validateFlowmap } from "./flowmap-validator.js";

const FLOWMAP_JSON_MARKER = "/* FLOWMAP_JSON */";

// ---------------------------------------------------------------------------
// 입력 타입 — MissionWorkflowRunDetail 의 구조적 부분집합(테스트/서비스 양쪽에서 조립 가능)
// ---------------------------------------------------------------------------

export interface MissionFlowmapConditionalDependency {
  stepId: string;
  when?: string;
  isBackEdge?: boolean;
  maxIterations?: number;
}

export interface MissionFlowmapStepInput {
  stepId: string;
  name: string;
  type: "agent" | "tool";
  agentId: string;
  dependencies: string[];
  conditionalDependencies?: MissionFlowmapConditionalDependency[];
  status: string;
  issue: { identifier: string | null } | null;
  toolNames: string[];
}

export interface MissionFlowmapRunInput {
  id: string;
  workflowName: string | null;
  status: string;
  progress: { totalSteps: number; completedSteps: number };
  steps: MissionFlowmapStepInput[];
}

// ---------------------------------------------------------------------------
// flowmap 문서 타입(repo-flowmap SCHEMA.md)
// ---------------------------------------------------------------------------

export interface FlowmapLayer {
  id: string;
  label: string;
  color?: string;
}

export interface FlowmapNode {
  id: string;
  label: string;
  desc?: string;
  layer: string;
  file?: string;
}

export interface FlowmapStep {
  from: string;
  to: string;
  call?: string;
  data?: string;
  note?: string;
  state?: "failover" | "blocked" | "cond";
  stateLabel?: string;
}

export interface FlowmapFlow {
  id: string;
  group?: string;
  title: string;
  summary?: string;
  status?: "stale";
  stale_reason?: string;
  steps: FlowmapStep[];
}

export interface FlowmapDocument {
  meta: {
    project: string;
    title?: string;
    subtitle?: string;
    last_analyzed_commit: string;
    basis?: string;
    note?: string;
  };
  layers: FlowmapLayer[];
  nodes: FlowmapNode[];
  flows: FlowmapFlow[];
}

// ---------------------------------------------------------------------------
// 빌더
// ---------------------------------------------------------------------------

/** flowmap node/flow id 는 [A-Za-z0-9_-] 슬러그만 안전하게 쓴다(원본 stepId 는 node.file 에 보존). */
function slugifyFlowmapId(value: string): string {
  const slug = value.trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return slug || "node";
}

function forwardConditionalDependencies(step: MissionFlowmapStepInput): MissionFlowmapConditionalDependency[] {
  return (step.conditionalDependencies ?? []).filter((edge) => edge.isBackEdge !== true);
}

function backEdgeDependencies(step: MissionFlowmapStepInput): MissionFlowmapConditionalDependency[] {
  return (step.conditionalDependencies ?? []).filter((edge) => edge.isBackEdge === true);
}

/** 의존 깊이(레벨) 계산 — forward edge(legacy + 조건부)만 포함, back-edge 는 제외. UI computeStepLevels 와 동일 규칙. */
function computeStepLevels(steps: MissionFlowmapStepInput[]): Map<string, number> {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    if (levels.has(id)) return levels.get(id)!;
    const step = byId.get(id);
    if (!step) {
      levels.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      levels.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const knownDeps = Array.from(
      new Set([...step.dependencies, ...forwardConditionalDependencies(step).map((edge) => edge.stepId)]),
    ).filter((depId) => byId.has(depId));
    const level = knownDeps.length === 0 ? 0 : Math.max(...knownDeps.map((depId) => resolve(depId))) + 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  steps.forEach((step) => resolve(step.stepId));
  return levels;
}

/** 조건부 edge → repo-flowmap step 표현. 양쪽 다 정상 경로이므로 state:"cond" + 12자 이하 라벨. */
function conditionalEdgeAnnotations(
  edge: MissionFlowmapConditionalDependency,
): { state: "cond"; stateLabel: string; note: string } | null {
  switch (edge.when) {
    case "condition_true":
      return { state: "cond", stateLabel: "TRUE", note: "Fires when the IF control node condition matches" };
    case "condition_false":
      return { state: "cond", stateLabel: "FALSE", note: "Fires when the IF condition does not match" };
    case "failure":
      return { state: "cond", stateLabel: "ON FAIL", note: "Fires when the upstream step fails or is skipped" };
    case "always":
      return { state: "cond", stateLabel: "ALWAYS", note: "Fires on any terminal state of the upstream step" };
    case "qa_request_changes": {
      const cap = edge.maxIterations != null ? String(edge.maxIterations) : "?";
      return {
        state: "cond",
        stateLabel: `REWORK×${cap}`.slice(0, 12),
        note: `QA requested changes — bounded rework loop (max ${cap})`,
      };
    }
    default:
      // when:"success"/undefined 는 legacy dependencies 와 동일 의미 → 일반 edge.
      return null;
  }
}

function stepDescription(step: MissionFlowmapStepInput): string {
  const parts: string[] = [step.status];
  if (step.issue?.identifier) parts.push(step.issue.identifier);
  if (step.type === "tool" && step.toolNames.length > 0) parts.push(`tool: ${step.toolNames.join(", ")}`);
  return parts.join(" · ");
}

/**
 * [목적] 미션 run → flowmap 문서. 각 step=node(레이어=의존 레벨), 각 edge=flow step.
 * [출력] validateFlowmap 를 통과하는 문서. 검증 실패 시 throw(부분 문서 반환 금지).
 */
export function buildMissionRunFlowmap(
  run: MissionFlowmapRunInput,
  options: { missionId: string },
): FlowmapDocument {
  const levels = computeStepLevels(run.steps);
  const maxLevel = run.steps.reduce((max, step) => Math.max(max, levels.get(step.stepId) ?? 0), 0);

  const layers: FlowmapLayer[] = Array.from({ length: maxLevel + 1 }, (_, level) => ({
    id: `l${level}`,
    label: `Stage ${level + 1}`,
  }));

  // 표시 순서: 레벨 오름차순, 같은 레벨은 정의 순서.
  const orderedSteps = [...run.steps].sort((left, right) => {
    const levelDelta = (levels.get(left.stepId) ?? 0) - (levels.get(right.stepId) ?? 0);
    return levelDelta || run.steps.indexOf(left) - run.steps.indexOf(right);
  });

  const nodeIdByStepId = new Map<string, string>();
  const usedNodeIds = new Set<string>();
  const nodes: FlowmapNode[] = orderedSteps.map((step) => {
    let nodeId = slugifyFlowmapId(step.stepId);
    if (usedNodeIds.has(nodeId)) {
      let suffix = 2;
      while (usedNodeIds.has(`${nodeId}-${suffix}`)) suffix += 1;
      nodeId = `${nodeId}-${suffix}`;
    }
    usedNodeIds.add(nodeId);
    nodeIdByStepId.set(step.stepId, nodeId);
    return {
      id: nodeId,
      label: step.name,
      desc: stepDescription(step),
      layer: `l${levels.get(step.stepId) ?? 0}`,
      file: step.stepId,
    };
  });

  const flowSteps: FlowmapStep[] = [];
  const pushEdge = (dependencyId: string, step: MissionFlowmapStepInput, annotations: ReturnType<typeof conditionalEdgeAnnotations>) => {
    const from = nodeIdByStepId.get(dependencyId);
    const to = nodeIdByStepId.get(step.stepId);
    if (!from || !to) return;
    flowSteps.push(annotations ? { from, to, state: annotations.state, stateLabel: annotations.stateLabel, note: annotations.note } : { from, to });
  };
  // forward edge: 일반 의존 → 조건부 forward. back-edge(rework loop)는 마지막에 모아서.
  for (const step of orderedSteps) {
    for (const dependencyId of step.dependencies) {
      pushEdge(dependencyId, step, null);
    }
    for (const edge of forwardConditionalDependencies(step)) {
      pushEdge(edge.stepId, step, conditionalEdgeAnnotations(edge));
    }
  }
  for (const step of orderedSteps) {
    for (const edge of backEdgeDependencies(step)) {
      pushEdge(edge.stepId, step, conditionalEdgeAnnotations(edge));
    }
  }

  const flowmap: FlowmapDocument = {
    meta: {
      project: "papercompany",
      title: run.workflowName ?? "Workflow run",
      subtitle: `mission execution flow · run ${run.id.slice(0, 8)}`,
      last_analyzed_commit: "runtime-export",
      basis: `mission ${options.missionId} · workflow run ${run.id}`,
      note: "Generated by the Papercompany mission flowmap export (repo-flowmap fixed renderer).",
    },
    layers,
    nodes,
    flows: [
      {
        id: `run-${slugifyFlowmapId(run.id)}`,
        title: run.workflowName ?? "Workflow run",
        summary: `${run.status} · ${run.progress.completedSteps}/${run.progress.totalSteps} steps completed`,
        steps: flowSteps,
      },
    ],
  };

  const errors = validateFlowmap(flowmap);
  if (errors.length > 0) {
    throw new Error(`mission flowmap schema 오류:\n- ${errors.join("\n- ")}`);
  }
  return flowmap;
}

// ---------------------------------------------------------------------------
// 렌더러 결합
// ---------------------------------------------------------------------------

/**
 * [목적] flowmap 문서를 고정 렌더러 템플릿에 인라인해 단일 HTML 로 만든다.
 * [계약] 템플릿의 /* FLOWMAP_JSON *\/ 마커는 정확히 1개. JSON 의 "<" 는 \u003c 로 escape(file:// 안전).
 * [출력] self-contained HTML. 검증 실패/마커 이상 시 throw.
 */
export function renderFlowmapHtml(flowmap: FlowmapDocument, templateSource: string): string {
  const errors = validateFlowmap(flowmap);
  if (errors.length > 0) {
    throw new Error(`flowmap schema 오류:\n- ${errors.join("\n- ")}`);
  }
  const markerCount = templateSource.split(FLOWMAP_JSON_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`template.html에 ${FLOWMAP_JSON_MARKER} 마커가 정확히 1개 있어야 합니다 (found ${markerCount})`);
  }
  const json = JSON.stringify(flowmap, null, 2).replaceAll("<", "\\u003c");
  return templateSource.replace(FLOWMAP_JSON_MARKER, json);
}

let cachedTemplate: string | null = null;

/** vendor 된 고정 렌더러 템플릿(server/src/flowmap-assets/template.html)을 읽는다(모듈 캐시 1회). */
export function readVendoredFlowmapTemplate(): string {
  if (cachedTemplate === null) {
    cachedTemplate = readFileSync(
      new URL("../../flowmap-assets/template.html", import.meta.url),
      "utf8",
    );
  }
  return cachedTemplate;
}
