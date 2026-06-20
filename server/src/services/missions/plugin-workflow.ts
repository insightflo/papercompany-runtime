// server/src/services/missions/plugin-workflow.ts
//
// [파일 목적] plugin(insightflo.workflow-engine)이 제공한 workflow 데이터를 native 표현으로
//   정규화하는 통합 레이어. plugin step/run/definition 데이터 타입 + 정규화 + execution unit 정리.
//   missions.ts mega-file 회피를 위해 분리.
// [주요 흐름] toPluginWorkflowStepData(검증) → normalizePluginWorkflowStepStatus(plugin status→native).
//   pruneStaleWorkflowExecutionUnits(타 run의 execution unit 제거).
// [외부 연결] consumer: missions.ts. deps: workflow-progress(MissionWorkflowRunStep) + utils.
// [수정시 주의] plugin status 종류 변경 시 normalizePluginWorkflowStepStatus 분기 동기화.
import { asRecordArray, asTrimmedString, isRecord } from "./utils.js";
import { normalizeMissionWorkflowStepStatus, type MissionWorkflowRunStep } from "./workflow-progress.js";

export type PluginWorkflowStepData = Record<string, unknown>;
export type PluginWorkflowDefinitionData = {
  name?: unknown;
  steps?: unknown;
};
export type PluginWorkflowRunData = {
  workflowId?: unknown;
  workflowName?: unknown;
  companyId?: unknown;
  missionId?: unknown;
  status?: unknown;
  triggerSource?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};
export type PluginWorkflowStepRunData = {
  runId?: unknown;
  stepId?: unknown;
  issueId?: unknown;
  agentName?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

function isNativeWorkflowExecutionUnitForDifferentRun(
  unit: Record<string, unknown>,
  workflowName: string,
  sourceRunId: string,
): boolean {
  const sourceRef = isRecord(unit.sourceRef) ? unit.sourceRef : {};
  const type = asTrimmedString(sourceRef.type);
  if (type === "native_workflow_step_run") {
    const workflowRunId = asTrimmedString(sourceRef.workflowRunId);
    return Boolean(workflowRunId && workflowRunId !== sourceRunId);
  }
  if (type === "native_workflow_run") {
    const id = asTrimmedString(sourceRef.id);
    const title = asTrimmedString(unit.title);
    return Boolean(id && id !== sourceRunId && title === workflowName);
  }
  return false;
}

export function pruneStaleWorkflowExecutionUnits(
  refs: Record<string, unknown>,
  workflowName: string,
  sourceRunId?: string,
): Record<string, unknown> {
  if (!sourceRunId) return refs;
  const executionUnits = asRecordArray(refs.executionUnits);
  if (executionUnits.length === 0) return refs;
  return {
    ...refs,
    executionUnits: executionUnits.filter((unit) => !isNativeWorkflowExecutionUnitForDifferentRun(unit, workflowName, sourceRunId)),
  };
}

export function normalizePluginWorkflowStepStatus(status: unknown): MissionWorkflowRunStep["status"] {
  const normalized = asTrimmedString(status);
  switch (normalized) {
    case "done":
      return "completed";
    case "in_progress":
      return "running";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "running":
    case "completed":
    case "pending":
      return normalizeMissionWorkflowStepStatus(normalized);
    default:
      return "pending";
  }
}

export function toPluginWorkflowStepData(value: unknown): PluginWorkflowStepData | null {
  if (!isRecord(value)) return null;
  const id = asTrimmedString(value.id);
  if (!id) return null;
  return value;
}
