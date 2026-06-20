// server/src/services/missions/supervision-helpers.ts
//
// [파일 목적] mission owner supervision(감독/회복) 전용 순수 helper. db/deps 무, 파라미터 기반.
//   missions.ts 클로저 분해(P1)로 이동. runMainExecutorSupervision이 호출.
// [외부 연결] consumer: missions.ts(supervision). deps: shared-types/mission-execution-sources/mission-supervision-context/utils.
// [수정시 주의] 여기엔 db/deps/상태 접근 금지. 순수 함수만.
import { asStringArray } from "./utils.js";
import { isUuidLike } from "@paperclipai/shared";
import type { IssueRow, JsonRecord } from "./shared-types.js";
import type { MissionExecutionUnit } from "./mission-execution-sources.js";
import type { MissionSupervisionPlanArtifact, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";

export function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

export function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizedPlanStatus(value: unknown): string {
  return trimmedString(value)?.toLowerCase() ?? "";
}

export function executionUnitKeyFromSourceRef(sourceRef: unknown): string | null {
  const ref = asRecord(sourceRef);
  const type = trimmedString(ref.type);
  const id = trimmedString(ref.id);
  return type && id ? `${type}:${id}` : null;
}

export function executionUnitKey(unit: Pick<MissionExecutionUnit, "sourceRef">): string {
  return `${unit.sourceRef.type}:${unit.sourceRef.id}`;
}

export function textContainsAny(value: unknown, needles: string[]): boolean {
  const text = JSON.stringify(value ?? "").toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

export function unitRequiresGovernedAction(unit: JsonRecord): boolean {
  return textContainsAny(unit, ["external", "cost", "legal", "destructive", "delete", "spend", "payment", "production"]);
}

export function isApprovalRuleMode(mode: unknown): boolean {
  const normalized = normalizedPlanStatus(mode);
  return normalized === "approval_gate" || normalized === "hard_gate";
}

export function hasDiagnosisSignal(...bodies: string[]): boolean {
  const body = bodies.join("\n").toLowerCase();
  return body.includes("diagnos")
    || body.includes("root cause")
    || body.includes("replan")
    || body.includes("re-plan")
    || body.includes("recover")
    || body.includes("escalat")
    || body.includes("impossible")
    || body.includes("failure:")
    || body.includes("failed_unit_without_diagnosis");
}

export function jsonArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function sourceRefMatchesIssue(sourceRef: unknown, issue: Pick<IssueRow, "id">): boolean {
  const ref = asRecord(sourceRef);
  const type = trimmedString(ref.type);
  const id = trimmedString(ref.id);
  const issueId = trimmedString(ref.issueId);
  return issueId === issue.id || (type === "mission_issue" && id === issue.id);
}

export function materializedRefMatchesIssue(materializedRef: unknown, issue: Pick<IssueRow, "id">): boolean {
  const ref = asRecord(materializedRef);
  return trimmedString(ref.type) === "mission_issue" && trimmedString(ref.id) === issue.id;
}

export function activePlanPaqoStepMatchesIssue(
  activePlan: MissionSupervisionPlanArtifact,
  stepRowsForIssue: MissionSupervisionWorkflowStepRow[],
): boolean {
  const refs = asRecord(activePlan.refs);
  const paqoWorkflow = asRecord(refs.paqoWorkflow);
  const workflowRunId = trimmedString(paqoWorkflow.workflowRunId);
  const stepIds = new Set(asStringArray(paqoWorkflow.stepIds));
  if (!workflowRunId || stepIds.size === 0) return false;
  return stepRowsForIssue.some((row) => row.run.id === workflowRunId && stepIds.has(row.stepRun.stepId));
}

export function activePlanRecoveryGateReason(
  activePlan: MissionSupervisionPlanArtifact | null,
  issue: IssueRow,
  stepRowsForIssue: MissionSupervisionWorkflowStepRow[] = [],
): string | null {
  if (!activePlan) return null;
  if (issue.originKind === "mission_main_executor_plan" || issue.originKind === "mission_main_executor_oversight" || issue.originKind === "mission_main_executor_unblock") {
    return null;
  }
  if (activePlanPaqoStepMatchesIssue(activePlan, stepRowsForIssue)) return null;

  const stepCount = jsonArrayLength(activePlan.steps);
  if (stepCount === 0) {
    return `active plan revision=${activePlan.revision} has no high-level step skeleton; mission owner must finish the plan before source/QA recovery can execute`;
  }

  const refs = asRecord(activePlan.refs);
  const selectedExecutionUnits = asRecordArray(refs.selectedExecutionUnits);
  if (selectedExecutionUnits.length > 0) {
    const selectedUnit = selectedExecutionUnits.find((unit) => (
      sourceRefMatchesIssue(unit.sourceRef, issue) || materializedRefMatchesIssue(unit.materializedRef, issue)
    ));
    if (!selectedUnit) {
      if (activePlanPaqoStepMatchesIssue(activePlan, stepRowsForIssue)) return null;
      return `active plan revision=${activePlan.revision} does not select this issue as an execution unit; blocked status alone is not enough to launch recovery`;
    }
    const selectionState = normalizedPlanStatus(selectedUnit.selectionState);
    if (selectionState !== "selected") {
      return `active plan revision=${activePlan.revision} marks this issue selectionState=${selectionState || "unknown"}; only selected units can be unblocked or retried`;
    }
    const dependencyTreatment = normalizedPlanStatus(selectedUnit.dependencyTreatment);
    if (dependencyTreatment === "blocked") {
      return `active plan revision=${activePlan.revision} says this issue's prerequisites are blocked; wait for the upstream artifact/decision before running QA or recovery`;
    }
    const executionState = normalizedPlanStatus(selectedUnit.executionState);
    if (executionState === "not_materialized" || executionState === "completed" || executionState === "cancelled" || executionState === "canceled") {
      return `active plan revision=${activePlan.revision} marks this issue executionState=${executionState}; recovery is not runnable at this point`;
    }
    return null;
  }

  return null;
}

export function hasArtifactMissingSignal(...bodies: string[]): boolean {
  const body = bodies.join("\n").toLowerCase();
  return body.includes("required workflow artifact missing")
    || body.includes("required source artifact is missing")
    || body.includes("artifact missing")
    || body.includes("블로그 파일 누락")
    || body.includes("markdown 파일로 저장")
    || body.includes("파일로만 저장");
}

export function hasRecoverableArtifactComment(...bodies: string[]): boolean {
  const body = bodies.join("\n");
  const lower = body.toLowerCase();
  return hasArtifactMissingSignal(body)
    && (lower.includes(".md") || lower.includes("markdown"))
    && /^#{1,3}\s+\S+/m.test(body);
}

export function parseToolStepRecoveryMarker(description: string | null): { runId: string; stepId: string } | null {
  const match = description?.match(/<!--\s*tool-step-recovery:([0-9a-f-]{36}):([\s\S]*?)\s*-->/i);
  if (!match) return null;
  const runId = match[1]?.trim();
  const stepId = match[2]?.trim();
  if (!runId || !stepId || !isUuidLike(runId)) return null;
  return { runId, stepId };
}

export function toolStepRecoveryMarkerKey(marker: { runId: string; stepId: string }): string {
  return `${marker.runId}:${marker.stepId}`;
}

export function findCanonicalToolStepRecoveryIssue(input: {
  marker: { runId: string; stepId: string };
  missionIssues: IssueRow[];
}): IssueRow | null {
  const markerKey = toolStepRecoveryMarkerKey(input.marker);
  return input.missionIssues
    .filter((candidate) =>
      candidate.originKind === "mission_main_executor_unblock"
      && !candidate.hiddenAt
      && parseToolStepRecoveryMarker(candidate.description)
      && toolStepRecoveryMarkerKey(parseToolStepRecoveryMarker(candidate.description)!) === markerKey
    )
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))[0] ?? null;
}

export function buildNativeToolStepRetryAppliedMarker(input: {
  ownerActionIssueId: string;
  workflowRunId: string;
  stepId: string;
}): string {
  return `<!-- native-tool-step-retry-applied:${JSON.stringify(input)} -->`;
}

export function hasNativeToolStepRetryAppliedMarker(comments: string[], input: {
  ownerActionIssueId: string;
  workflowRunId: string;
  stepId: string;
}): boolean {
  return comments.some((comment) => comment.includes(buildNativeToolStepRetryAppliedMarker(input)));
}

