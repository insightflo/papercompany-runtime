import type { Db } from "@paperclipai/db";
import type { SQL } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  approvalComments,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  toolAuditLog,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { and, eq, inArray, or } from "drizzle-orm";
import type { MissionExecutionUnit, MissionExecutionStatus, MissionRuntimeLivenessEntry } from "./mission-execution-sources.js";
import { listMissionExecutionSourceSnapshots, normalizeMissionExecutionStatus } from "./mission-execution-sources.js";
import { missionOwnerHumanReportEvents } from "./mission-owner-human-report-events.js";
import { loadMissionOwnerDecisions } from "./mission-owner-recovery-ledger.js";

export type GovernanceThreadEventType =
  | "status_changed"
  | "assignment_changed"
  | "wakeup_requested"
  | "heartbeat_started"
  | "heartbeat_succeeded"
  | "heartbeat_failed"
  | "activity_observed"
  | "workflow_started"
  | "workflow_step_started"
  | "workflow_step_succeeded"
  | "workflow_step_failed"
  | "approval_requested"
  | "approval_granted"
  | "approval_rejected"
  | "tool_result"
  | "compact_error"
  | "owner_diagnosis"
  | "evidence_missing"
  | "runtime_busy"
  | "runtime_stale_busy";

export type GovernanceThreadSourceType =
  | "mission"
  | "issue"
  | "issue_comment"
  | "activity_log"
  | "workflow_run"
  | "workflow_step_run"
  | "plugin_workflow_run"
  | "plugin_workflow_step_run"
  | "plugin_tool_execution_log"
  | "tool_audit_log"
  | "agent_wakeup_request"
  | "heartbeat_run"
  | "mission_plan_artifact"
  | "approval"
  | "approval_comment"
  | "issue_approval"
  | "workflow_transition_event"
  | "mission_agent_runtime";

export type GovernanceThreadSourceRef = {
  type: GovernanceThreadSourceType;
  id: string;
  externalId?: string;
  table?: string;
};

export type GovernanceThreadSeverity = "info" | "attention" | "blocked" | "failed" | "approved" | "completed";

export type GovernanceThreadActor = {
  type: "agent" | "board" | "user" | "system" | "tool" | "external";
  id?: string;
  role?: string;
  authorityRole?: "specialist" | "mission_owner" | "approver" | "operator" | "system";
};

export type GovernanceThreadEvidenceRef = {
  type: "file" | "url" | "artifact" | "test" | "approval" | "log" | "comment" | "plan" | "rule" | "kb";
  ref: string;
  label?: string;
};

export type GovernanceThreadSuggestedResumeTarget = {
  action: "wake_agent" | "resume_workflow" | "request_human_input" | "owner_review" | "manual_retry" | "none";
  agentId?: string;
  issueId?: string;
  workflowRunId?: string;
  workflowStepRunId?: string;
};

export type GovernanceThreadEvent = {
  id: string;
  companyId: string;
  scope: {
    missionId: string;
    issueId?: string;
    workflowRunId?: string;
    workflowStepRunId?: string;
    heartbeatRunId?: string;
    approvalId?: string;
    toolExecutionId?: string;
  };
  sourceRef: GovernanceThreadSourceRef;
  eventType: GovernanceThreadEventType;
  title: string;
  summary: string;
  timestamp: string;
  severity?: GovernanceThreadSeverity;
  actor?: GovernanceThreadActor;
  evidenceRefs?: GovernanceThreadEvidenceRef[];
  suggestedResumeTarget?: GovernanceThreadSuggestedResumeTarget;
  rawAvailable?: boolean;
};

export type MissionGovernanceThreadSummary = {
  totalEventCount: number;
  latestEvents: GovernanceThreadEvent[];
  openDecisions: GovernanceThreadEvent[];
  suggestedResumeTarget?: GovernanceThreadSuggestedResumeTarget;
};

export type MissionGovernanceThread = {
  events: GovernanceThreadEvent[];
  summary: MissionGovernanceThreadSummary;
};

export type GovernanceEvent = GovernanceThreadEvent;
export type GovernanceEventType = GovernanceThreadEventType;
export type GovernanceEventSourceRef = GovernanceThreadSourceRef;
export type GovernanceActor = GovernanceThreadActor;
export type GovernanceThreadSummary = MissionGovernanceThreadSummary;

const DEFAULT_LATEST_EVENTS_LIMIT = 5;

const SOURCE_PRIORITY: Record<GovernanceThreadSourceType, number> = {
  mission: 0,
  issue: 1,
  workflow_run: 10,
  plugin_workflow_run: 11,
  workflow_step_run: 12,
  plugin_workflow_step_run: 13,
  heartbeat_run: 20,
  agent_wakeup_request: 21,
  workflow_transition_event: 22,
  mission_agent_runtime: 23,
  approval: 30,
  issue_approval: 31,
  approval_comment: 32,
  issue_comment: 33,
  tool_audit_log: 40,
  plugin_tool_execution_log: 41,
  mission_plan_artifact: 50,
  activity_log: 90,
};

export function normalizeGovernanceTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  return null;
}

export function stableGovernanceEventId(event: Pick<GovernanceThreadEvent, "eventType" | "sourceRef">): string {
  return `${event.eventType}:${event.sourceRef.type}:${event.sourceRef.id}`;
}

function timestampMillis(timestamp: string): number {
  const millis = Date.parse(timestamp);
  return Number.isFinite(millis) ? millis : 0;
}

export function sortGovernanceEvents(events: GovernanceThreadEvent[]): GovernanceThreadEvent[] {
  return [...events].sort((left, right) => {
    const timestampDelta = timestampMillis(left.timestamp) - timestampMillis(right.timestamp);
    if (timestampDelta !== 0) return timestampDelta;

    const priorityDelta = SOURCE_PRIORITY[left.sourceRef.type] - SOURCE_PRIORITY[right.sourceRef.type];
    if (priorityDelta !== 0) return priorityDelta;

    return `${left.sourceRef.type}:${left.sourceRef.id}`.localeCompare(`${right.sourceRef.type}:${right.sourceRef.id}`);
  });
}

export function dedupeGovernanceEvents(events: GovernanceThreadEvent[]): GovernanceThreadEvent[] {
  const eventsById = new Map<string, GovernanceThreadEvent>();
  for (const event of events) {
    eventsById.set(stableGovernanceEventId(event), {
      ...event,
      id: event.id || stableGovernanceEventId(event),
    });
  }
  return Array.from(eventsById.values());
}

export function summarizeGovernanceThread(
  events: GovernanceThreadEvent[],
  options: { latestEventsLimit?: number; maxLatestEvents?: number } = {},
): MissionGovernanceThreadSummary {
  const limit = options.latestEventsLimit ?? options.maxLatestEvents ?? DEFAULT_LATEST_EVENTS_LIMIT;
  const sortedEvents = sortGovernanceEvents(events);
  const latestEvents = sortedEvents.slice(Math.max(0, sortedEvents.length - limit));
  const openDecisions = sortedEvents.filter((event) => (
    event.eventType === "approval_requested"
    || event.suggestedResumeTarget?.action === "request_human_input"
  ));
  const suggestedResumeTarget = [...sortedEvents]
    .reverse()
    .find((event) => event.suggestedResumeTarget)?.suggestedResumeTarget;

  return {
    totalEventCount: events.length,
    latestEvents,
    openDecisions,
    ...(suggestedResumeTarget ? { suggestedResumeTarget } : {}),
  };
}

function mapExecutionSourceType(unit: MissionExecutionUnit): GovernanceThreadSourceType {
  switch (unit.sourceRef.type) {
    case "native_workflow_run":
      return "workflow_run";
    case "plugin_workflow_run":
      return "plugin_workflow_run";
    case "plugin_workflow_step_run":
      return "plugin_workflow_step_run";
  }
}

function mapExecutionSourceRef(unit: MissionExecutionUnit): GovernanceThreadSourceRef {
  return {
    type: mapExecutionSourceType(unit),
    id: unit.sourceRef.id,
    ...(unit.sourceRef.externalId ? { externalId: unit.sourceRef.externalId } : {}),
  };
}

function mapExecutionScope(unit: MissionExecutionUnit): GovernanceThreadEvent["scope"] {
  return {
    missionId: unit.missionId ?? "",
    ...(unit.issueId ? { issueId: unit.issueId } : {}),
    ...(unit.workflowRunId ? { workflowRunId: unit.workflowRunId } : {}),
    ...(unit.kind === "plugin_workflow_step_run" ? { workflowStepRunId: unit.sourceRef.id } : {}),
  };
}

function mapExecutionActor(unit: MissionExecutionUnit): GovernanceThreadActor {
  return {
    type: unit.pluginId ? "external" : "system",
    ...(unit.triggeredBy ? { role: unit.triggeredBy } : {}),
    ...(mapAuthorityRole(unit.triggeredBy) ? { authorityRole: mapAuthorityRole(unit.triggeredBy) } : {}),
  };
}

function mapAuthorityRole(value: string | null): GovernanceThreadActor["authorityRole"] | undefined {
  switch (value) {
    case "mission_owner":
    case "mission-owner":
      return "mission_owner";
    case "specialist":
      return "specialist";
    case "approver":
      return "approver";
    case "operator":
      return "operator";
    case "system":
      return "system";
    default:
      return undefined;
  }
}

function executionTimestamp(unit: MissionExecutionUnit): string {
  return (
    normalizeGovernanceTimestamp(unit.completedAt)
    ?? normalizeGovernanceTimestamp(unit.startedAt)
    ?? normalizeGovernanceTimestamp(unit.updatedAt)
    ?? normalizeGovernanceTimestamp(unit.createdAt)
    ?? "1970-01-01T00:00:00.000Z"
  );
}

function isTerminalFailure(status: MissionExecutionStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

function runEventForStatus(status: MissionExecutionStatus): {
  eventType: GovernanceThreadEventType;
  severity: GovernanceThreadSeverity;
  title: string;
  summary: string;
  suggestedResumeTarget?: GovernanceThreadSuggestedResumeTarget;
} {
  switch (status) {
    case "pending":
      return {
        eventType: "workflow_started",
        severity: "info",
        title: "Workflow pending",
        summary: "Workflow run is pending.",
      };
    case "running":
      return {
        eventType: "workflow_started",
        severity: "info",
        title: "Workflow started",
        summary: "Workflow run is running.",
      };
    case "completed":
      return {
        eventType: "status_changed",
        severity: "completed",
        title: "Workflow completed",
        summary: "Workflow run completed.",
      };
    case "failed":
    case "cancelled":
    case "timed_out":
      return {
        eventType: "status_changed",
        severity: "failed",
        title: "Workflow run needs owner review",
        summary: `Workflow run reached terminal status ${status}.`,
        suggestedResumeTarget: { action: "owner_review" },
      };
    case "unknown":
      return {
        eventType: "activity_observed",
        severity: "info",
        title: "Workflow activity observed",
        summary: "Workflow run has an unknown status.",
      };
  }
}

function stepEventForStatus(status: MissionExecutionStatus): {
  eventType: GovernanceThreadEventType;
  severity: GovernanceThreadSeverity;
  title: string;
  summary: string;
  suggestedResumeTarget?: GovernanceThreadSuggestedResumeTarget;
} {
  switch (status) {
    case "pending":
    case "running":
      return {
        eventType: "workflow_step_started",
        severity: "info",
        title: "Workflow step started",
        summary: `Workflow step is ${status}.`,
      };
    case "completed":
      return {
        eventType: "workflow_step_succeeded",
        severity: "completed",
        title: "Workflow step succeeded",
        summary: "Workflow step completed.",
      };
    case "failed":
    case "cancelled":
    case "timed_out":
      return {
        eventType: "workflow_step_failed",
        severity: "failed",
        title: "Workflow step failed",
        summary: `Workflow step reached terminal status ${status}.`,
        suggestedResumeTarget: { action: "owner_review" },
      };
    case "unknown":
      return {
        eventType: "activity_observed",
        severity: "info",
        title: "Workflow step activity observed",
        summary: "Workflow step has an unknown status.",
      };
  }
}

function minutesRounded(ms: number): number {
  return Math.round(ms / 60000);
}

/**
 * [런타임 라이브니스 → 거버넌스 이벤트]
 * - runtime_busy: busy + 백킹 런 있음 — 정상 대기. 경과/갱신 시각 포함.
 * - runtime_stale_busy: busy + 백킹 런 없음 — 회수기가 grace 내 idle 전환 예정.
 * idle 런타임은 잡음이므로 이벤트를 내지 않는다.
 */
export function mapRuntimeLivenessToGovernanceEvents(
  runtime: MissionRuntimeLivenessEntry,
  input: { missionId: string; companyId: string; now?: Date },
): GovernanceThreadEvent[] {
  if (runtime.status !== "busy") return [];
  const nowIso = (input.now ?? new Date()).toISOString();
  const scope = {
    missionId: input.missionId,
    ...(runtime.currentIssueId ? { issueId: runtime.currentIssueId } : {}),
    ...(runtime.backingRun ? { heartbeatRunId: runtime.backingRun.id } : {}),
  };
  const sourceRef = { type: "mission_agent_runtime" as const, id: runtime.runtimeId, table: "mission_agent_runtimes" };
  const agentLabel = runtime.agentName ?? runtime.agentId.slice(0, 8);
  const issueLabel = runtime.currentIssueIdentifier ?? runtime.currentIssueId?.slice(0, 8) ?? "-";

  if (runtime.backingRun) {
    const run = runtime.backingRun;
    return [{
      id: `runtime_busy:mission_agent_runtime:${runtime.runtimeId}:${run.id}`,
      companyId: input.companyId,
      scope,
      sourceRef,
      eventType: "runtime_busy",
      title: `Mission agent runtime busy — heartbeat run in flight`,
      summary: `에이전트 ${agentLabel} 런타임이 ${issueLabel} 작업 중: 런 ${run.id.slice(0, 8)} ${run.status}, 경과 ${minutesRounded(run.elapsedMs)}분 (런 갱신 ${minutesRounded(run.idleMs)}분 전). 백킹 런이 있으므로 정상 대기 — process_pid는 이 경로에서 기록되지 않아 사망 판단 근거가 아니다.`,
      timestamp: nowIso,
      severity: "info",
      actor: { type: "agent", id: runtime.agentId },
    }];
  }

  if (!runtime.staleBusy) {
    // grace 창 내 — 아직 회수 대상 아님. 잡음 방지를 위해 이벤트 생략.
    return [];
  }
  return [{
    id: `runtime_stale_busy:mission_agent_runtime:${runtime.runtimeId}`,
    companyId: input.companyId,
    scope,
    sourceRef,
    eventType: "runtime_stale_busy",
    title: `Mission agent runtime busy without backing run`,
    summary: `에이전트 ${agentLabel} 런타임이 busy ${minutesRounded(runtime.busySinceMs ?? 0)}분째 백킹 런 없이 유지 중 — stale-busy 회수기가 5분 grace 경과 시 idle로 전환하고 끊긴 이슈를 재웨이크한다. 수동 개입 불필요.`,
    timestamp: nowIso,
    severity: "attention",
    actor: { type: "agent", id: runtime.agentId },
  }];
}

export function mapExecutionUnitToGovernanceEvents(unit: MissionExecutionUnit): GovernanceThreadEvent[] {
  const sourceRef = mapExecutionSourceRef(unit);
  const scope = mapExecutionScope(unit);
  const actor = mapExecutionActor(unit);
  const mapping = unit.kind === "plugin_workflow_step_run" ? stepEventForStatus(unit.status) : runEventForStatus(unit.status);
  const suggestedResumeTarget = mapping.suggestedResumeTarget
    ? {
      ...mapping.suggestedResumeTarget,
      ...(unit.issueId ? { issueId: unit.issueId } : {}),
      ...(unit.workflowRunId ? { workflowRunId: unit.workflowRunId } : {}),
      ...(unit.kind === "plugin_workflow_step_run" ? { workflowStepRunId: unit.sourceRef.id } : {}),
    }
    : undefined;

  const event: GovernanceThreadEvent = {
    id: `${mapping.eventType}:${sourceRef.type}:${sourceRef.id}`,
    companyId: unit.companyId ?? "",
    scope,
    sourceRef,
    eventType: mapping.eventType,
    title: mapping.title,
    summary: mapping.summary,
    timestamp: executionTimestamp(unit),
    severity: mapping.severity,
    actor,
    ...(suggestedResumeTarget && isTerminalFailure(unit.status) ? { suggestedResumeTarget } : {}),
  };

  return [event];
}


type ListMissionGovernanceThreadInput = {
  companyId: string;
  missionId: string;
  limit?: number;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const timestamp = normalizeGovernanceTimestamp(value);
    if (timestamp) return timestamp;
  }
  return "1970-01-01T00:00:00.000Z";
}

function actorFromRow(input: { actorType?: string | null; actorId?: string | null; agentId?: string | null; userId?: string | null }): GovernanceThreadActor | undefined {
  const actorType = input.actorType ?? (input.agentId ? "agent" : input.userId ? "user" : undefined);
  if (!actorType) return undefined;
  const type = actorType === "agent" || actorType === "user" || actorType === "board" || actorType === "tool" || actorType === "external"
    ? actorType
    : "system";
  return { type, ...(input.actorId ?? input.agentId ?? input.userId ? { id: input.actorId ?? input.agentId ?? input.userId ?? undefined } : {}) };
}

function buildThread(events: GovernanceThreadEvent[], latestEventsLimit?: number): MissionGovernanceThread {
  const deduped = dedupeGovernanceEvents(events);
  const sorted = sortGovernanceEvents(deduped);
  return { events: sorted, summary: summarizeGovernanceThread(sorted, { latestEventsLimit }) };
}

function workflowStepMapping(statusValue: unknown): { eventType: GovernanceThreadEventType; severity: GovernanceThreadSeverity; title: string; summary: string; suggestedResumeTarget?: GovernanceThreadSuggestedResumeTarget } {
  const status = normalizeMissionExecutionStatus(statusValue);
  return stepEventForStatus(status);
}

function heartbeatEvent(row: typeof heartbeatRuns.$inferSelect, missionId: string): GovernanceThreadEvent[] {
  const status = row.status.toLowerCase();
  const isSuccess = ["completed", "succeeded", "success"].includes(status);
  const isFailure = ["failed", "error", "cancelled", "canceled", "timed_out", "timed-out"].includes(status);
  const eventType: GovernanceThreadEventType = isSuccess ? "heartbeat_succeeded" : isFailure ? "heartbeat_failed" : "heartbeat_started";
  const severity: GovernanceThreadSeverity = isSuccess ? "completed" : isFailure ? "failed" : "info";
  const base: GovernanceThreadEvent = {
    id: `${eventType}:heartbeat_run:${row.id}`,
    companyId: row.companyId,
    scope: { missionId, ...(row.issueId ? { issueId: row.issueId } : {}), heartbeatRunId: row.id },
    sourceRef: { type: "heartbeat_run", id: row.id, table: "heartbeat_runs" },
    eventType,
    title: isSuccess ? "Heartbeat succeeded" : isFailure ? "Heartbeat failed" : "Heartbeat started",
    summary: `Heartbeat run is ${row.status}.`,
    timestamp: safeTimestamp(row.finishedAt, row.startedAt, row.createdAt),
    severity,
    actor: { type: "agent", id: row.agentId },
    rawAvailable: Boolean(row.logRef || row.stdoutExcerpt || row.stderrExcerpt),
    ...(isFailure ? { suggestedResumeTarget: { action: "owner_review", ...(row.issueId ? { issueId: row.issueId } : {}) } } : {}),
  };
  const events = [base];
  const errorSummary = row.errorCode ?? row.error ?? row.stderrExcerpt;
  if (isFailure && errorSummary) {
    events.push({
      ...base,
      id: `compact_error:heartbeat_run:${row.id}`,
      eventType: "compact_error",
      title: "Heartbeat error observed",
      summary: String(errorSummary).slice(0, 240),
      severity: "failed",
    });
  }
  return events;
}

function approvalEvent(row: typeof approvals.$inferSelect, issueId: string, missionId: string): GovernanceThreadEvent {
  const status = row.status.toLowerCase();
  const isApproved = ["approved", "granted"].includes(status);
  const isRejected = ["rejected", "denied"].includes(status);
  const isOpen = ["pending", "revision_requested", "revision-requested"].includes(status);
  const eventType: GovernanceThreadEventType = isApproved ? "approval_granted" : isRejected ? "approval_rejected" : isOpen ? "approval_requested" : "activity_observed";
  return {
    id: `${eventType}:approval:${row.id}`,
    companyId: row.companyId,
    scope: { missionId, issueId, approvalId: row.id },
    sourceRef: { type: "approval", id: row.id, table: "approvals" },
    eventType,
    title: isApproved ? "Approval granted" : isRejected ? "Approval rejected" : isOpen ? "Approval decision open" : "Approval status observed",
    summary: `Approval ${row.type} status is ${row.status}.`,
    timestamp: safeTimestamp(row.decidedAt, row.updatedAt, row.createdAt),
    severity: isApproved ? "approved" : isRejected ? "failed" : isOpen ? "attention" : "info",
    actor: row.decidedByUserId ? { type: "user", id: row.decidedByUserId } : actorFromRow({ agentId: row.requestedByAgentId, userId: row.requestedByUserId }),
    ...(isOpen ? { suggestedResumeTarget: { action: "request_human_input", issueId } } : {}),
  };
}

function activityEvent(row: typeof activityLog.$inferSelect, missionId: string, issueIds: Set<string>): GovernanceThreadEvent {
  const details = (row.details ?? {}) as Record<string, unknown>;
  const issueId = row.entityType === "issue" && issueIds.has(row.entityId) ? row.entityId : asString(details.issueId);
  const isOwnerDiagnosis = row.action === "mission.supervision.run";
  return {
    id: `${isOwnerDiagnosis ? "owner_diagnosis" : "activity_observed"}:activity_log:${row.id}`,
    companyId: row.companyId,
    scope: { missionId, ...(issueId && issueIds.has(issueId) ? { issueId } : {}), ...(row.runId ? { heartbeatRunId: row.runId } : {}) },
    sourceRef: { type: "activity_log", id: row.id, table: "activity_log" },
    eventType: isOwnerDiagnosis ? "owner_diagnosis" : "activity_observed",
    title: isOwnerDiagnosis ? "Owner diagnosis observed" : "Activity observed",
    summary: row.action,
    timestamp: safeTimestamp(row.createdAt),
    severity: isOwnerDiagnosis ? "attention" : "info",
    actor: actorFromRow({ actorType: row.actorType, actorId: row.actorId, agentId: row.agentId }),
  };
}

function wakeupPayloadMatchesMission(payload: Record<string, unknown> | null | undefined, missionId: string, issueIds: Set<string>): boolean {
  if (!payload) return false;
  const payloadMissionId = asString(payload.missionId);
  const payloadIssueId = asString(payload.issueId);
  if (payloadMissionId && payloadMissionId !== missionId) return false;
  if (payloadIssueId && !issueIds.has(payloadIssueId)) return false;
  return payloadMissionId === missionId || Boolean(payloadIssueId && issueIds.has(payloadIssueId));
}

export async function listMissionGovernanceThread(
  db: Db,
  input: ListMissionGovernanceThreadInput,
): Promise<MissionGovernanceThread | null> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
    .limit(1);

  if (!mission) return null;

  const missionIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId)));
  const issueIds = new Set(missionIssues.map((issue) => issue.id));
  const issueIdList = Array.from(issueIds);

  const events: GovernanceThreadEvent[] = [{
    id: `status_changed:mission:${mission.id}`,
    companyId: input.companyId,
    scope: { missionId: mission.id },
    sourceRef: { type: "mission", id: mission.id, table: "missions" },
    eventType: "status_changed",
    title: "Mission status observed",
    summary: `Mission status is ${mission.status}.`,
    timestamp: safeTimestamp(mission.updatedAt, mission.createdAt),
    severity: mission.status === "completed" ? "completed" : mission.status === "active" ? "attention" : "info",
    actor: { type: "system" },
  }];

  for (const issue of missionIssues) {
    events.push({
      id: `status_changed:issue:${issue.id}`,
      companyId: input.companyId,
      scope: { missionId: mission.id, issueId: issue.id },
      sourceRef: { type: "issue", id: issue.id, table: "issues" },
      eventType: "status_changed",
      title: "Issue status observed",
      summary: `Issue ${issue.title} status is ${issue.status}.`,
      timestamp: safeTimestamp(issue.updatedAt, issue.createdAt),
      severity: issue.status === "done" ? "completed" : issue.status === "blocked" ? "blocked" : "info",
      actor: issue.assigneeAgentId ? { type: "agent", id: issue.assigneeAgentId } : { type: "system" },
    });
  }

  const executionSnapshots = await listMissionExecutionSourceSnapshots(db, { companyId: input.companyId, missionIds: [input.missionId] });
  const executionUnits = executionSnapshots[input.missionId]?.units ?? [];
  for (const unit of executionUnits) events.push(...mapExecutionUnitToGovernanceEvents(unit));
  // [런타임 라이브니스 — 2026-09-01 표시 개선] busy 런타임의 실제 실행 상태를 거버넌스에
  // 노출한다. 백킹 런이 있으면 "정상 대기"(PID 미기록은 사망 근거 아님), 없으면
  // "고착 예정 — 회수기가 grace 내 idle 전환"을 표시해 오판 진단을 차단한다.
  for (const runtime of executionSnapshots[input.missionId]?.runtimes ?? []) {
    events.push(...mapRuntimeLivenessToGovernanceEvents(runtime, {
      missionId: input.missionId,
      companyId: input.companyId,
    }));
  }

  const nativeRunIds = executionUnits
    .filter((unit) => unit.kind === "native_workflow_run")
    .map((unit) => unit.id);
  if (nativeRunIds.length > 0) {
    const nativeSteps = await db
      .select({ step: workflowStepRuns, run: workflowRuns })
      .from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(and(
        eq(workflowRuns.companyId, input.companyId),
        eq(workflowRuns.missionId, input.missionId),
        inArray(workflowStepRuns.workflowRunId, nativeRunIds),
      ));
    for (const { step, run } of nativeSteps) {
      const mapping = workflowStepMapping(step.status);
      events.push({
        id: `${mapping.eventType}:workflow_step_run:${step.id}`,
        companyId: input.companyId,
        scope: { missionId: input.missionId, ...(step.issueId ? { issueId: step.issueId } : {}), workflowRunId: run.id, workflowStepRunId: step.id },
        sourceRef: { type: "workflow_step_run", id: step.id, table: "workflow_step_runs" },
        eventType: mapping.eventType,
        title: mapping.title,
        summary: mapping.summary,
        timestamp: safeTimestamp(step.completedAt, step.startedAt, run.createdAt),
        severity: mapping.severity,
        actor: { type: "system" },
        ...(mapping.suggestedResumeTarget ? { suggestedResumeTarget: { ...mapping.suggestedResumeTarget, ...(step.issueId ? { issueId: step.issueId } : {}), workflowRunId: run.id, workflowStepRunId: step.id } } : {}),
      });
    }
  }

  let missionHeartbeatRuns: (typeof heartbeatRuns.$inferSelect)[] = [];
  if (issueIdList.length > 0) {
    missionHeartbeatRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.issueId, issueIdList)));
    for (const run of missionHeartbeatRuns) events.push(...heartbeatEvent(run, input.missionId));
  }
  const heartbeatRunIds = new Set(missionHeartbeatRuns.map((run) => run.id));

  const wakeupIds = new Set(missionHeartbeatRuns.map((run) => run.wakeupRequestId).filter((id): id is string => Boolean(id)));
  const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
  for (const request of wakeups) {
    const linkedByRun = Boolean(request.runId && heartbeatRunIds.has(request.runId));
    const linkedByHeartbeat = wakeupIds.has(request.id);
    const linkedByPayload = wakeupPayloadMatchesMission((request.payload ?? {}) as Record<string, unknown>, input.missionId, issueIds);
    if (!linkedByRun && !linkedByHeartbeat && !linkedByPayload) continue;
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const payloadIssueId = asString(payload.issueId);
    events.push({
      id: `wakeup_requested:agent_wakeup_request:${request.id}`,
      companyId: input.companyId,
      scope: { missionId: input.missionId, ...(payloadIssueId && issueIds.has(payloadIssueId) ? { issueId: payloadIssueId } : {}), ...(request.runId ? { heartbeatRunId: request.runId } : {}) },
      sourceRef: { type: "agent_wakeup_request", id: request.id, table: "agent_wakeup_requests" },
      eventType: "wakeup_requested",
      title: "Agent wakeup requested",
      summary: request.reason ?? request.triggerDetail ?? request.source,
      timestamp: safeTimestamp(request.requestedAt, request.createdAt),
      severity: "attention",
      actor: actorFromRow({ actorType: request.requestedByActorType, actorId: request.requestedByActorId }) ?? { type: "system" },
      suggestedResumeTarget: { action: "wake_agent", agentId: request.agentId, ...(payloadIssueId && issueIds.has(payloadIssueId) ? { issueId: payloadIssueId } : {}) },
    });
  }

  const activityScopePredicates: SQL[] = [and(eq(activityLog.entityType, "mission"), eq(activityLog.entityId, input.missionId)) as SQL];
  if (issueIdList.length > 0) {
    activityScopePredicates.push(and(eq(activityLog.entityType, "issue"), inArray(activityLog.entityId, issueIdList)) as SQL);
  }
  if (heartbeatRunIds.size > 0) {
    activityScopePredicates.push(inArray(activityLog.runId, Array.from(heartbeatRunIds)) as SQL);
  }
  const scopedActivity = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId),
    or(...activityScopePredicates),
  ));
  for (const activity of scopedActivity) {
    if (activity.action === "heartbeat.invoked" && activity.runId && heartbeatRunIds.has(activity.runId)) continue;
    events.push(activityEvent(activity, input.missionId, issueIds));
  }

  if (issueIdList.length > 0) {
    const [scopedIssueComments, ownerDecisionRecords] = await Promise.all([
      db.select().from(issueComments).where(and(eq(issueComments.companyId, input.companyId), inArray(issueComments.issueId, issueIdList))),
      loadMissionOwnerDecisions({
        db,
        companyId: input.companyId,
        missionId: input.missionId,
        issueIds,
      }),
    ]);
    events.push(...missionOwnerHumanReportEvents({
      missionId: input.missionId,
      issueIds,
      decisions: ownerDecisionRecords.map((record) => ({
        companyId: input.companyId,
        issueId: record.ownerActionIssueId,
        eventId: record.eventId,
        commentId: record.commentId,
        createdAt: record.createdAt,
        authorAgentId: record.authorAgentId,
        decision: record.decision,
      })),
    }));
    for (const comment of scopedIssueComments) {
      events.push({
        id: `activity_observed:issue_comment:${comment.id}`,
        companyId: input.companyId,
        scope: { missionId: input.missionId, issueId: comment.issueId },
        sourceRef: { type: "issue_comment", id: comment.id, table: "issue_comments" },
        eventType: "activity_observed",
        title: "Issue comment observed",
        summary: "Issue comment added.",
        timestamp: safeTimestamp(comment.createdAt),
        severity: "info",
        actor: actorFromRow({ agentId: comment.authorAgentId, userId: comment.authorUserId }),
      });
    }

    const links = await db.select().from(issueApprovals).where(and(eq(issueApprovals.companyId, input.companyId), inArray(issueApprovals.issueId, issueIdList)));
    const approvalToIssue = new Map(links.map((link) => [link.approvalId, link.issueId]));
    const approvalIds = Array.from(approvalToIssue.keys());
    if (approvalIds.length > 0) {
      const scopedApprovals = await db.select().from(approvals).where(and(eq(approvals.companyId, input.companyId), inArray(approvals.id, approvalIds)));
      const scopedApprovalIds = new Set(scopedApprovals.map((approval) => approval.id));
      for (const approval of scopedApprovals) events.push(approvalEvent(approval, approvalToIssue.get(approval.id)!, input.missionId));
      const comments = await db.select().from(approvalComments).where(and(eq(approvalComments.companyId, input.companyId), inArray(approvalComments.approvalId, Array.from(scopedApprovalIds))));
      for (const comment of comments) {
        const issueId = approvalToIssue.get(comment.approvalId);
        if (!issueId) continue;
        events.push({
          id: `activity_observed:approval_comment:${comment.id}`,
          companyId: input.companyId,
          scope: { missionId: input.missionId, issueId, approvalId: comment.approvalId },
          sourceRef: { type: "approval_comment", id: comment.id, table: "approval_comments" },
          eventType: "activity_observed",
          title: "Approval comment observed",
          summary: "Approval comment added.",
          timestamp: safeTimestamp(comment.createdAt),
          severity: "info",
          actor: actorFromRow({ agentId: comment.authorAgentId, userId: comment.authorUserId }),
          evidenceRefs: [{ type: "comment", ref: comment.id, label: "approval comment" }],
        });
      }
    }

    const toolRows = await db.select().from(toolAuditLog).where(and(eq(toolAuditLog.companyId, input.companyId), inArray(toolAuditLog.issueId, issueIdList)));
    for (const toolRow of toolRows) {
      const blockedMust = toolRow.result === "blocked_must";
      const failed = blockedMust || ["failed", "error"].includes(toolRow.result);
      events.push({
        id: `${failed ? "compact_error" : "tool_result"}:tool_audit_log:${toolRow.id}`,
        companyId: input.companyId,
        scope: { missionId: input.missionId, ...(toolRow.issueId ? { issueId: toolRow.issueId } : {}), toolExecutionId: toolRow.id },
        sourceRef: { type: "tool_audit_log", id: toolRow.id, table: "tool_audit_log" },
        eventType: failed ? "compact_error" : "tool_result",
        title: failed ? "Tool governance block observed" : "Tool result observed",
        summary: toolRow.result.slice(0, 240),
        timestamp: safeTimestamp(toolRow.createdAt),
        severity: blockedMust ? "blocked" : failed ? "failed" : toolRow.result === "blocked_should" ? "attention" : "info",
        actor: actorFromRow({ agentId: toolRow.agentId }) ?? { type: "tool" },
      });
    }
  }

  const activePlans = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, input.companyId), eq(missionPlanArtifacts.missionId, input.missionId), eq(missionPlanArtifacts.status, "active")));
  const workflowBacked = executionUnits.length > 0 || missionIssues.some((issue) => issue.originKind?.includes("workflow"));
  if (activePlans.length === 0 && workflowBacked) {
    events.push({
      id: `evidence_missing:mission_plan_artifact:${input.missionId}`,
      companyId: input.companyId,
      scope: { missionId: input.missionId },
      sourceRef: { type: "mission_plan_artifact", id: input.missionId, table: "mission_plan_artifacts" },
      eventType: "evidence_missing",
      title: "Active mission plan missing",
      summary: "Workflow-backed mission has execution evidence but no active mission plan artifact.",
      timestamp: safeTimestamp(mission.updatedAt, mission.createdAt),
      severity: "attention",
      suggestedResumeTarget: { action: "owner_review" },
    });
  }

  return buildThread(events, input.limit);
}
