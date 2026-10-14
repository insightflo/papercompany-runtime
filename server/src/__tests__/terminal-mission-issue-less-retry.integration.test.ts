import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
const REPORT_EVENT_TYPE = "terminal_mission_human_operator_report";

async function seedIssueLessExhaustion(
  db: ReturnType<typeof createDb>,
  options: { includeAuthorityIssue?: boolean; maxRetries?: number } = {},
) {
  const maxRetries = options.maxRetries ?? 1;
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const authorityIssueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Issue-less terminal company",
    issuePrefix: `IL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: ownerAgentId,
    companyId,
    name: "Mission Owner",
    role: "operator",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Issue-less retry exhaustion", status: "active" });
  if (options.includeAuthorityIssue !== false) {
    await db.insert(issues).values({
      id: authorityIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      status: "todo",
      title: "[OVERSIGHT] Issue-less retry exhaustion",
      originKind: "mission_main_executor_oversight",
    });
  }
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "Issue-less tool workflow",
    stepsJson: [{ id: "tool-step", type: "tool", toolNames: ["render"], onFailure: "retry", maxRetries }],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId,
    companyId,
    missionId,
    workflowId,
    status: "failed",
    triggeredBy: "test",
    completedAt: new Date("2026-07-22T10:10:00.000Z"),
  });
  await db.insert(workflowStepRuns).values({
    id: randomUUID(),
    workflowRunId,
    stepId: "tool-step",
    issueId: null,
    status: "failed",
    retryCount: maxRetries,
    completedAt: new Date("2026-07-22T10:10:00.000Z"),
    lastDispatchErrorSummary: "raw secret error must not leak",
    metadata: {
      workflowRetryAttempts: Array.from({ length: Math.min(maxRetries + 1, 20) }, (_, retryNumber) => ({
        retryNumber,
        failedAt: `2026-07-22T10:${String(retryNumber).padStart(2, "0")}:00.000Z`,
        errorSummary: `history-${retryNumber}`,
      })),
      workflowRetryExhaustion: { attempts: maxRetries + 1, maxRetries },
    },
  });
  return { companyId, missionId, workflowRunId, authorityIssueId };
}

async function seedIssueLessConsumedRecovery(
  db: ReturnType<typeof createDb>,
  options: { cardStatus?: "done" | "todo" | "cancelled" } = {},
) {
  const cardStatus = options.cardStatus ?? "done";
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const authorityIssueId = randomUUID();
  const recoveryIssueId = randomUUID();
  const stepRunId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Issue-less consumed recovery company",
    issuePrefix: `IC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: ownerAgentId,
    companyId,
    name: "Mission Owner",
    role: "operator",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Issue-less consumed tool recovery", status: "active" });
  await db.insert(issues).values({
    id: authorityIssueId,
    companyId,
    missionId,
    assigneeAgentId: ownerAgentId,
    status: "todo",
    title: "[OVERSIGHT] Issue-less consumed tool recovery",
    originKind: "mission_main_executor_oversight",
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "Issue-less tool workflow",
    stepsJson: [{ id: "tool-step", type: "tool", toolNames: ["render"], onFailure: "retry", maxRetries: 1 }],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId,
    companyId,
    missionId,
    workflowId,
    status: "failed",
    triggeredBy: "test",
    completedAt: new Date("2026-10-14T13:21:40.000Z"),
  });
  await db.insert(workflowStepRuns).values({
    id: stepRunId,
    workflowRunId,
    stepId: "tool-step",
    issueId: null,
    status: "failed",
    completedAt: new Date("2026-10-14T13:21:40.000Z"),
    lastDispatchErrorAt: new Date("2026-10-14T13:21:40.000Z"),
    lastDispatchErrorSummary: "workproduct_selector_stale_producer",
    metadata: {
      toolInvocation: {
        dispatchError: "workproduct_selector_stale_producer",
        producerRebindDiagnostic: {
          schemaVersion: "workflow.producer-rebind-diagnostic.v1",
          outcome: "issuance-failed",
          conflictReason: "producer_rebind_bytes_changed",
        },
      },
    },
  });
  await db.insert(issues).values({
    id: recoveryIssueId,
    companyId,
    missionId,
    assigneeAgentId: ownerAgentId,
    status: cardStatus,
    title: "[Owner Action] Tool step failed: tool-step",
    originKind: "mission_main_executor_unblock",
    originId: authorityIssueId,
    ...(cardStatus === "done" || cardStatus === "cancelled" ? { completedAt: new Date("2026-10-14T13:21:25.000Z") } : {}),
  });
  await db.insert(workflowTransitionEvents).values({
    companyId,
    missionId,
    workflowRunId,
    workflowStepRunId: stepRunId,
    issueId: recoveryIssueId,
    layer: "mission_owner_recovery",
    eventType: "owner_tool_recovery_target_v1",
    idempotencyKey: `owner-tool-card:${stepRunId}`,
    payload: { schemaVersion: 1, kind: "tool_step", workflowRunId, stepRunId },
  });
  return { companyId, missionId, workflowRunId, authorityIssueId, recoveryIssueId, stepRunId, ownerAgentId };
}

describeEP("issue-less workflow retry exhaustion Human Operator reporting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-less-terminal-retry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("uses deterministic mission authority, emits one report, and stays idempotent", async () => {
    const seed = await seedIssueLessExhaustion(db);
    const svc = missionService(db);

    const first = await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-22T10:20:00.000Z") });
    const second = await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-07-22T10:21:00.000Z") });

    const ownerActions = await db.select().from(issues).where(and(
      eq(issues.companyId, seed.companyId),
      eq(issues.missionId, seed.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"),
      eq(issues.originId, seed.authorityIssueId),
    ));
    expect(ownerActions).toHaveLength(1);
    const ownerActionId = ownerActions[0]!.id;

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerActionId));
    const reports = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE),
      eq(workflowTransitionEvents.correlationId, ownerActionId),
    ));
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, ownerActionId),
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
    ));

    expect(first.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(1);
    expect(second.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(reports[0]!.workflowRunId).toBe(seed.workflowRunId);
    expect(comments[0]!.body).toContain("retry-exhausted=2/1");
    expect(comments[0]!.body).not.toContain("raw secret error must not leak");
    expect(comments[0]!.body).not.toContain("workflowRetryAttempts");
    expect(comments[0]!.body).not.toContain("workflowRetryExhaustion");
  });

  it("reports exact 26/25 counts when bounded retry history is capped at twenty", async () => {
    const seed = await seedIssueLessExhaustion(db, { maxRetries: 25 });
    await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-22T10:20:00.000Z"),
    });

    const [ownerAction] = await db.select().from(issues).where(and(
      eq(issues.companyId, seed.companyId),
      eq(issues.missionId, seed.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"),
      eq(issues.originId, seed.authorityIssueId),
    ));
    const comments = await db.select().from(issueComments).where(eq(
      issueComments.issueId,
      ownerAction.id,
    ));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("retry-exhausted=26/25");
    expect(comments[0]!.body).not.toContain("history-19");
  });
  it.each(["done", "cancelled"] as const)(
    "emits the terminal report when the linked tool recovery card is already %s",
    async (cardStatus) => {
      const seed = await seedIssueLessConsumedRecovery(db, { cardStatus });
      const svc = missionService(db);

      const first = await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-10-14T13:30:00.000Z") });
      const second = await svc.runMainExecutorSupervision({ missionId: seed.missionId, staleAfterMinutes: 1, now: new Date("2026-10-14T13:31:00.000Z") });

      expect(first.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(1);
      expect(second.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(0);

      const reports = await db.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE),
        eq(workflowTransitionEvents.correlationId, seed.recoveryIssueId),
      ));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.workflowRunId).toBe(seed.workflowRunId);

      const audits = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, seed.recoveryIssueId),
        eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
      ));
      expect(audits).toHaveLength(1);

      const unblocks = await db.select().from(issues).where(and(
        eq(issues.companyId, seed.companyId),
        eq(issues.missionId, seed.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
      ));
      expect(unblocks).toHaveLength(1);

      const operatorRequests = await listCompanyHumanOperatorRequests(db, { companyId: seed.companyId });
      expect(operatorRequests).toHaveLength(1);
      expect(operatorRequests[0]!.missionId).toBe(seed.missionId);
      expect(operatorRequests[0]!.issueId).toBe(seed.authorityIssueId);
    },
  );

  it("keeps suppressing when any linked tool recovery card remains open across failed steps", async () => {
    const seed = await seedIssueLessConsumedRecovery(db);
    const openStepRunId = randomUUID();
    const openRecoveryIssueId = randomUUID();
    await db.insert(workflowStepRuns).values({
      id: openStepRunId,
      workflowRunId: seed.workflowRunId,
      stepId: "tool-step-2",
      issueId: null,
      status: "failed",
      completedAt: new Date("2026-10-14T13:21:40.000Z"),
      lastDispatchErrorAt: new Date("2026-10-14T13:21:40.000Z"),
      lastDispatchErrorSummary: "workproduct_selector_stale_producer",
      metadata: { toolInvocation: { dispatchError: "workproduct_selector_stale_producer" } },
    });
    await db.insert(issues).values({
      id: openRecoveryIssueId,
      companyId: seed.companyId,
      missionId: seed.missionId,
      assigneeAgentId: seed.ownerAgentId,
      status: "todo",
      title: "[Owner Action] Tool step failed: tool-step-2",
      originKind: "mission_main_executor_unblock",
      originId: seed.authorityIssueId,
    });
    await db.insert(workflowTransitionEvents).values({
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.workflowRunId,
      workflowStepRunId: openStepRunId,
      issueId: openRecoveryIssueId,
      layer: "mission_owner_recovery",
      eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${openStepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: seed.workflowRunId, stepRunId: openStepRunId },
    });

    const result = await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-10-14T13:30:00.000Z"),
    });

    expect(result.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(0);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("terminal_mission_human_operator_request_suppressed"),
    ]));
    expect(await db.select().from(workflowTransitionEvents).where(
      eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE),
    )).toHaveLength(0);
  });

  it("keeps suppressing while the linked tool recovery card remains open", async () => {
    const seed = await seedIssueLessConsumedRecovery(db, { cardStatus: "todo" });
    const result = await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-10-14T13:30:00.000Z"),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("terminal_mission_human_operator_request_suppressed"),
    ]));
    expect(result.findings.filter((finding) => finding.includes("terminal_mission_human_operator_request_emitted"))).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents).where(
      eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE),
    )).toHaveLength(0);
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
    )).toHaveLength(0);
  });

  it("fails closed when no scoped mission authority issue exists", async () => {
    const seed = await seedIssueLessExhaustion(db, { includeAuthorityIssue: false });
    const result = await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-22T10:20:00.000Z"),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("terminal_mission_human_operator_request_suppressed"),
      expect.stringContaining("continuation authority uncertain"),
    ]));
    expect(await db.select().from(issues).where(and(
      eq(issues.companyId, seed.companyId),
      eq(issues.missionId, seed.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"),
    ))).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION))).toHaveLength(0);
  });
});
