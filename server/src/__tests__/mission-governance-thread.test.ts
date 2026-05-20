import { describe, expect, it } from "vitest";
import type { MissionExecutionUnit } from "../services/missions/mission-execution-sources.js";
import {
  type GovernanceThreadActor,
  type GovernanceThreadEvent,
  type GovernanceThreadEventType,
  type GovernanceThreadSourceRef,
  dedupeGovernanceEvents,
  mapExecutionUnitToGovernanceEvents,
  normalizeGovernanceTimestamp,
  sortGovernanceEvents,
  stableGovernanceEventId,
  summarizeGovernanceThread,
} from "../services/missions/governance-thread.js";

const COMPANY_ID = "company-1";
const MISSION_ID = "mission-1";
const RUN_ID = "run-1";
const STEP_RUN_ID = "step-run-1";

function makeSourceRef(overrides: Partial<GovernanceThreadSourceRef> = {}): GovernanceThreadSourceRef {
  return {
    type: "workflow_run",
    id: RUN_ID,
    ...overrides,
  };
}

function makeActor(overrides: Partial<GovernanceThreadActor> = {}): GovernanceThreadActor {
  return {
    type: "system",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<GovernanceThreadEvent> = {}): GovernanceThreadEvent {
  const eventType = overrides.eventType ?? "workflow_started";
  const sourceRef = overrides.sourceRef ?? makeSourceRef();
  return {
    id: `${eventType}:${sourceRef.type}:${sourceRef.id}`,
    companyId: COMPANY_ID,
    scope: {
      missionId: MISSION_ID,
      workflowRunId: RUN_ID,
    },
    sourceRef,
    eventType,
    title: "Workflow started",
    summary: "Workflow run is running.",
    timestamp: "2026-05-20T00:00:00.000Z",
    severity: "info",
    actor: makeActor(),
    ...overrides,
  };
}

function makeUnit(overrides: Partial<MissionExecutionUnit> = {}): MissionExecutionUnit {
  const kind = overrides.kind ?? "native_workflow_run";
  const entityId = overrides.entityId ?? overrides.id ?? RUN_ID;
  return {
    id: overrides.id ?? entityId,
    kind,
    companyId: COMPANY_ID,
    missionId: MISSION_ID,
    workflowId: "workflow-1",
    workflowRunId: RUN_ID,
    stepId: null,
    issueId: null,
    workflowName: "Daily workflow",
    title: "Daily workflow",
    status: "running",
    triggeredBy: "agent",
    startedAt: new Date("2026-05-20T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    updatedAt: new Date("2026-05-20T00:00:00.000Z"),
    pluginId: null,
    entityId,
    externalId: null,
    sourceRef: {
      type: kind,
      id: entityId,
      workflowRunId: RUN_ID,
      stepId: null,
      issueId: null,
      pluginId: null,
      externalId: null,
    },
    ...overrides,
  };
}

describe("governance-thread DTO shape", () => {
  it("supports the full Phase 1 event type vocabulary including activity_observed", () => {
    const eventTypes: GovernanceThreadEventType[] = [
      "status_changed",
      "assignment_changed",
      "wakeup_requested",
      "heartbeat_started",
      "heartbeat_succeeded",
      "heartbeat_failed",
      "activity_observed",
      "workflow_started",
      "workflow_step_started",
      "workflow_step_succeeded",
      "workflow_step_failed",
      "approval_requested",
      "approval_granted",
      "approval_rejected",
      "tool_result",
      "compact_error",
      "owner_diagnosis",
      "evidence_missing",
    ];

    expect(eventTypes).toContain("activity_observed");
    expect(eventTypes).toHaveLength(18);
  });

  it("supports source refs beyond execution units", () => {
    const sourceRefs: GovernanceThreadSourceRef[] = [
      makeSourceRef({ type: "mission", id: "mission-1", table: "missions" }),
      makeSourceRef({ type: "issue", id: "issue-1" }),
      makeSourceRef({ type: "activity_log", id: "activity-1" }),
      makeSourceRef({ type: "workflow_run", id: "native-run-1" }),
      makeSourceRef({ type: "plugin_workflow_run", id: "plugin-run-1", externalId: "external-run-1" }),
      makeSourceRef({ type: "plugin_workflow_step_run", id: "plugin-step-1", externalId: "external-step-1" }),
      makeSourceRef({ type: "tool_audit_log", id: "tool-1" }),
      makeSourceRef({ type: "approval_comment", id: "approval-comment-1" }),
    ];

    expect(sourceRefs.map((sourceRef) => sourceRef.type)).toEqual([
      "mission",
      "issue",
      "activity_log",
      "workflow_run",
      "plugin_workflow_run",
      "plugin_workflow_step_run",
      "tool_audit_log",
      "approval_comment",
    ]);
    expect(sourceRefs[4].externalId).toBe("external-run-1");
    expect(sourceRefs[0].table).toBe("missions");
  });

  it("uses the plan-shaped event fields and actor authority separation", () => {
    const event = makeEvent({
      actor: makeActor({
        type: "agent",
        id: "agent-1",
        role: "raw-runner-label",
        authorityRole: "mission_owner",
      }),
      evidenceRefs: [{ type: "log", ref: "log-ref", label: "short log" }],
      suggestedResumeTarget: { action: "owner_review", issueId: "issue-1", workflowRunId: RUN_ID },
      rawAvailable: true,
    });

    expect(event.id).toBe("workflow_started:workflow_run:run-1");
    expect(event.companyId).toBe(COMPANY_ID);
    expect(event.scope.missionId).toBe(MISSION_ID);
    expect(event.title).toBe("Workflow started");
    expect(event.summary).toBe("Workflow run is running.");
    expect(event.timestamp).toBe("2026-05-20T00:00:00.000Z");
    expect(event.actor?.type).toBe("agent");
    expect(event.actor?.role).toBe("raw-runner-label");
    expect(event.actor?.authorityRole).toBe("mission_owner");
    expect(event.evidenceRefs?.[0].type).toBe("log");
    expect(event.suggestedResumeTarget?.action).toBe("owner_review");
    expect(event.rawAvailable).toBe(true);
  });
});

describe("governance-thread helpers", () => {
  it("normalizes Dates and strings to canonical timestamp strings", () => {
    expect(normalizeGovernanceTimestamp(new Date("2026-05-20T00:00:00.000Z"))).toBe(
      "2026-05-20T00:00:00.000Z",
    );
    expect(normalizeGovernanceTimestamp("2026-05-20T00:00:00Z")).toBe("2026-05-20T00:00:00.000Z");
    expect(normalizeGovernanceTimestamp(null)).toBeNull();
    expect(normalizeGovernanceTimestamp("not-a-date")).toBeNull();
  });

  it("creates deterministic ids from eventType and sourceRef", () => {
    const event = makeEvent({
      eventType: "activity_observed",
      sourceRef: makeSourceRef({ type: "activity_log", id: "activity-1" }),
    });

    expect(stableGovernanceEventId(event)).toBe("activity_observed:activity_log:activity-1");
  });

  it("sorts by timestamp ascending, source priority, then sourceRef.type:id", () => {
    const timestamp = "2026-05-20T00:00:00.000Z";
    const later = makeEvent({ timestamp: "2026-05-20T00:00:01.000Z", sourceRef: makeSourceRef({ id: "later" }) });
    const pluginRun = makeEvent({ timestamp, sourceRef: makeSourceRef({ type: "plugin_workflow_run", id: "b" }) });
    const activity = makeEvent({ timestamp, sourceRef: makeSourceRef({ type: "activity_log", id: "a" }) });
    const nativeRunB = makeEvent({ timestamp, sourceRef: makeSourceRef({ type: "workflow_run", id: "b" }) });
    const nativeRunA = makeEvent({ timestamp, sourceRef: makeSourceRef({ type: "workflow_run", id: "a" }) });

    expect(sortGovernanceEvents([later, pluginRun, activity, nativeRunB, nativeRunA]).map((event) => event.sourceRef.id)).toEqual([
      "a",
      "b",
      "b",
      "a",
      "later",
    ]);
  });

  it("does not mutate input arrays while sorting", () => {
    const later = makeEvent({ timestamp: "2026-05-20T00:00:01.000Z", sourceRef: makeSourceRef({ id: "later" }) });
    const earlier = makeEvent({ timestamp: "2026-05-20T00:00:00.000Z", sourceRef: makeSourceRef({ id: "earlier" }) });
    const events = [later, earlier];

    expect(sortGovernanceEvents(events).map((event) => event.sourceRef.id)).toEqual(["earlier", "later"]);
    expect(events.map((event) => event.sourceRef.id)).toEqual(["later", "earlier"]);
  });

  it("dedupes only by eventType plus sourceRef.type:id and preserves distinct event types", () => {
    const first = makeEvent({ eventType: "workflow_started", sourceRef: makeSourceRef({ id: "same" }), summary: "first" });
    const replacement = makeEvent({ eventType: "workflow_started", sourceRef: makeSourceRef({ id: "same" }), summary: "replacement" });
    const distinctType = makeEvent({ eventType: "status_changed", sourceRef: makeSourceRef({ id: "same" }), summary: "distinct" });

    const deduped = dedupeGovernanceEvents([first, replacement, distinctType]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].summary).toBe("replacement");
    expect(deduped[1].eventType).toBe("status_changed");
  });

  it("summarizes bounded latest events and total count", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      makeEvent({
        sourceRef: makeSourceRef({ id: `event-${index}` }),
        timestamp: `2026-05-20T00:00:0${index}.000Z`,
      }),
    );

    const summary = summarizeGovernanceThread(events);

    expect(summary.totalEventCount).toBe(10);
    expect(summary.latestEvents.map((event) => event.sourceRef.id)).toEqual([
      "event-5",
      "event-6",
      "event-7",
      "event-8",
      "event-9",
    ]);
  });

  it("uses event suggestedResumeTarget as plain data and does not expose side-effect functions", () => {
    const event = makeEvent({
      eventType: "workflow_step_failed",
      sourceRef: makeSourceRef({ type: "plugin_workflow_step_run", id: STEP_RUN_ID }),
      suggestedResumeTarget: {
        action: "owner_review",
        issueId: "issue-1",
        workflowRunId: RUN_ID,
        workflowStepRunId: STEP_RUN_ID,
      },
    });

    const summary = summarizeGovernanceThread([event]);

    expect(summary.suggestedResumeTarget).toEqual({
      action: "owner_review",
      issueId: "issue-1",
      workflowRunId: RUN_ID,
      workflowStepRunId: STEP_RUN_ID,
    });
    expect(Object.values(summary.suggestedResumeTarget ?? {}).some((value) => typeof value === "function")).toBe(false);
  });
});

describe("mapExecutionUnitToGovernanceEvents", () => {
  it("maps a native running workflow run to workflow_started with workflow_run sourceRef", () => {
    const [event] = mapExecutionUnitToGovernanceEvents(makeUnit({ status: "running" }));

    expect(event.eventType).toBe("workflow_started");
    expect(event.sourceRef).toMatchObject({ type: "workflow_run", id: RUN_ID });
    expect(event.companyId).toBe(COMPANY_ID);
    expect(event.scope).toMatchObject({ missionId: MISSION_ID, workflowRunId: RUN_ID });
    expect(event.severity).toBe("info");
  });

  it("maps native workflow run completion to status_changed/completed", () => {
    const [event] = mapExecutionUnitToGovernanceEvents(makeUnit({ status: "completed", completedAt: new Date("2026-05-20T00:01:00.000Z") }));

    expect(event.eventType).toBe("status_changed");
    expect(event.severity).toBe("completed");
    expect(event.timestamp).toBe("2026-05-20T00:01:00.000Z");
  });

  it("does not emit workflow_step_failed for terminal native workflow runs", () => {
    const events = mapExecutionUnitToGovernanceEvents(makeUnit({ status: "timed_out" }));

    expect(events).toHaveLength(1);
    expect(events.map((event) => event.eventType)).not.toContain("workflow_step_failed");
    expect(events[0]).toMatchObject({ eventType: "status_changed", severity: "failed" });
  });

  it("preserves plugin workflow run id and externalId while avoiding step failure labels", () => {
    const events = mapExecutionUnitToGovernanceEvents(makeUnit({
      kind: "plugin_workflow_run",
      status: "failed",
      pluginId: "plugin-1",
      externalId: "external-run-1",
      sourceRef: {
        type: "plugin_workflow_run",
        id: "plugin-run-row-1",
        workflowRunId: "plugin-run-row-1",
        stepId: null,
        issueId: null,
        pluginId: "plugin-1",
        externalId: "external-run-1",
      },
    }));

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("status_changed");
    expect(events[0].sourceRef).toMatchObject({
      type: "plugin_workflow_run",
      id: "plugin-run-row-1",
      externalId: "external-run-1",
    });
    expect(events.map((event) => event.eventType)).not.toContain("workflow_step_failed");
  });

  it("maps plugin workflow step runs by status and preserves step source provenance", () => {
    const baseStepUnit = makeUnit({
      kind: "plugin_workflow_step_run",
      id: STEP_RUN_ID,
      entityId: STEP_RUN_ID,
      workflowRunId: "plugin-run-row-1",
      stepId: "collect-market",
      issueId: "issue-1",
      pluginId: "plugin-1",
      sourceRef: {
        type: "plugin_workflow_step_run",
        id: STEP_RUN_ID,
        workflowRunId: "plugin-run-row-1",
        stepId: "collect-market",
        issueId: "issue-1",
        pluginId: "plugin-1",
        externalId: "external-step-1",
      },
    });

    expect(mapExecutionUnitToGovernanceEvents({ ...baseStepUnit, status: "pending" })[0]).toMatchObject({
      eventType: "workflow_step_started",
      sourceRef: { type: "plugin_workflow_step_run", id: STEP_RUN_ID, externalId: "external-step-1" },
    });
    expect(mapExecutionUnitToGovernanceEvents({ ...baseStepUnit, status: "completed" })[0].eventType).toBe(
      "workflow_step_succeeded",
    );
    expect(mapExecutionUnitToGovernanceEvents({ ...baseStepUnit, status: "timed_out" })[0]).toMatchObject({
      eventType: "workflow_step_failed",
      severity: "failed",
      scope: {
        missionId: MISSION_ID,
        issueId: "issue-1",
        workflowRunId: "plugin-run-row-1",
        workflowStepRunId: STEP_RUN_ID,
      },
    });
  });

  it("maps unknown execution status to activity_observed without state transition", () => {
    const [event] = mapExecutionUnitToGovernanceEvents(makeUnit({ status: "unknown" }));

    expect(event.eventType).toBe("activity_observed");
    expect(event.summary).not.toMatch(/completed|failed|cancelled|timed out/i);
  });

  it("keeps actor.type separate from raw actor.role and authorityRole", () => {
    const [event] = mapExecutionUnitToGovernanceEvents(makeUnit({ triggeredBy: "mission_owner" }));

    expect(event.actor).toMatchObject({
      type: "system",
      role: "mission_owner",
      authorityRole: "mission_owner",
    });
  });
});
