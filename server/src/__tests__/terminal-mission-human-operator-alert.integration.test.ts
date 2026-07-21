import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { issueService } from "../services/issues.js";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping terminal-mission integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const REPORT_EVENT_TYPE = "terminal_mission_human_operator_report";

type Seed = {
  companyId: string;
  ownerAgentId: string;
  workerAgentId: string;
  missionId: string;
  sourceIssueId: string;
  ownerActionIssueId: string;
  failedRunId: string;
  issuePrefix: string;
};

async function seedTerminalFixture(db: ReturnType<typeof createDb>): Promise<Seed> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const workerAgentId = randomUUID();
  const missionId = randomUUID();
  const sourceIssueId = randomUUID();
  const ownerActionIssueId = randomUUID();
  const failedRunId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({ id: companyId, name: "Terminal Co", issuePrefix, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  ]);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Terminal failure mission", status: "active" });
  const sourceIssue = await issueService(db).create(companyId, {
    assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source",
  });
  await db.insert(issues).values({
    id: ownerActionIssueId, companyId, missionId, identifier: `${issuePrefix}-${ownerActionIssueId.slice(0, 8)}`, title: "[Unblock] source",
    status: "blocked", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id,
  });
  await db.insert(heartbeatRuns).values({
    id: failedRunId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "failed",
    startedAt: new Date("2026-07-01T00:01:00.000Z"), finishedAt: new Date("2026-07-01T00:02:00.000Z"),
    error: "Process lost raw stderr leak", errorCode: "process_lost",
  });
  return { companyId, ownerAgentId, workerAgentId, missionId, sourceIssueId: sourceIssue.id, ownerActionIssueId, failedRunId, issuePrefix };
}

async function countReportArtifacts(db: ReturnType<typeof createDb>, issueId: string) {
  const [events, comments, audits] = await Promise.all([
    db.select().from(activityLog).where(eq(activityLog.entityId, issueId)).then((rows) => rows.filter((r) => r.action === HUMAN_OPERATOR_REQUEST_ACTION)),
    db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).then((rows) => rows.filter((c) => c.body.includes("Decision: escalate"))),
    db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE), eq(workflowTransitionEvents.correlationId, issueId))),
  ]);
  return { events: events.length, comments: comments.length, audits: audits.length, eventRows: events, commentRows: comments };
}

describeEmbeddedPostgres("terminal-mission Human Operator report (corrected production path)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-mission-alert-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("emits exactly one system-authored Human Operator request for a truly-terminal snapshot", async () => {
    const seed = await seedTerminalFixture(db);
    const svc = missionService(db);

    const before = await countReportArtifacts(db, seed.ownerActionIssueId);
    expect(before.events).toBe(0);

    const result = await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:10:00.000Z") });
    expect(result.findings).toEqual(expect.arrayContaining([expect.stringContaining("terminal_mission_human_operator_request_emitted")]));

    const after = await countReportArtifacts(db, seed.ownerActionIssueId);
    expect(after.events).toBe(1);
    expect(after.comments).toBe(1);
    expect(after.audits).toBe(1);
    // system-authored + sanitized (no raw stderr leak).
    expect(after.eventRows[0]?.actorType).toBe("system");
    expect(after.eventRows[0]?.agentId).toBeNull();
    expect(after.commentRows[0]?.body).not.toContain("Process lost raw stderr leak");
    expect(after.commentRows[0]?.body).not.toContain("{");
    expect(after.commentRows[0]?.authorAgentId).toBeNull();
  });

  it("reports a terminal failed workflow even when no owner-action run failed", async () => {
    const seed = await seedTerminalFixture(db);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, seed.failedRunId));
    await db.delete(issues).where(eq(issues.id, seed.ownerActionIssueId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seed.sourceIssueId));

    const definitionId = randomUUID();
    const workflowRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: definitionId,
      companyId: seed.companyId,
      name: "gazua-morning terminal failure",
      stepsJson: [
        {
          id: "materialize-html-report",
          name: "Materialize HTML report",
          dependencies: [],
          conditionalDependencies: [{ stepId: "inspection", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
        },
        { id: "inspection", name: "Independent inspection", dependencies: ["materialize-html-report"] },
        { id: "sync-dashboard", name: "Sync dashboard", dependencies: ["inspection"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId: definitionId,
      companyId: seed.companyId,
      missionId: seed.missionId,
      status: "failed",
      triggeredBy: "system",
      completedAt: new Date("2026-07-01T00:08:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      { id: randomUUID(), workflowRunId, stepId: "materialize-html-report", status: "completed", iterationIndex: 2 },
      { id: randomUUID(), workflowRunId, stepId: "inspection", issueId: seed.sourceIssueId, status: "failed" },
      { id: randomUUID(), workflowRunId, stepId: "sync-dashboard", status: "skipped" },
    ]);

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const result = await svc.runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T00:10:00.000Z"),
    });
    await svc.runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T00:11:00.000Z"),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("terminal_mission_human_operator_request_emitted"),
    ]));
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
    const ownerActions = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, seed.companyId),
        eq(issues.missionId, seed.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, seed.sourceIssueId),
      ));
    expect(ownerActions).toHaveLength(1);
    const [ownerAction] = ownerActions;
    expect(ownerAction).toBeDefined();
    const artifacts = await countReportArtifacts(db, ownerAction!.id);
    expect(artifacts.events).toBe(1);
    expect(artifacts.comments).toBe(1);
    expect(artifacts.audits).toBe(1);
    const [report] = await db
      .select({ workflowRunId: workflowTransitionEvents.workflowRunId, payload: workflowTransitionEvents.payload })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE));
    expect(report?.workflowRunId).toBe(workflowRunId);
    expect((report?.payload as { failedRuns?: Array<{ id: string }> } | null)?.failedRuns).toEqual([
      expect.objectContaining({ id: workflowRunId }),
    ]);
  });

  it("is idempotent for the same terminal snapshot across repeated supervision runs", async () => {
    const seed = await seedTerminalFixture(db);
    const svc = missionService(db);
    for (let i = 0; i < 3; i++) {
      await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date(`2026-07-01T0${1 + i}:10:00.000Z`) });
    }
    const after = await countReportArtifacts(db, seed.ownerActionIssueId);
    expect(after.events).toBe(1);
    expect(after.comments).toBe(1);
    expect(after.audits).toBe(1);
  });

  it("reports again for a later distinct terminal generation", async () => {
    const seed = await seedTerminalFixture(db);
    const svc = missionService(db);
    await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:10:00.000Z") });
    // a new terminal failed run arrives (distinct generation) → new snapshot key → may report again.
    const newFailedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newFailedRunId, companyId: seed.companyId, agentId: seed.ownerAgentId, issueId: seed.ownerActionIssueId, status: "timed_out",
      startedAt: new Date("2026-07-01T01:01:00.000Z"), finishedAt: new Date("2026-07-01T01:02:00.000Z"), errorCode: "execution_stale_timeout",
    });
    await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T01:10:00.000Z") });
    const after = await countReportArtifacts(db, seed.ownerActionIssueId);
    expect(after.audits).toBe(2);
    expect(after.events).toBe(2);
  });

  it("emits exactly one report under concurrent supervision (Promise.all)", async () => {
    const seed = await seedTerminalFixture(db);
    const { emitTerminalMissionHumanOperatorReport } = await import("../services/missions/terminal-mission-human-operator-alert.js");
    const issue = {
      id: seed.ownerActionIssueId, companyId: seed.companyId, missionId: seed.missionId,
      originKind: "mission_main_executor_unblock", originId: seed.sourceIssueId, title: "[Unblock]", identifier: "T1",
    };
    const failedRuns = [{ id: seed.failedRunId, status: "failed", errorCode: "process_lost" }];
    const [a, b] = await Promise.all([
      emitTerminalMissionHumanOperatorReport(db, {
        issue,
        expectedCompanyId: seed.companyId,
        expectedMissionId: seed.missionId,
        missionTitle: "m",
        sourceIssueIdentifier: "S",
        workflowRunId: null,
        failedRuns,
      }),
      emitTerminalMissionHumanOperatorReport(db, {
        issue,
        expectedCompanyId: seed.companyId,
        expectedMissionId: seed.missionId,
        missionTitle: "m",
        sourceIssueIdentifier: "S",
        workflowRunId: null,
        failedRuns,
      }),
    ]);
    expect([a.emitted, b.emitted].filter(Boolean)).toHaveLength(1);
    const after = await countReportArtifacts(db, seed.ownerActionIssueId);
    expect(after.audits).toBe(1);
    expect(after.events).toBe(1);
    expect(after.comments).toBe(1);
  });

  it("suppresses while an active heartbeat run remains", async () => {
    const seed = await seedTerminalFixture(db);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: seed.companyId, agentId: seed.workerAgentId, issueId: seed.sourceIssueId,
      status: "running", startedAt: new Date("2026-07-01T00:09:00.000Z"),
    });
    const result = await missionService(db).runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:10:00.000Z") });
    expect(result.findings).toEqual(expect.arrayContaining([expect.stringContaining("terminal_mission_human_operator_request_suppressed")]));
    expect((await countReportArtifacts(db, seed.ownerActionIssueId)).events).toBe(0);
  });

  it("suppresses while a runnable failure-edge workflow step remains", async () => {
    const seed = await seedTerminalFixture(db);
    const defId = randomUUID();
    const runId = randomUUID();
    const steps = [
      { id: "produce", name: "Produce", dependencies: [] },
      { id: "rescue", name: "Rescue", dependencies: [], conditionalDependencies: [{ stepId: "produce", when: "failure" }] },
    ];
    await db.insert(workflowDefinitions).values({ id: defId, companyId: seed.companyId, name: "produce+rescue", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, workflowId: defId, companyId: seed.companyId, missionId: seed.missionId, status: "running", triggeredBy: "system" });
    await db.insert(workflowStepRuns).values([
      { id: randomUUID(), workflowRunId: runId, stepId: "produce", issueId: seed.sourceIssueId, status: "failed" },
      { id: randomUUID(), workflowRunId: runId, stepId: "rescue", status: "pending" },
    ]);
    const result = await missionService(db).runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:10:00.000Z") });
    expect(result.findings).toEqual(expect.arrayContaining([expect.stringContaining("terminal_mission_human_operator_request_suppressed")]));
    expect((await countReportArtifacts(db, seed.ownerActionIssueId)).events).toBe(0);
  });

  it("flags a freshly-created blocked owner-action with a failed run for supervision (no createdAt delay)", async () => {
    const seed = await seedTerminalFixture(db);
    const svc = missionService(db);
    const active = await svc.runActiveMissionOwnerSupervision({ companyId: seed.companyId, staleAfterMinutes: 1, now: new Date("2026-07-01T00:00:30.000Z") });
    expect(active.missionIds).toContain(seed.missionId);
    expect((await countReportArtifacts(db, seed.ownerActionIssueId)).events).toBe(1);
  });

  it("keeps terminal evidence separated by workflow run", async () => {
    const seed = await seedTerminalFixture(db);
    const secondSource = await issueService(db).create(seed.companyId, {
      assigneeAgentId: seed.workerAgentId,
      missionId: seed.missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Second blocked source",
    });
    const secondOwnerActionId = "00000000-0000-4000-8000-000000000001";
    const secondFailedRunId = randomUUID();
    await db.insert(issues).values({
      id: secondOwnerActionId,
      companyId: seed.companyId,
      missionId: seed.missionId,
      identifier: `${seed.issuePrefix}-SECOND`,
      title: "[Unblock] second source",
      status: "blocked",
      assigneeAgentId: seed.ownerAgentId,
      originKind: "mission_main_executor_unblock",
      originId: secondSource.id,
    });
    await db.insert(heartbeatRuns).values({
      id: secondFailedRunId,
      companyId: seed.companyId,
      agentId: seed.ownerAgentId,
      issueId: secondOwnerActionId,
      status: "failed",
      startedAt: new Date("2026-07-01T00:03:00.000Z"),
      finishedAt: new Date("2026-07-01T00:04:00.000Z"),
      errorCode: "second_failure",
    });

    const firstDefinitionId = randomUUID();
    const secondDefinitionId = randomUUID();
    const firstWorkflowRunId = randomUUID();
    const secondWorkflowRunId = randomUUID();
    await db.insert(workflowDefinitions).values([
      { id: firstDefinitionId, companyId: seed.companyId, name: "first terminal run", stepsJson: [{ id: "first", name: "First", dependencies: [] }] },
      { id: secondDefinitionId, companyId: seed.companyId, name: "second terminal run", stepsJson: [{ id: "second", name: "Second", dependencies: [] }] },
    ]);
    await db.insert(workflowRuns).values([
      { id: firstWorkflowRunId, workflowId: firstDefinitionId, companyId: seed.companyId, missionId: seed.missionId, status: "failed", triggeredBy: "system" },
      { id: secondWorkflowRunId, workflowId: secondDefinitionId, companyId: seed.companyId, missionId: seed.missionId, status: "failed", triggeredBy: "system" },
    ]);
    await db.insert(workflowStepRuns).values([
      { id: randomUUID(), workflowRunId: firstWorkflowRunId, stepId: "first", issueId: seed.sourceIssueId, status: "failed" },
      { id: randomUUID(), workflowRunId: secondWorkflowRunId, stepId: "second", issueId: secondSource.id, status: "failed" },
    ]);

    await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T00:10:00.000Z"),
    });

    const reports = await db
      .select({ workflowRunId: workflowTransitionEvents.workflowRunId, payload: workflowTransitionEvents.payload })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE));
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((report) => report.workflowRunId))).toEqual(new Set([firstWorkflowRunId, secondWorkflowRunId]));
    const failedRunIdsByWorkflowRun = new Map(reports.map((report) => [
      report.workflowRunId,
      ((report.payload as { failedRuns?: Array<{ id: string }> } | null)?.failedRuns ?? []).map((run) => run.id),
    ]));
    expect(failedRunIdsByWorkflowRun.get(firstWorkflowRunId)).toEqual([seed.failedRunId]);
    expect(failedRunIdsByWorkflowRun.get(secondWorkflowRunId)).toEqual([secondFailedRunId]);
  });

  it("prefers a QA-cap owner action even when it was inserted later", async () => {
    const seed = await seedTerminalFixture(db);
    const qaCapIssueId = randomUUID();
    await db.insert(issues).values({
      id: qaCapIssueId,
      companyId: seed.companyId,
      missionId: seed.missionId,
      identifier: `${seed.issuePrefix}-QA-CAP`,
      title: "[QA Cap] owner decision required",
      description: `<!-- qa-cap-key:${"a".repeat(32)} -->`,
      status: "blocked",
      assigneeAgentId: seed.ownerAgentId,
      originKind: "mission_main_executor_unblock",
      originId: seed.sourceIssueId,
    });

    await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T00:10:00.000Z"),
    });

    expect((await countReportArtifacts(db, qaCapIssueId)).events).toBe(1);
    expect((await countReportArtifacts(db, seed.ownerActionIssueId)).events).toBe(0);
  });
});
