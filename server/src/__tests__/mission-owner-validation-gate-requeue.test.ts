import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping validation gate requeue tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

async function insertAgent(db: Db, input: { id: string; companyId: string; name: string; role: string }) {
  await db.insert(agents).values({
    id: input.id,
    companyId: input.companyId,
    name: input.name,
    role: input.role,
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
}

/** Official workflow_api verdict: same-company/same-QA-issue heartbeat + exact run/step binding. */
async function insertOfficialQaVerdict(db: Db, input: {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  qaIssueId: string;
  qaAgentId: string;
  verdict: "pass" | "request_changes";
  createdAt: Date;
}) {
  const [qaHeartbeat] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId,
    agentId: input.qaAgentId,
    issueId: input.qaIssueId,
    status: "succeeded",
    startedAt: input.createdAt,
    finishedAt: input.createdAt,
  }).returning({ id: heartbeatRuns.id });
  await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    issueId: input.qaIssueId,
    heartbeatRunId: qaHeartbeat!.id,
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    decision: input.verdict,
    reason: "workflow_api",
    reasonCode: "workflow_api",
    idempotencyKey: `validation-gate-requeue:${input.workflowStepRunId}:${input.verdict}:${input.createdAt.toISOString()}`,
    payload: {
      kind: "workflow_validation_verdict",
      workflowRunId: input.workflowRunId,
      stepRunId: input.workflowStepRunId,
      issueId: input.qaIssueId,
      verdict: input.verdict,
    },
    createdAt: input.createdAt,
  });
  return qaHeartbeat!.id;
}

async function seedApprovalWithReadabilityGate(db: Db, input: {
  productUpdatedAt: Date;
  verdictCreatedAt: Date;
  /** Display-only QA comment body; never execution authority. null = no comment. */
  displayVerdictComment?: string | null;
  heartbeatFinishedAt?: Date;
}) {
  const ids = {
    companyId: randomUUID(),
    missionId: randomUUID(),
    ownerAgentId: randomUUID(),
    producerAgentId: randomUUID(),
    qaAgentId: randomUUID(),
    approvalAgentId: randomUUID(),
    workflowId: randomUUID(),
    workflowRunId: randomUUID(),
    producerIssueId: randomUUID(),
    qaIssueId: randomUUID(),
    qaStepRunId: randomUUID(),
    approvalIssueId: randomUUID(),
    ownerActionId: randomUUID(),
    oversightIssueId: randomUUID(),
  };
  await db.insert(companies).values({ id: ids.companyId, name: "RES Company", issuePrefix: "RES", requireBoardApprovalForNewAgents: false });
  await insertAgent(db, { id: ids.ownerAgentId, companyId: ids.companyId, name: "Mission Owner", role: "ceo" });
  await insertAgent(db, { id: ids.producerAgentId, companyId: ids.companyId, name: "Research Writer", role: "writer" });
  await insertAgent(db, { id: ids.qaAgentId, companyId: ids.companyId, name: "Readability QA", role: "qa" });
  await insertAgent(db, { id: ids.approvalAgentId, companyId: ids.companyId, name: "Research Director", role: "director" });
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, ids.approvalAgentId));
  await db.insert(missions).values({ id: ids.missionId, companyId: ids.companyId, ownerAgentId: ids.ownerAgentId, title: "Beginner readability mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: ids.workflowId,
    companyId: ids.companyId,
    name: "Beginner readability workflow",
    stepsJson: [
      { id: "write-report", name: "Write report", agentId: ids.producerAgentId, dependencies: [] },
      { id: "validate-readability", name: "Validate beginner readability", type: "qa", agentId: ids.qaAgentId, dependencies: ["write-report"] },
      { id: "lead-approval", name: "Lead approval", type: "approval", agentId: ids.approvalAgentId, dependencies: ["validate-readability"] },
    ],
  });
  await db.insert(workflowRuns).values({ id: ids.workflowRunId, workflowId: ids.workflowId, companyId: ids.companyId, missionId: ids.missionId, status: "running", triggeredBy: "mission" });
  await db.insert(issues).values([
    { id: ids.producerIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "RES-881 report", identifier: "RES-881", status: "done", assigneeAgentId: ids.producerAgentId, originKind: "workflow_execution", originId: ids.workflowRunId, completedAt: input.productUpdatedAt },
    { id: ids.qaIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "RES-883 Validate beginner readability", identifier: "RES-883", status: "done", assigneeAgentId: ids.qaAgentId, originKind: "workflow_execution", originId: ids.workflowRunId, startedAt: new Date("2026-07-04T01:00:00.000Z"), completedAt: input.verdictCreatedAt },
    { id: ids.approvalIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "RES-884 Lead approval", identifier: "RES-884", status: "blocked", assigneeAgentId: ids.approvalAgentId, originKind: "workflow_execution", originId: ids.workflowRunId },
    { id: ids.ownerActionId, companyId: ids.companyId, missionId: ids.missionId, title: "[UNBLOCK] RES-884", identifier: "RES-885", status: "done", assigneeAgentId: ids.ownerAgentId, originKind: "mission_main_executor_unblock", originId: ids.approvalIssueId },
    { id: ids.oversightIssueId, companyId: ids.companyId, missionId: ids.missionId, title: "[OVERSIGHT] Beginner readability mission", identifier: "RES-877", status: "todo", assigneeAgentId: ids.ownerAgentId, originKind: "mission_main_executor_oversight" },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: randomUUID(), workflowRunId: ids.workflowRunId, stepId: "write-report", issueId: ids.producerIssueId, status: "completed", completedAt: input.productUpdatedAt },
    { id: ids.qaStepRunId, workflowRunId: ids.workflowRunId, stepId: "validate-readability", issueId: ids.qaIssueId, status: "completed", completedAt: input.verdictCreatedAt },
    { id: randomUUID(), workflowRunId: ids.workflowRunId, stepId: "lead-approval", issueId: ids.approvalIssueId, status: "failed" },
  ]);
  await db.insert(issueWorkProducts).values({
    companyId: ids.companyId,
    issueId: ids.producerIssueId,
    type: "artifact",
    provider: "local",
    title: "report.md",
    status: "ready",
    isPrimary: true,
    metadata: { path: "/tmp/report.md" },
    updatedAt: input.productUpdatedAt,
  });
  if (input.heartbeatFinishedAt) {
    // Non-authoritative succeeded QA heartbeat (no structured verdict event).
    await db.insert(heartbeatRuns).values({
      companyId: ids.companyId,
      agentId: ids.qaAgentId,
      issueId: ids.qaIssueId,
      status: "succeeded",
      resultJson: { result: "Validation completed without an explicit final verdict." },
      finishedAt: input.heartbeatFinishedAt,
      createdAt: input.heartbeatFinishedAt,
    });
  }
  // Display-only owner decision comment; structured ledger is recorded below.
  await db.insert(issueComments).values({
    companyId: ids.companyId,
    issueId: ids.ownerActionId,
    authorAgentId: ids.ownerAgentId,
    body: ["### Mission owner decision", "Decision: retry_source_issue", "Source issue: RES-884", "Reason: approval is blocked; retry after artifact revision"].join("\n"),
  });
  const ownerRunFinishedAt = new Date("2026-07-04T01:25:00.000Z");
  const [ownerHeartbeatRun] = await db.insert(heartbeatRuns).values({
    companyId: ids.companyId,
    agentId: ids.ownerAgentId,
    issueId: ids.ownerActionId,
    status: "succeeded",
    startedAt: ownerRunFinishedAt,
    finishedAt: ownerRunFinishedAt,
  }).returning({ id: heartbeatRuns.id });
  await recordMissionOwnerDecision({
    db,
    issue: { id: ids.ownerActionId, companyId: ids.companyId, missionId: ids.missionId },
    submission: {
      decision: "retry_source_issue",
      sourceIssueRef: "RES-884",
      reason: "approval is blocked; retry after artifact revision",
    },
    sourceIssueId: ids.approvalIssueId,
    heartbeatRunId: ownerHeartbeatRun!.id,
  });
  if (input.displayVerdictComment !== null && input.displayVerdictComment !== undefined) {
    await db.insert(issueComments).values({
      companyId: ids.companyId,
      issueId: ids.qaIssueId,
      authorAgentId: ids.qaAgentId,
      body: input.displayVerdictComment,
      createdAt: input.verdictCreatedAt,
    });
  }
  return ids;
}

async function runSupervision(db: Db, missionId: string) {
  const wakeups: Array<{ sourceIssueId: string; targetAgentId: string }> = [];
  const svc = missionService(db, {
    onOwnerDecisionRetrySourceIssueApplied: vi.fn((input) => {
      wakeups.push({ sourceIssueId: input.sourceIssue.id, targetAgentId: input.targetAgentId });
      return { status: "dispatched" as const };
    }),
  });
  const result = await svc.runMainExecutorSupervision({
    missionId,
    now: new Date("2026-07-04T01:30:00.000Z"),
    applyOwnerDecisionActions: true,
    dispatchOwnerDecisionWakeups: true,
  });
  return { result, wakeups };
}

describeEmbeddedPostgres("mission owner validation gate requeue", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-validation-gate-requeue-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("requeues an upstream QA gate instead of waking a blocked approval issue without a fresh PASS", async () => {
    const ids = await seedApprovalWithReadabilityGate(db, {
      productUpdatedAt: new Date("2026-07-04T01:20:00.000Z"),
      verdictCreatedAt: new Date("2026-07-04T01:10:00.000Z"),
      displayVerdictComment: "REQUEST_CHANGES: add a glossary before approval.",
    });
    const { result, wakeups } = await runSupervision(db, ids.missionId);

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, ids.qaIssueId));
    const [approvalIssue] = await db.select().from(issues).where(eq(issues.id, ids.approvalIssueId));
    const approvalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, ids.approvalIssueId));

    expect(wakeups).toEqual([{ sourceIssueId: ids.qaIssueId, targetAgentId: ids.qaAgentId }]);
    expect(qaIssue).toEqual(expect.objectContaining({ status: "todo", completedAt: null }));
    expect(approvalIssue).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(approvalComments.map((comment) => comment.body).join("\n")).not.toContain("Mission owner retry applied");
    expect(result.findings.join("\n")).toContain("owner_action_validation_gate_not_passed");
    expect(result.appliedActions).toContainEqual(expect.objectContaining({ sourceIssueId: ids.qaIssueId, resultStatus: "todo" }));
  });

  it("keeps an official structured REQUEST_CHANGES authoritative over a PASS comment", async () => {
    const ids = await seedApprovalWithReadabilityGate(db, {
      productUpdatedAt: new Date("2026-07-04T01:10:00.000Z"),
      verdictCreatedAt: new Date("2026-07-04T01:20:00.000Z"),
      displayVerdictComment: "PASS",
    });
    await insertOfficialQaVerdict(db, {
      companyId: ids.companyId,
      missionId: ids.missionId,
      workflowRunId: ids.workflowRunId,
      workflowStepRunId: ids.qaStepRunId,
      qaIssueId: ids.qaIssueId,
      qaAgentId: ids.qaAgentId,
      verdict: "request_changes",
      createdAt: new Date("2026-07-04T01:19:00.000Z"),
    });
    const { result, wakeups } = await runSupervision(db, ids.missionId);

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, ids.qaIssueId));
    const [approvalIssue] = await db.select().from(issues).where(eq(issues.id, ids.approvalIssueId));
    const approvalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, ids.approvalIssueId));

    // Fresh structured RC blocks approval retry (does not requeue; waits for PASS or producer rework).
    expect(wakeups).toEqual([]);
    expect(qaIssue).toEqual(expect.objectContaining({ status: "done" }));
    expect(approvalIssue).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(approvalComments.map((comment) => comment.body).join("\n")).toContain("Mission owner retry blocked by validation gate");
    expect(result.findings.join("\n")).toContain("owner_action_validation_gate_retry_blocked");
    expect(result.appliedActions.some((action) => action.type === "owner_decision_retry_source_issue")).toBe(false);
  });

  it("requeues QA when only a PASS comment exists (comment is not authority)", async () => {
    const ids = await seedApprovalWithReadabilityGate(db, {
      productUpdatedAt: new Date("2026-07-04T01:10:00.000Z"),
      verdictCreatedAt: new Date("2026-07-04T01:20:00.000Z"),
      displayVerdictComment: "PASS",
    });
    const { result, wakeups } = await runSupervision(db, ids.missionId);

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, ids.qaIssueId));
    const [approvalIssue] = await db.select().from(issues).where(eq(issues.id, ids.approvalIssueId));

    expect(wakeups).toEqual([{ sourceIssueId: ids.qaIssueId, targetAgentId: ids.qaAgentId }]);
    expect(qaIssue).toEqual(expect.objectContaining({ status: "todo", completedAt: null }));
    expect(approvalIssue).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(result.findings.join("\n")).toContain("owner_action_validation_gate_not_passed");
    expect(result.appliedActions).toContainEqual(expect.objectContaining({ sourceIssueId: ids.qaIssueId, resultStatus: "todo" }));
  });

  it("requeues QA after a succeeded QA heartbeat with no structured verdict", async () => {
    const ids = await seedApprovalWithReadabilityGate(db, {
      productUpdatedAt: new Date("2026-07-04T01:10:00.000Z"),
      verdictCreatedAt: new Date("2026-07-04T01:20:00.000Z"),
      displayVerdictComment: null,
      heartbeatFinishedAt: new Date("2026-07-04T01:20:00.000Z"),
    });
    const { result, wakeups } = await runSupervision(db, ids.missionId);

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, ids.qaIssueId));
    const [approvalIssue] = await db.select().from(issues).where(eq(issues.id, ids.approvalIssueId));

    expect(wakeups).toEqual([{ sourceIssueId: ids.qaIssueId, targetAgentId: ids.qaAgentId }]);
    expect(qaIssue).toEqual(expect.objectContaining({ status: "todo", completedAt: null }));
    expect(approvalIssue).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(result.findings.join("\n")).toContain("owner_action_validation_gate_not_passed");
    expect(result.appliedActions).toContainEqual(expect.objectContaining({ sourceIssueId: ids.qaIssueId, resultStatus: "todo" }));
  });

  it("allows the approval retry from an official structured PASS ledger event", async () => {
    const ids = await seedApprovalWithReadabilityGate(db, {
      productUpdatedAt: new Date("2026-07-04T01:10:00.000Z"),
      verdictCreatedAt: new Date("2026-07-04T01:20:00.000Z"),
      displayVerdictComment: null,
    });
    await insertOfficialQaVerdict(db, {
      companyId: ids.companyId,
      missionId: ids.missionId,
      workflowRunId: ids.workflowRunId,
      workflowStepRunId: ids.qaStepRunId,
      qaIssueId: ids.qaIssueId,
      qaAgentId: ids.qaAgentId,
      verdict: "pass",
      createdAt: new Date("2026-07-04T01:20:00.000Z"),
    });

    const { result, wakeups } = await runSupervision(db, ids.missionId);
    const [approvalIssue] = await db.select().from(issues).where(eq(issues.id, ids.approvalIssueId));

    expect(wakeups).toEqual([{ sourceIssueId: ids.approvalIssueId, targetAgentId: ids.approvalAgentId }]);
    expect(approvalIssue).toEqual(expect.objectContaining({ status: "todo", completedAt: null }));
    expect(result.appliedActions).toContainEqual(expect.objectContaining({ sourceIssueId: ids.approvalIssueId, resultStatus: "todo" }));
  });
});
