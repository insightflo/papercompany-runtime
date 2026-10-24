import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issues, missions, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";
import { buildMissionSupervisionContext } from "../services/missions/mission-supervision-context.js";
import { buildTerminalAlertLiveWakeupIssueIds } from "../services/missions/terminal-alert-wakeup-liveness.js";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const reportEventType = "terminal_mission_human_operator_report";
const t1 = new Date("2026-07-01T00:01:00.000Z");
const t2 = new Date("2026-07-01T00:02:00.000Z");
const t3 = new Date("2026-07-01T00:03:00.000Z");

type Fixture = {
  companyId: string; ownerAgentId: string; missionId: string; sourceIssueId: string;
  ownerActionIssueId: string; oversightIssueId: string; failedRunId: string;
  endedRunId: string; wakeupId: string;
};

async function seedFixture(db: ReturnType<typeof createDb>): Promise<Fixture> {
  const companyId = randomUUID(), ownerAgentId = randomUUID(), workerAgentId = randomUUID();
  const missionId = randomUUID(), ownerActionIssueId = randomUUID(), oversightIssueId = randomUUID();
  const failedRunId = randomUUID(), endedRunId = randomUUID(), wakeupId = randomUUID();
  const prefix = "TA" + companyId.slice(0, 6).toUpperCase();
  await db.insert(companies).values({ id: companyId, name: "Alert fixture", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: workerAgentId, companyId, name: "Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  ]);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Alert fixture", status: "active" });
  const source = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
  await db.insert(issues).values([
    { id: ownerActionIssueId, companyId, missionId, identifier: prefix + "-" + ownerActionIssueId.slice(0, 8), title: "[Unblock] source", status: "blocked", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock", originId: source.id },
    { id: oversightIssueId, companyId, missionId, identifier: prefix + "-" + oversightIssueId.slice(0, 8), title: "[OVERSIGHT] mission", status: "todo", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_oversight" },
  ]);
  await db.insert(heartbeatRuns).values([
    { id: endedRunId, companyId, agentId: ownerAgentId, issueId: oversightIssueId, status: "succeeded", startedAt: t1, finishedAt: t2, createdAt: t1 },
    { id: failedRunId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "failed", startedAt: t1, finishedAt: t2, errorCode: "process_lost", createdAt: t1 },
  ]);
  return { companyId, ownerAgentId, missionId, sourceIssueId: source.id, ownerActionIssueId, oversightIssueId, failedRunId, endedRunId, wakeupId };
}

async function addWakeup(
  db: ReturnType<typeof createDb>, f: Fixture, status: string, runId: string | null,
  times: { createdAt?: Date; requestedAt?: Date; updatedAt?: Date } = {},
) {
  const requestedAt = times.requestedAt ?? t1;
  await db.insert(agentWakeupRequests).values({
    id: f.wakeupId, companyId: f.companyId, agentId: f.ownerAgentId,
    source: "test", reason: "oversight fixture", status, runId,
    issueId: f.oversightIssueId, missionId: f.missionId,
    createdAt: times.createdAt ?? requestedAt, requestedAt, updatedAt: times.updatedAt ?? requestedAt,
    payload: { issueId: f.oversightIssueId },
  });
}

async function reportRows(db: ReturnType<typeof createDb>, f: Fixture) {
  const [activities, transitions] = await Promise.all([
    db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, f.ownerActionIssueId))),
    db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, f.companyId), eq(workflowTransitionEvents.missionId, f.missionId), eq(workflowTransitionEvents.issueId, f.ownerActionIssueId), eq(workflowTransitionEvents.eventType, reportEventType))),
  ]);
  return { activities, transitions };
}

async function supervise(db: ReturnType<typeof createDb>, f: Fixture) {
  return missionService(db).runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:10:00.000Z") });
}

async function seedOutOfScopeWakeups(db: ReturnType<typeof createDb>, f: Fixture) {
  const sameMissionId = randomUUID(), foreignCompanyId = randomUUID(), foreignAgentId = randomUUID();
  const foreignMissionId = randomUUID(), sameIssueId = randomUUID(), foreignIssueId = randomUUID();
  const foreignPrefix = "FX" + foreignCompanyId.slice(0, 6).toUpperCase();
  await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign fixture", issuePrefix: foreignPrefix, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values([
    { id: sameMissionId, companyId: f.companyId, ownerAgentId: f.ownerAgentId, title: "Other mission", status: "active" },
    { id: foreignMissionId, companyId: foreignCompanyId, ownerAgentId: foreignAgentId, title: "Foreign mission", status: "active" },
  ]);
  await db.insert(issues).values([
    { id: sameIssueId, companyId: f.companyId, missionId: sameMissionId, identifier: "OTHER-1", title: "Other mission issue", status: "todo", assigneeAgentId: f.ownerAgentId, originKind: "mission_main_executor_oversight" },
    { id: foreignIssueId, companyId: foreignCompanyId, missionId: foreignMissionId, identifier: foreignPrefix + "-1", title: "Foreign issue", status: "todo", assigneeAgentId: foreignAgentId, originKind: "mission_main_executor_oversight" },
  ]);
  await db.insert(agentWakeupRequests).values([
    { companyId: f.companyId, agentId: f.ownerAgentId, issueId: sameIssueId, missionId: sameMissionId, source: "test", status: "queued", createdAt: t1, requestedAt: t1, updatedAt: t1 },
    { companyId: foreignCompanyId, agentId: foreignAgentId, issueId: foreignIssueId, missionId: foreignMissionId, source: "test", status: "queued", createdAt: t1, requestedAt: t1, updatedAt: t1 },
  ]);
  return [sameIssueId, foreignIssueId];
}

async function addWorkflowFailure(db: ReturnType<typeof createDb>, f: Fixture) {
  const workflowId = randomUUID(), runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId: f.companyId, name: "Failed workflow", stepsJson: [{ id: "tool", name: "Tool", dependencies: [] }] });
  await db.insert(workflowRuns).values({ id: runId, workflowId, companyId: f.companyId, missionId: f.missionId, status: "failed", triggeredBy: "system", completedAt: t2 });
  await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "tool", status: "failed" });
  return runId;
}

const helperIssueId = "oversight-issue";
type DecisionCase = {
  name: string; status?: string; origin?: string; runStatus?: string;
  finishedAt?: Date | null; linked?: "known" | "unknown"; updatedAt?: Date;
  inScope?: boolean; empty?: boolean; locked?: boolean; expected: boolean;
};
function helperKeepsLive(c: DecisionCase): boolean {
  const runId = "known-run", issueId = c.inScope === false ? "foreign-issue" : helperIssueId;
  const runs = c.runStatus ? [{ id: runId, issueId: helperIssueId, status: c.runStatus, finishedAt: c.finishedAt === undefined ? t2 : c.finishedAt }] : [];
  const wakeups = c.empty ? [] : [{ issueId, status: c.status ?? "deferred_issue_execution", runId: c.linked === "known" ? runId : c.linked === "unknown" ? "missing-run" : null, createdAt: t1, requestedAt: t1, updatedAt: c.updatedAt ?? t1 }];
  const scopedIssue = { id: helperIssueId, originKind: c.origin ?? "mission_main_executor_oversight", checkoutRunId: null, executionRunId: null, executionLockedAt: c.locked ? t1 : null };
  return buildTerminalAlertLiveWakeupIssueIds({
    wakeups, missionIssueById: c.inScope === false ? new Map() : new Map([[helperIssueId, scopedIssue as never]]),
    heartbeatRunsByIssueId: new Map([[helperIssueId, runs]]) as never,
  }).has(helperIssueId);
}

describe("terminal alert wakeup liveness decision table", () => {
  const cases: DecisionCase[] = [
    { name: "empty input", empty: true, expected: false },
    { name: "foreign issue excluded by mission scope", inScope: false, expected: false },
    { name: "queued request", status: "queued", expected: true },
    { name: "same-issue running heartbeat", runStatus: "running", expected: true },
    { name: "coalesced linked run unknown", status: "coalesced", linked: "unknown", expected: true },
    { name: "deferred with unknown run", expected: true },
    { name: "deferred terminal run missing finish time", runStatus: "failed", finishedAt: null, expected: true },
    { name: "deferred invalid request timestamp", runStatus: "succeeded", updatedAt: new Date(Number.NaN), expected: true },
    { name: "deferred execution lock", runStatus: "succeeded", locked: true, expected: true },
    { name: "non-oversight deferred", origin: "workflow_execution", runStatus: "succeeded", expected: true },
    { name: "deferred terminal finish equals request update", runStatus: "succeeded", updatedAt: t2, expected: true },
    { name: "deferred terminal finish is later than update", runStatus: "succeeded", expected: false },
    ...["succeeded", "failed", "timed_out", "cancelled"].map((runStatus) => ({
      name: "coalesced receipt linked to " + runStatus, status: "coalesced", linked: "known" as const, runStatus, expected: false,
    })),
  ];
  it.each(cases)("$name", (c) => expect(helperKeepsLive(c)).toBe(c.expected));
});

describeDb("terminal alert wakeup liveness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-alert-liveness-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterEach(async () => {
    await db.delete(workflowTransitionEvents); await db.delete(issueComments); await db.delete(activityLog);
    await db.delete(workflowStepRuns); await db.delete(workflowRuns); await db.delete(workflowDefinitions);
    await db.delete(heartbeatRuns); await db.delete(agentWakeupRequests); await db.delete(issues);
    await db.delete(missions); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("alerts once for a stranded oversight deferred wakeup", async () => {
    const f = await seedFixture(db); await addWakeup(db, f, "deferred_issue_execution", null);
    await supervise(db, f);
    const rows = await reportRows(db, f);
    expect(rows.activities).toHaveLength(1);
    expect(rows.transitions).toHaveLength(1);
    expect((rows.transitions[0]?.payload as { failedRuns?: Array<{ id: string }> }).failedRuns).toEqual([expect.objectContaining({ id: f.failedRunId })]);
  });

  it("alerts once for a coalesced receipt linked to a terminal run", async () => {
    const f = await seedFixture(db); await addWakeup(db, f, "coalesced", f.endedRunId);
    await supervise(db, f);
    const rows = await reportRows(db, f);
    expect(rows.activities).toHaveLength(1);
    expect(rows.transitions).toHaveLength(1);
  });

  it.each([["queued wakeup", "queued"], ["running same-issue heartbeat", "deferred_issue_execution"]])("suppresses while %s remains live", async (_name, status) => {
    const f = await seedFixture(db); await addWakeup(db, f, status, null);
    if (status === "deferred_issue_execution") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.ownerAgentId, issueId: f.oversightIssueId, status: "running", startedAt: t2 });
    await supervise(db, f);
    expect((await reportRows(db, f)).activities).toHaveLength(0);
  });

  it.each([["equal", t2, 0], ["strictly later", t3, 1]])("boundary: terminal finish %s than max request time", async (_name, finishedAt, count) => {
    const f = await seedFixture(db);
    await db.update(heartbeatRuns).set({ finishedAt }).where(eq(heartbeatRuns.id, f.endedRunId));
    await addWakeup(db, f, "deferred_issue_execution", null, { createdAt: t1, requestedAt: t2, updatedAt: t2 });
    await supervise(db, f);
    expect((await reportRows(db, f)).activities).toHaveLength(count);
  });

  it("keeps non-oversight deferred work suppressing", async () => {
    const f = await seedFixture(db);
    await db.update(issues).set({ originKind: "workflow_execution" }).where(eq(issues.id, f.oversightIssueId));
    await addWakeup(db, f, "deferred_issue_execution", null); await supervise(db, f);
    expect((await reportRows(db, f)).activities).toHaveLength(0);
  });

  it("excludes wakeups from another mission or company", async () => {
    const f = await seedFixture(db), outOfScopeIds = await seedOutOfScopeWakeups(db, f);
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });
    for (const id of outOfScopeIds) {
      expect(context.liveWakeupIssueIds.has(id)).toBe(false);
      expect(context.terminalAlertLiveWakeupIssueIds.has(id)).toBe(false);
    }
  });

  it("reports a fresh whole-workflow failure with the synthetic run id once", async () => {
    const f = await seedFixture(db); await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.failedRunId));
    await addWakeup(db, f, "deferred_issue_execution", null);
    const runId = await addWorkflowFailure(db, f);
    await supervise(db, f); await supervise(db, f);
    const rows = await reportRows(db, f);
    expect(rows.activities).toHaveLength(1); expect(rows.transitions).toHaveLength(1);
    expect(rows.transitions[0]?.workflowRunId).toBe(runId);
    expect(rows.transitions[0]?.payload).toMatchObject({ failedRuns: [{ id: runId, status: "failed", errorCode: "workflow_run_failed" }] });
  });

  it("dedupes the same historic snapshot when supervision repeats after an old wakeup", async () => {
    const f = await seedFixture(db); await supervise(db, f);
    await addWakeup(db, f, "deferred_issue_execution", null); await supervise(db, f);
    const rows = await reportRows(db, f);
    expect(rows.activities).toHaveLength(1); expect(rows.transitions).toHaveLength(1);
    expect(rows.transitions[0]?.idempotencyKey).toBeTruthy();
  });

  it.each(["completed", "cancelled"])("suppresses alerts for a %s mission without producing an anchor", async (status) => {
    const f = await seedFixture(db); await addWakeup(db, f, "deferred_issue_execution", null);
    await db.update(missions).set({ status }).where(eq(missions.id, f.missionId));
    const [beforeMission] = await db.select({ status: missions.status }).from(missions).where(eq(missions.id, f.missionId));
    await supervise(db, f);
    const [afterMission] = await db.select({ status: missions.status }).from(missions).where(eq(missions.id, f.missionId));
    expect(afterMission?.status).toBe(beforeMission?.status);
    expect(afterMission?.status).toBe(status);
    // Supervision may diagnose, but terminal missions must not produce anchors or alerts.
    const rows = await reportRows(db, f);
    expect(rows.activities).toHaveLength(0);
    expect(rows.transitions).toHaveLength(0);
  });
});
