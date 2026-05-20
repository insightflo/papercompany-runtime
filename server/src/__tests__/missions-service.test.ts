import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { extractMissionOwnerDecisionFromText, missionService } from "../services/missions.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("mission owner decision parser", () => {
  it("extracts the latest valid mission owner decision block", () => {
    expect(extractMissionOwnerDecisionFromText([
      "### Mission owner decision",
      "Decision: request_input",
      "Source issue: old-source",
      "Reason: old reason",
      "",
      "### Mission owner decision",
      "Decision: retry_source_issue",
      "Source issue: BM123-1",
      "Reason: Source executor confirmed the transient failure is gone.",
      "Next action: Re-dispatch source issue after approval.",
      "Evidence: Owner reviewed the blocked issue comment.",
    ].join("\n"))).toEqual({
      decision: "retry_source_issue",
      sourceIssueRef: "BM123-1",
      reason: "Source executor confirmed the transient failure is gone.",
      nextAction: "Re-dispatch source issue after approval.",
      evidence: "Owner reviewed the blocked issue comment.",
    });
  });

  it("returns a conservative invalid decision signal for unknown decisions", () => {
    expect(extractMissionOwnerDecisionFromText([
      "### Mission owner decision",
      "Decision: auto_fix_everything",
      "Source issue: BM123-1",
      "Reason: Too broad.",
    ].join("\n"))).toEqual({
      decision: null,
      invalidDecision: "auto_fix_everything",
      sourceIssueRef: "BM123-1",
      reason: "Too broad.",
      nextAction: undefined,
      evidence: undefined,
    });
  });
});

describeEmbeddedPostgres("mission service mission-linked subresources", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-missions-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(missionPlanArtifacts);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a mission with the owner as a valid mission agent", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Create Mission Company",
      issuePrefix: `CM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = missionService(db);
    const result = await svc.create({
      companyId,
      ownerAgentId,
      title: "QA launch readiness mission",
      description: "Regression coverage for mission creation from the UI.",
      status: "planning",
    });

    expect(result.title).toBe("QA launch readiness mission");
    expect(result.ownerAgentId).toBe(ownerAgentId);
    expect(result.agents).toEqual([
      expect.objectContaining({
        missionId: result.id,
        agentId: ownerAgentId,
        role: "executor",
      }),
    ]);
  });

  it("creates a main executor planning issue for a manual mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Mission Company",
      issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(planningIssues).toEqual([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[Plan] Customer homepage rollout",
      }),
    ]);
    expect(planningIssues[0]?.description).toContain("Plan and coordinate the mission");
  });

  it("creates an initial active mission plan artifact alongside the manual planning issue", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Plan Artifact Company",
      issuePrefix: `MA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(planningIssues).toEqual([
      expect.objectContaining({ originKind: "mission_main_executor_plan" }),
    ]);
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        companyId,
        missionId: result.id,
        ownerAgentId,
        revision: 1,
        status: "active",
        missionGoal: expect.stringContaining("Customer homepage rollout"),
      }),
    ]);
    expect(planArtifacts[0]?.refs).toEqual({ planningIssueId: planningIssues[0]?.id });
    expect(result.activeMissionPlan).toEqual(
      expect.objectContaining({
        available: true,
        missionPlanId: planArtifacts[0]?.id,
        revision: 1,
        status: "active",
      }),
    );
  });

  it("does not create a manual planning issue for a workflow-created mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Company",
      issuePrefix: `WM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "active",
      source: "workflow",
    });

    const workflowIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(workflowIssues).toEqual([
      expect.objectContaining({
        originKind: "mission_main_executor_oversight",
        title: "[Oversight] 2026-04-28 gazua-morning",
      }),
    ]);
    expect(workflowIssues.some((issue) => issue.originKind === "mission_main_executor_plan")).toBe(false);
  });

  it("creates an owner unblock action without stealing a blocked issue from its assignee", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Blocked Mission Company",
      issuePrefix: `BM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Worker Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Blocked workflow mission",
      status: "active",
    });

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked delegated work",
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, missionId));
    const sourceIssue = missionIssues.find((issue) => issue.id === blockedIssue.id);
    const unblockIssues = missionIssues.filter((issue) => issue.originKind === "mission_main_executor_unblock");

    expect(sourceIssue).toEqual(expect.objectContaining({
      id: blockedIssue.id,
      assigneeAgentId: workerAgentId,
      status: "blocked",
    }));
    expect(unblockIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originId: blockedIssue.id,
        status: "todo",
        title: expect.stringContaining("Blocked delegated work"),
      }),
    ]);
    const description = unblockIssues[0]!.description ?? "";
    expect(description).toContain(`<!-- mission-owner-action:{"missionId":"${missionId}","sourceIssueId":"${blockedIssue.id}","actionType":"unblock","status":"decision_required"} -->`);
    expect(description).toContain(`Mission id: ${missionId}`);
    expect(description).toContain("Mission title: Blocked workflow mission");
    expect(description).toContain(`Source issue id: ${blockedIssue.id}`);
    expect(description).toContain(`Source issue identifier: ${blockedIssue.identifier}`);
    expect(description).toContain("Source issue title: Blocked delegated work");
    expect(description).toContain("Source issue status: blocked");
    expect(description).toContain(`Original assignee agent: ${workerAgentId}`);
    expect(description).toContain("Mission owner duties:");
    for (const decision of [
      "request_input",
      "retry_source_issue",
      "reassign_source_issue",
      "replan_mission",
      "escalate",
      "report_impossible",
      "recover_artifact",
      "no_action_waiting",
    ]) {
      expect(description).toContain(decision);
    }
    expect(description).toContain("### Mission owner decision");
    expect(description).toContain("Decision: <one of the allowed decision options>");
    expect(description).toContain("Source issue remains assigned to the original executor unless this comment explicitly chooses reassign_source_issue.");
    expect(description).toContain("Governance evidence: latest evidence unavailable for this owner action template.");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({
        id: unblockIssues[0]?.id,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_unblock",
        status: "todo",
      }),
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, assigneeAgentId: workerAgentId }),
    }));

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 11 * 60 * 1000),
    });
    const repeatedUnblockIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedUnblockIssues).toHaveLength(1);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });

  it("surfaces completed owner-action decisions as read-only supervision signals", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Owner Decision Company",
      issuePrefix: `OD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Decision mission", status: "active" });

    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked source work",
    });

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]);
    expect(unblockIssue).toBeTruthy();

    await issueService(db).update(unblockIssue!.id, { status: "done" });
    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue!.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: retry_source_issue",
        `Source issue: ${blockedIssue.identifier}`,
        "Reason: The owner confirmed the blocker is transient and the source executor should retry later.",
        "Next action: Re-dispatch source issue after explicit approval.",
        "Evidence: Source issue comment and mission owner review.",
      ].join("\n"),
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_decision_recorded"),
      expect.stringContaining("decision=retry_source_issue"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "retry_unit_if_safe",
        issueId: blockedIssue.id,
        reason: expect.stringContaining("later approved execution slice"),
        safeToAutoApply: false,
      }),
    ]));
    expect(result.appliedActions).toEqual([]);

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockedIssue.id))
      .then((rows) => rows[0]);
    expect(sourceIssue).toEqual(expect.objectContaining({
      assigneeAgentId: workerAgentId,
      status: "blocked",
    }));
  });

  it("explicitly applies retry_source_issue owner decisions without changing source assignee or waking execution by default", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Apply Retry Company", issuePrefix: `AR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Apply retry mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked retry source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: retry_source_issue",
        `Source issue: ${blockedIssue.identifier}`,
        "Reason: Owner confirmed the blocker has cleared.",
        "Next action: Retry the source issue without reassignment.",
        "Evidence: Owner reviewed blocker details.",
      ].join("\n"),
    });

    const readOnlyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(readOnlyResult.appliedActions).toEqual([]);
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));

    const applyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(applyResult.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", missionId, ownerActionIssueId: unblockIssue.id, sourceIssueId: blockedIssue.id, resultStatus: "todo" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "todo", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, blockedIssue.id))).resolves.toHaveLength(0);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    expect(sourceComments.map((comment) => comment.body).join("\n")).toContain("mission-owner-decision-applied");
    expect(sourceComments.map((comment) => comment.body).join("\n")).toContain("explicit mission-owner retry action");
    expect(sourceComments.map((comment) => comment.body).join("\n")).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("dispatches one explicit retry_source_issue wakeup to the source assignee with idempotency marker", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1", runId: "run-1" });

    await db.insert(companies).values({ id: companyId, name: "Wake Retry Company", issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked wake source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry and wake once"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${unblockIssue.id}:${blockedIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: unblockIssue.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, assigneeAgentId: workerAgentId }),
      targetAgentId: workerAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "todo", assigneeAgentId: workerAgentId }));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });

  it("does not apply or dispatch the same retry_source_issue owner decision twice", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1" });
    await db.insert(companies).values({ id: companyId, name: "Retry Idempotent Company", issuePrefix: `RI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Idempotent retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry once"].join("\n") });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.appliedActions).toHaveLength(1);
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });

  it("applies retry_source_issue with no source assignee but skips explicit wakeup dispatch", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry No Assignee Company", issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "No assignee retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { missionId, originKind: "workflow_execution", status: "blocked", title: "Unassigned blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry unassigned source"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(result.findings.join("\n")).toContain("source issue has no assignee; wakeup dispatch skipped");
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, resultStatus: "todo", wakeupDispatchStatus: "skipped_no_assignee" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "todo", assigneeAgentId: null }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("does not mutate or dispatch missing, cross-mission, terminal, or hidden retry_source_issue sources", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const otherMissionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry Safety Company", issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values([{ id: missionId, companyId, ownerAgentId, title: "Retry safety mission", status: "active" }, { id: otherMissionId, companyId, ownerAgentId, title: "Other mission", status: "active" }]);
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const terminalIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "done", title: "Terminal source" });
    const crossMissionIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId: otherMissionId, originKind: "workflow_execution", status: "blocked", title: "Cross mission source" });
    const hiddenIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Hidden source" });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssue.id));
    for (const [sourceIssue, title] of [[terminalIssue, "Terminal owner action"], [crossMissionIssue, "Cross mission owner action"], [hiddenIssue, "Hidden owner action"]] as const) {
      const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title });
      await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: should not mutate"].join("\n") });
    }
    const missingSourceId = randomUUID();
    const missingOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: missingSourceId, status: "done", title: "Missing owner action" });
    await db.insert(issueComments).values({ companyId, issueId: missingOwnerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${missingSourceId}`, "Reason: should not mutate missing source"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(result.findings.join("\n")).toContain("owner_action_decision_not_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, terminalIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, crossMissionIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, hiddenIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("keeps non-retry owner decisions read-only even with explicit owner-decision apply and wakeup dispatch enabled", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Non Retry Company", issuePrefix: `NR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Non retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Replan owner action" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: replan_mission", `Source issue: ${blockedIssue.identifier}`, "Reason: plan must change"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("explains decision-required owner actions without leaking unrelated text", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Required Company", issuePrefix: `ER${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source", description: "DO_NOT_LEAK_SOURCE_DESCRIPTION" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_required",
        ownerActionIssue: expect.objectContaining({ title: expect.stringContaining("[Unblock]") }),
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        latestDecision: null,
        retryApplied: false,
        explanation: expect.stringContaining("Owner decision required"),
      }),
    ]));
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("DO_NOT_LEAK_SOURCE_DESCRIPTION");
  });

  it("explains read-only retry decisions before explicit apply", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Read Only Company", issuePrefix: `EO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Read-only explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry when explicitly applied", "Next action: wait for apply", "Evidence: OWNER_DECISION_EVIDENCE_ONLY"].join("\n") });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: "UNRELATED_OWNER_COMMENT_NOT_FOR_STATUS_SUMMARY" });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_recorded_read_only",
        ownerActionIssue: expect.objectContaining({ id: unblockIssue.id }),
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
        retryApplied: false,
        explanation: expect.stringContaining("recorded but not applied"),
      }),
    ]));
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("UNRELATED_OWNER_COMMENT_NOT_FOR_STATUS_SUMMARY");
  });

  it("explains applied retry decisions as no-wakeup retries", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Applied Company", issuePrefix: `EA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Applied explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: apply retry"].join("\n") });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "retry_applied_no_wakeup",
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "todo", assigneeAgentId: workerAgentId }),
        retryApplied: true,
        explanation: expect.stringContaining("no heartbeat wakeup was created"),
      }),
    ]));
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, blockedIssue.id))).resolves.toHaveLength(0);
  });

  it("explains invalid owner decisions as not applicable without executing", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Invalid Company", issuePrefix: `EI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Invalid explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: auto_magic", `Source issue: ${blockedIssue.identifier}`, "Reason: invalid"].join("\n") });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "not_applicable_or_invalid",
        latestDecision: expect.objectContaining({ decision: null, invalidDecision: "auto_magic" }),
        retryApplied: false,
        explanation: expect.stringContaining("invalid"),
      }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("treats invalid owner-action decisions conservatively without auto action", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Invalid Owner Decision Company",
      issuePrefix: `IO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Invalid decision mission", status: "active" });

    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked source work",
    });

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]);
    expect(unblockIssue).toBeTruthy();

    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue!.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: auto_fix_everything",
        `Source issue: ${blockedIssue.identifier}`,
        "Reason: Unsupported automated action.",
      ].join("\n"),
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_decision_invalid"),
    ]));
    expect(result.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining("auto_fix_everything") }),
    ]));
    expect(result.appliedActions).toEqual([]);

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockedIssue.id))
      .then((rows) => rows[0]);
    expect(sourceIssue).toEqual(expect.objectContaining({
      assigneeAgentId: workerAgentId,
      status: "blocked",
    }));
  });

  it("surfaces blocked owner unblock actions as recovery work instead of ignoring the deadlock", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Owner Action Deadlock Company",
      issuePrefix: `OD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Blog Writer",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "gazua-morning artifact mission",
      status: "active",
    });

    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "[gazua-morning] blog markdown 작성",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: blockedIssue.id,
      authorAgentId: workerAgentId,
      body: [
        "### Work completed in comment but artifact missing",
        "Required source artifact is missing: `/tmp/Public_Market_Report_2026-05-20.md`",
        "# Public Market Report 2026-05-20",
        "본문 초안입니다.",
      ].join("\n"),
    });

    await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    const unblockIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]);
    expect(unblockIssue).toBeTruthy();

    await issueService(db).update(unblockIssue!.id, { status: "blocked" });
    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue!.id,
      authorAgentId: ownerAgentId,
      body: "Blocked: Required source artifact is missing: `/tmp/Public_Market_Report_2026-05-20.md`",
    });

    const result = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_unblock_action_blocked"),
      expect.stringContaining("artifact_recovery_available"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "materialize_artifact_from_comment",
        issueId: blockedIssue.id,
        reason: expect.stringContaining("comment body"),
        safeToAutoApply: false,
      }),
      expect.objectContaining({
        type: "request_replan",
        issueId: unblockIssue!.id,
        reason: expect.stringContaining("self-block"),
        safeToAutoApply: false,
      }),
    ]));

    const unblockIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(unblockIssues).toHaveLength(1);
  });

  it("surfaces repeated artifact-missing failures as recurring owner-improvement work", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Recurring Artifact Company",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Blog Writer",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "gazua-morning recurring blog artifact mission",
      status: "active",
    });

    const previousIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      status: "blocked",
      title: "[gazua-morning] 2026-05-18 일간 블로그 markdown 작성",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: previousIssue.id,
      body: "### Required workflow artifact missing\n- Required artifact: reports/blog/202605/Public_Market_Report_2026-05-18.md",
    });
    const currentIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "[gazua-morning] 2026-05-20 일간 블로그 markdown 작성",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: currentIssue.id,
      body: "### Required workflow artifact missing\n- Required artifact: reports/blog/202605/Public_Market_Report_2026-05-20.md",
    });

    const result = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("recurring_artifact_missing"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: currentIssue.id,
        reason: expect.stringContaining("Recurring artifact-missing"),
        safeToAutoApply: false,
      }),
    ]));
  });

  it("ensures plugin-backed active mission execution substrate idempotently", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runEntityId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Substrate Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `test-plugin-${pluginId}`,
      packageName: "@paperclip/test-plugin",
      version: "0.0.1",
      manifestJson: { id: `test-plugin-${pluginId}`, name: "Test Plugin", version: "0.0.1", apiVersion: 1 },
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin-backed mission",
      description: "Created automatically for plugin workflow run: plugin-daily",
      status: "active",
    });
    await db.insert(pluginEntities).values({
      id: runEntityId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: "plugin-run-1",
      title: "Plugin daily workflow",
      status: "running",
      data: {
        companyId,
        missionId,
        workflowId: "plugin-daily",
        workflowName: "Plugin Daily",
        status: "running",
      },
    });

    const svc = missionService(db);
    const first = await svc.ensureMissionExecutionPlan({ companyId, missionId });
    const second = await svc.ensureMissionExecutionPlan({ companyId, missionId });

    expect(second).toEqual(first);
    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, missionId));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));

    expect(oversightIssues).toEqual([
      expect.objectContaining({
        originKind: "mission_main_executor_oversight",
        title: "[Oversight] Plugin Daily",
      }),
    ]);
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.refs).toMatchObject({
      schemaVersion: 2,
      oversightIssueId: oversightIssues[0]?.id,
      workflowName: "Plugin Daily",
      executionUnits: [
        expect.objectContaining({
          kind: "plugin_workflow_run",
          status: "running",
          sourceRef: expect.objectContaining({ type: "plugin_workflow_run", id: runEntityId }),
        }),
      ],
    });
  });

  it("creates the main executor oversight substrate when a workflow mission is created", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Oversight Company",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "2026-05-15 gazua-weekly",
      description: "Created automatically for plugin workflow run: gazua-weekly",
      status: "active",
      source: "workflow",
    });

    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(oversightIssues).toEqual([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[Oversight] 2026-05-15 gazua-weekly",
      }),
    ]);
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.refs).toMatchObject({
      oversightIssueId: oversightIssues[0]?.id,
      workflowName: "2026-05-15 gazua-weekly",
    });
  });

  it("reuses an existing active workflow mission with the same company, title, and workflow description", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Dedup Company",
      issuePrefix: `WD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const input = {
      companyId,
      ownerAgentId,
      title: "2026-04-30 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active" as const,
      source: "workflow" as const,
    };

    const first = await missionService(db).create(input);
    const second = await missionService(db).create(input);
    const missionRows = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, companyId));

    expect(second.id).toBe(first.id);
    expect(missionRows).toHaveLength(1);
  });

  it("filters listed missions by inclusive created date range", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Date Filter Mission Company",
      issuePrefix: `DF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    await db.insert(missions).values([
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Before range",
        status: "active",
        createdAt: new Date(2026, 2, 31, 23, 59, 59, 999),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range start",
        status: "active",
        createdAt: new Date(2026, 3, 1, 0, 0, 0, 0),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range end",
        status: "active",
        createdAt: new Date(2026, 3, 29, 23, 59, 59, 999),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "After range",
        status: "active",
        createdAt: new Date(2026, 3, 30, 0, 0, 0, 0),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      from: "2026-04-01",
      to: "2026-04-29",
      sortBy: "createdAt",
      sortOrder: "asc",
    });

    expect(result.map((mission) => mission.title)).toEqual([
      "Inside range start",
      "Inside range end",
    ]);
  });

  it("interprets date-only mission filters as local-day boundaries", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Local Date Filter Mission Company",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    await db.insert(missions).values([
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Local Apr 29 late night",
        status: "active",
        createdAt: new Date("2026-04-29T14:59:59.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Local Apr 30 morning",
        status: "active",
        createdAt: new Date("2026-04-29T22:00:00.000Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      from: "2026-04-29",
      to: "2026-04-29",
      sortBy: "createdAt",
      sortOrder: "asc",
    });

    expect(result.map((mission) => mission.title)).toEqual(["Local Apr 29 late night"]);
  });

  it("rejects non-UUID mission ids before mission subresource queries", async () => {
    const svc = missionService(db);

    await expect(svc.getById("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.getIssueTree("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.listWorkflowRuns("mission-1")).rejects.toMatchObject({ status: 400 });
  });

  it("returns mission-linked issues through getIssueTree", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Company",
      issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Ship Mission",
      status: "active",
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        missionId,
        title: "Root issue",
        status: "todo",
        priority: "high",
        identifier: "MS-1",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: rootIssueId,
        title: "Child issue",
        status: "in_progress",
        priority: "medium",
        identifier: "MS-2",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result).toHaveLength(2);
    expect(result.map((issue) => issue.id)).toEqual(expect.arrayContaining([rootIssueId, childIssueId]));
    expect(result.find((issue) => issue.id === childIssueId)?.parentId).toBe(rootIssueId);
  });

  it("returns mission-linked workflow runs with step runs", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Company",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Workflow Mission",
      status: "active",
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Launch Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId: ownerAgentId,
          dependencies: [],
          toolNames: ["search-docs"],
          knowledgeBaseIds: ["kb-product"],
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Draft mission brief",
      status: "in_progress",
      priority: "high",
      identifier: "WF-11",
      assigneeAgentId: ownerAgentId,
    });

    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        workflowName: "Launch Workflow",
      }),
    );
    expect(result[0]?.stepRuns).toEqual([
      expect.objectContaining({
        id: stepRunId,
        workflowRunId: runId,
        stepId: "draft",
        issueId,
      }),
    ]);
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "draft",
        name: "Draft",
        agentId: ownerAgentId,
        toolNames: ["search-docs"],
        knowledgeBaseIds: ["kb-product"],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "WF-11",
          title: "Draft mission brief",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
      }),
    ]);
    expect(result[0]?.progress).toEqual({
      totalSteps: 1,
      pendingSteps: 0,
      runningSteps: 1,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
    });
  });

  it("updates active workflow-created missions when all linked plugin runs are terminal", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Plugin Workflow Company",
      issuePrefix: `TP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-04-27 tech-scout",
      description: "Created automatically for workflow run: tech-scout",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values({
      id: runId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${runId}`,
      title: "tech-scout run",
      status: "aborted",
      data: {
        workflowId: randomUUID(),
        workflowName: "tech-scout",
        companyId,
        missionId,
        status: "aborted",
        triggerSource: "schedule",
        startedAt: "2026-04-27T00:41:03.618Z",
        completedAt: "2026-04-27T00:42:33.653Z",
      },
    });

    const svc = missionService(db);
    const activeList = await svc.list({ companyId, status: "active" });
    const detail = await svc.getById(missionId);
    const listed = await svc.list({ companyId });

    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-27T00:42:33.653Z"));
    expect(listed.find((mission) => mission.id === missionId)?.status).toBe("cancelled");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
  });

  it("corrects a prematurely completed workflow-created mission when its linked plugin run later aborts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Premature Completed Workflow Company",
      issuePrefix: `PC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "completed",
      completedAt: new Date("2026-04-27T23:51:06.620Z"),
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values({
      id: runId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${runId}`,
      title: "gazua-morning #2026-04-28-1",
      status: "aborted",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "aborted",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: "2026-04-28T00:10:29.987Z",
      },
    });

    const svc = missionService(db);
    const completedList = await svc.list({ companyId, status: "completed" });
    const detail = await svc.getById(missionId);
    const cancelledList = await svc.list({ companyId, status: "cancelled" });

    expect(completedList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
    expect(cancelledList.find((mission) => mission.id === missionId)?.status).toBe("cancelled");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
  });

  it("reactivates a prematurely cancelled workflow-created mission while a linked plugin run is still active", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Premature Cancelled Workflow Company",
      issuePrefix: `PX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "cancelled",
      completedAt: new Date("2026-04-28T00:10:29.987Z"),
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values({
      id: runId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${runId}`,
      title: "gazua-morning #2026-04-28-1",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: null,
      },
    });

    const svc = missionService(db);
    const cancelledList = await svc.list({ companyId, status: "cancelled" });
    const activeList = await svc.list({ companyId, status: "active" });
    const detail = await svc.getById(missionId);

    expect(cancelledList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(activeList.find((mission) => mission.id === missionId)?.status).toBe("active");
    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("active");
    expect(stored?.completedAt).toBeNull();
  });

  it("does not reactivate an ordinary manually cancelled mission with no workflow-created marker", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Manual Cancelled Mission Company",
      issuePrefix: `MC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Manual mission",
      description: "Operator cancelled this manually",
      status: "cancelled",
      completedAt: new Date("2026-04-28T00:10:29.987Z"),
    });

    const svc = missionService(db);
    const detail = await svc.getById(missionId);
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
  });

  it("links plugin workflow step issue ancestors to the mission before returning the issue tree", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const parentIssueId = randomUUID();
    const stepIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Issue Company",
      issuePrefix: `PI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin Workflow Mission",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values([
      {
        id: workflowId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-definition:${workflowId}`,
        title: "tech-scout",
        status: "active",
        data: { name: "tech-scout", companyId, steps: [{ id: "scout", title: "Scout", dependsOn: [] }] },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "tech-scout run",
        status: "running",
        data: {
          workflowId,
          workflowName: "tech-scout",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scout`,
        title: "scout",
        status: "completed",
        data: { runId, stepId: "scout", issueId: stepIssueId, status: "completed" },
      },
    ]);

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId: null,
        title: "[tech-scout] #2026-04-27-1",
        status: "backlog",
        priority: "medium",
        identifier: "PI-1",
      },
      {
        id: stepIssueId,
        companyId,
        missionId: null,
        parentId: parentIssueId,
        title: "[tech-scout] 2026-04-27 기술 리서치 리포트",
        status: "done",
        priority: "high",
        identifier: "PI-2",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result.map((issue) => issue.id)).toEqual(expect.arrayContaining([parentIssueId, stepIssueId]));
    expect(result.find((issue) => issue.id === stepIssueId)?.parentId).toBe(parentIssueId);

    const stored = await db
      .select({ id: issues.id, missionId: issues.missionId })
      .from(issues)
      .where(inArray(issues.id, [parentIssueId, stepIssueId]));
    expect(stored).toEqual(
      expect.arrayContaining([
        { id: parentIssueId, missionId },
        { id: stepIssueId, missionId },
      ]),
    );
  });

  it("returns plugin entity workflow runs linked to a mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Company",
      issuePrefix: `PW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin Workflow Mission",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values([
      {
        id: workflowId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-definition:${workflowId}`,
        title: "Scheduled Plugin Workflow",
        status: "active",
        data: {
          name: "Scheduled Plugin Workflow",
          description: "Scheduled plugin run should show on mission execution flow.",
          companyId,
          status: "active",
          steps: [
            {
              id: "scheduled-step",
              title: "Scheduled E2E pass step",
              dependsOn: [],
              type: "agent",
              agentName: "Workflow Owner",
            },
          ],
        },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "Scheduled Plugin Workflow run",
        status: "running",
        data: {
          workflowId,
          workflowName: "Scheduled Plugin Workflow",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scheduled-step`,
        title: "scheduled-step",
        status: "in_progress",
        data: {
          runId,
          stepId: "scheduled-step",
          issueId,
          agentName: "Workflow Owner",
          status: "in_progress",
          retryCount: 0,
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Scheduled plugin step issue",
      status: "in_progress",
      priority: "high",
      identifier: "PW-11",
      assigneeAgentId: ownerAgentId,
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        companyId,
        workflowName: "Scheduled Plugin Workflow",
        status: "running",
        triggeredBy: "schedule",
      }),
    );
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "scheduled-step",
        name: "Scheduled E2E pass step",
        agentId: ownerAgentId,
        dependencies: [],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "PW-11",
          title: "Scheduled plugin step issue",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
      }),
    ]);
  });
});
