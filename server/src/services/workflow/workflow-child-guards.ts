// server/src/services/workflow/workflow-child-guards.ts
//
// [purpose] workflow→workflow 자식 실행의 정적 guard 모듈(0101).
//   스텝 판별, CYCLE DFS(정의 그래프; 자기참조 거부, diamond 허용), DEPTH 보행,
//   strict 토큰 검출 정규식. 모든 판정은 구조화 레코드만 읽는다(규칙 7/8).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";

/** 자식 run 체인 깊이 상한(부모=1, 자식=2, …). 초과 시 child_depth_exceeded. */
export const WORKFLOW_CHILD_MAX_DEPTH = 3;
/** 부모 run 당 동시 waiting 자식 상한. 초과 시 child_concurrency_exceeded. */
export const WORKFLOW_CHILD_MAX_CONCURRENT_WAITING = 5;
/** reconciler 가 waiting 스텝을 검사하기 전 최소 나이. */
export const WORKFLOW_CHILD_RECONCILE_MIN_AGE_MS = 5 * 60_000;

/** 마지막 남은 {$...} 토큰 검출 — strict fail-closed 렌더 검증용. */
export const ANY_UNRESOLVED_TOKEN_RE = /\{\$[^{}]*\}/u;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type NormalizedWorkflowStep = WorkflowStep & {
  targetWorkflowId?: unknown;
  wait?: unknown;
  inputs?: unknown;
};

export function isWorkflowChildStep(step: WorkflowStep): boolean {
  const stepType = typeof (step as NormalizedWorkflowStep).type === "string"
    ? ((step as NormalizedWorkflowStep).type as string).trim().toLowerCase()
    : "";
  return stepType === "workflow";
}

export type CycleSteps = Array<{ id?: unknown; type?: unknown; targetWorkflowId?: unknown }>;

function workflowChildTargetIds(steps: CycleSteps): string[] {
  const targets: string[] = [];
  for (const step of steps) {
    if (typeof step.type !== "string" || step.type.trim().toLowerCase() !== "workflow") continue;
    if (typeof step.targetWorkflowId !== "string" || !UUID_RE.test(step.targetWorkflowId.trim())) continue;
    targets.push(step.targetWorkflowId.trim());
  }
  return targets;
}

/**
 * 정의 그래프 CYCLE DFS — 부모 정의가 자신의 workflow-step 타깃 체인으로 다시 도달하면
 * cycle(자기참조 포함). diamond(여러 경로가 같은 타깃 수렴)은 허용한다(visited set).
 * 오류 문장 배열을 반환; 빈 배열이면 통과.
 */
export function assertNoWorkflowChildDefinitionCycles(
  definitionId: string,
  steps: CycleSteps,
  stepsByDefinitionId: Map<string, CycleSteps>,
): string[] {
  const errors: string[] = [];
  const targets = workflowChildTargetIds(steps);
  if (targets.includes(definitionId)) {
    errors.push(`workflow step target cycle detected: definition ${definitionId} targets itself`);
  }
  const visited = new Set<string>([definitionId]);
  const stack: string[] = [...targets];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === definitionId) {
      errors.push(`workflow step target cycle detected: ${definitionId} is reachable from its own workflow steps`);
      break;
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const currentSteps = stepsByDefinitionId.get(current) ?? [];
    stack.push(...workflowChildTargetIds(currentSteps));
  }
  return Array.from(new Set(errors));
}

/**
 * DB 기반 CYCLE 검증 — 정의 생성/수정 시 사용. updatingDefinitionId 의 스텝은 인자 steps 로 대체한다.
 * 위반 시 Error throw(engine 의 기존 validateDag 와 동일한 실패 계약).
 */
export async function assertWorkflowChildDefinitionCycles(
  db: Db,
  companyId: string,
  updatingDefinitionId: string | null,
  steps: CycleSteps,
): Promise<void> {
  const graph = await loadCompanyWorkflowStepGraph(db, companyId);
  const effectiveId = updatingDefinitionId ?? "__new_definition__";
  if (updatingDefinitionId) graph.set(updatingDefinitionId, steps);
  const errors = assertNoWorkflowChildDefinitionCycles(effectiveId, steps, graph);
  if (errors.length > 0) {
    throw new Error(`Invalid workflow DAG: ${errors.join(", ")}`);
  }
}

export async function loadCompanyWorkflowStepGraph(
  db: Db,
  companyId: string,
): Promise<Map<string, CycleSteps>> {
  const rows = await db
    .select({ id: workflowDefinitions.id, stepsJson: workflowDefinitions.stepsJson })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.companyId, companyId));
  const graph = new Map<string, CycleSteps>();
  for (const row of rows) {
    graph.set(row.id, Array.isArray(row.stepsJson) ? row.stepsJson as CycleSteps : []);
  }
  return graph;
}

export async function runDepthOfParentRun(db: Db, run: {
  parentRunId: string | null;
  rootRunId: string | null;
  /** 예상 회사 — 조상 보행 중 회사 불일치가 보이면 fail-closed(깊이 초과 취급). */
  companyId?: string;
}): Promise<number> {
  // depth = root_run_id 체인 길이. parent_run_id 를 따라 최대 WORKFLOW_CHILD_MAX_DEPTH+2 홉만 보행.
  // 회사 불일치 조상(cross-company ancestry, 데이터 변조/버그)은 깊이 초과로 fail-closed 한다.
  if (!run.parentRunId) return 1;
  let depth = 1;
  let cursor: string | null = run.parentRunId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor) && depth <= WORKFLOW_CHILD_MAX_DEPTH + 2) {
    seen.add(cursor);
    const [parent] = await db
      .select({ parentRunId: workflowRuns.parentRunId, companyId: workflowRuns.companyId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, cursor))
      .limit(1);
    if (!parent) break;
    if (run.companyId && parent.companyId !== run.companyId) {
      return WORKFLOW_CHILD_MAX_DEPTH + 1;
    }
    depth += 1;
    cursor = parent.parentRunId ?? null;
  }
  return depth;
}
