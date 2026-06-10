import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  companySecrets,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionDelegations,
  missionPlanArtifacts,
  missionSessions,
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
import { missionDelegationService } from "../services/mission-delegations.js";
import { completeWorkflowToolStepFromResult, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

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
    setWorkflowToolStepExecutor(null);
    await db.delete(missionDelegations);
    await db.delete(issueWorkProducts);
    await db.delete(pluginEntities);
    await db.delete(missionPlanArtifacts);
    await db.delete(missionSessions);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySecrets);
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

  it("creates and finalizes a cross-company mission delegation", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceOwnerAgentId = randomUUID();
    const targetOwnerAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Development Company",
        issuePrefix: `DV${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Research Company",
        issuePrefix: `RS${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: sourceOwnerAgentId,
        companyId: sourceCompanyId,
        name: "Dev CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetOwnerAgentId,
        companyId: targetCompanyId,
        name: "Research CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const missionsSvc = missionService(db);
    const sourceMission = await missionsSvc.create({
      companyId: sourceCompanyId,
      ownerAgentId: sourceOwnerAgentId,
      title: "Build daily trend dashboard",
      description: "Development mission that needs research input.",
      status: "active",
    });

    const created = await missionDelegationService(db).create({
      sourceMissionId: sourceMission.id,
      targetCompanyId,
      targetOwnerAgentId,
      title: "Research daily trend briefing sources",
      description: "Research and return grouped news source material.",
    });

    expect(created.delegation.sourceMissionId).toBe(sourceMission.id);
    expect(created.delegation.targetMissionId).toBe(created.targetMission.id);
    expect(created.sourceIssue.status).toBe("blocked");
    expect(created.targetMission.companyId).toBe(targetCompanyId);
    expect(created.targetMission.title).toContain("[DELEGATED]");

    const [targetWorkIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, created.targetMission.id))
      .limit(1);
    expect(targetWorkIssue).toBeTruthy();

    await db.insert(issueWorkProducts).values({
      companyId: targetCompanyId,
      issueId: targetWorkIssue.id,
      type: "html_report",
      provider: "test",
      externalId: "research-report-1",
      title: "Daily trend research report",
      url: "file:///tmp/daily-trend.html",
      status: "ready",
      reviewState: "accepted",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Grouped news research output.",
    });

    await missionsSvc.update(created.targetMission.id, { status: "completed" });

    const [updatedDelegation] = await db
      .select()
      .from(missionDelegations)
      .where(eq(missionDelegations.id, created.delegation.id));
    expect(updatedDelegation.status).toBe("completed");
    expect(updatedDelegation.completedAt).toBeInstanceOf(Date);

    const [sourceIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, created.sourceIssue.id));
    expect(sourceIssue.status).toBe("done");

    const copiedProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, created.sourceIssue.id));
    expect(copiedProducts).toHaveLength(1);
    expect(copiedProducts[0]).toMatchObject({
      companyId: sourceCompanyId,
      provider: "delegated_mission",
      title: "Daily trend research report",
      url: "file:///tmp/daily-trend.html",
    });
  });

  it("applies mission status timestamp side effects on status-only updates", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Status Company",
      issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Status-only update mission",
      status: "planning",
    });

    const svc = missionService(db);
    const completed = await svc.update(missionId, { status: "completed" });

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);

    const active = await svc.update(missionId, { status: "active" });

    expect(active.status).toBe("active");
    expect(active.startedAt).toBeInstanceOf(Date);
    expect(active.completedAt).toBeNull();
  });

  it("creates a main executor planning issue for a manual mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const errorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Mission Company",
      issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
        id: errorAgentId,
        companyId,
        name: "Unavailable Worker",
        role: "researcher",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

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

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[PLAN] Customer homepage rollout",
      }),
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[OVERSIGHT] Customer homepage rollout",
      }),
    ]));
    expect(planningIssues).toHaveLength(2);
    const planningIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_plan");
    expect(planningIssue?.description).toContain("Post exactly one structured `### Mission owner plan decision` JSON comment");
    expect(planningIssue?.description).toContain("\"assigneeAgentId\": \"agent-id-from-roster\"");
    expect(planningIssue?.description).toContain(`Main Executor (operator, active) id=${ownerAgentId} [mission owner]`);
    expect(planningIssue?.description).not.toContain(errorAgentId);
    expect(planningIssue?.description).not.toContain("Unavailable Worker");
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

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ originKind: "mission_main_executor_plan" }),
      expect.objectContaining({ originKind: "mission_main_executor_oversight" }),
    ]));
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
    const planningIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_plan");
    const oversightIssue = planningIssues.find((issue) => issue.originKind === "mission_main_executor_oversight");
    expect(planArtifacts[0]?.refs).toEqual(expect.objectContaining({
      planningIssueId: planningIssue?.id,
      oversightIssueId: oversightIssue?.id,
    }));
    expect(result.activeMissionPlan).toEqual(
      expect.objectContaining({
        available: true,
        missionPlanId: planArtifacts[0]?.id,
        revision: 1,
        status: "active",
        stepCount: 4,
        executionUnitCount: 0,
      }),
    );
    expect(planArtifacts[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "plan-skeleton", title: expect.stringContaining("source, synthesis, and QA") }),
      expect.objectContaining({ id: "qa-after-artifact", title: expect.stringContaining("Run QA only after") }),
    ]));
    expect(planArtifacts[0]?.successCriteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: expect.stringContaining("QA or validation work starts only after") }),
    ]));
  });

  it("treats non-workflow mission sources as manual launches", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Board Source Mission Company",
      issuePrefix: `BS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Board-created active mission",
      description: "Created from the board UI.",
      status: "active",
      source: "board",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(planningIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[PLAN] Board-created active mission",
      }),
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[OVERSIGHT] Board-created active mission",
      }),
    ]));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        missionId: result.id,
        revision: 1,
        status: "active",
      }),
    ]);
    expect(result.activeMissionPlan).toEqual(expect.objectContaining({
      available: true,
      stepCount: 4,
    }));
  });

  it("dispatches a one-shot owner planning wakeup for a manual mission without rolling back on dispatch failure", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Wakeup Company",
      issuePrefix: `PW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    const onOwnerPlanningIssueCreated = vi.fn(async () => {
      throw new Error("queue temporarily unavailable");
    });

    const result = await missionService(db, { onOwnerPlanningIssueCreated }).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id))
      .then((rows) => rows.find((issue) => issue.originKind === "mission_main_executor_plan") ?? null);

    expect(planningIssue).toEqual(expect.objectContaining({
      assigneeAgentId: ownerAgentId,
      status: "todo",
    }));
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledOnce();
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledWith({
      mission: expect.objectContaining({ id: result.id, companyId, ownerAgentId }),
      issue: expect.objectContaining({ id: planningIssue?.id, originKind: "mission_main_executor_plan" }),
      targetAgentId: ownerAgentId,
      idempotencyKey: `mission-owner-planning-wakeup:${result.id}:${planningIssue?.id}`,
    });
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
        title: "[OVERSIGHT] 2026-04-28 gazua-morning",
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

  it("does not create an unblock action when the active plan says the issue prerequisites are blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plan Gated Blocked Mission Company",
      issuePrefix: `PG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plan gated QA mission",
      status: "active",
    });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Plan gated QA mission",
      refs: {},
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [
        { id: "source", title: "Collect source artifact", status: "planned" },
        { id: "qa", title: "Run QA after source artifact", status: "planned" },
      ],
    });

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const blockedQaIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      createdByUserId: "test-operator",
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "QA issue started before source artifact",
    });
    await db.update(missionPlanArtifacts).set({
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{
          id: "qa-before-source",
          kind: "mission_issue",
          title: "QA issue started before source artifact",
          selectionState: "selected",
          executionState: "blocked",
          dependencyTreatment: "blocked",
          reason: "Source artifact is not complete yet.",
          sourceRef: { type: "mission_issue", id: blockedQaIssue.id, issueId: blockedQaIssue.id },
        }],
      },
    }).where(eq(missionPlanArtifacts.missionId, missionId));

    const result = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_gate_not_ready"),
      expect.stringContaining("prerequisites are blocked"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: blockedQaIssue.id,
        safeToAutoApply: false,
      }),
    ]));
    const unblockIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(unblockIssues).toHaveLength(0);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
  });

  it("does not create an unblock action when the active plan has no high-level skeleton", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Empty Plan Gate Company",
      issuePrefix: `EP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "research", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Empty active plan mission", status: "active" });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Empty active plan mission",
      refs: {},
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked issue under empty plan",
    });

    const result = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_gate_not_ready"),
      expect.stringContaining("has no high-level step skeleton"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: blockedIssue.id, safeToAutoApply: false }),
    ]));
    const unblockIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(unblockIssues).toHaveLength(0);
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

  it("does not apply retry_source_issue when the active plan says the source prerequisites are blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Plan Gated Retry Company", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan gated retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, createdByUserId: "test-operator", missionId, originKind: "workflow_execution", status: "blocked", title: "QA blocked before source artifact" });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Plan gated retry mission",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{
          id: "qa-before-source",
          kind: "mission_issue",
          title: "QA blocked before source artifact",
          selectionState: "selected",
          executionState: "blocked",
          dependencyTreatment: "blocked",
          reason: "Source artifact is not complete yet.",
          sourceRef: { type: "mission_issue", id: blockedIssue.id, issueId: blockedIssue.id },
        }],
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [
        { id: "source", title: "Collect source artifact", status: "planned" },
        { id: "qa", title: "Run QA after source artifact", status: "planned" },
      ],
    });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Retry QA source too early" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry anyway"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(result.findings.join("\n")).toContain("owner_action_decision_not_applied");
    expect(result.findings.join("\n")).toContain("prerequisites are blocked");
    expect(result.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).not.toContain("mission-owner-decision-applied");
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

  it("active supervision escalates a stale todo mission source when no issue is actually running", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "No Active Todo Escalation Company", issuePrefix: `NA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "No active todo escalation mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "No Active Todo Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source with no running execution" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_todo_no_active_execution"),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({ missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }));
    expect(ownerActions[0]?.description).toContain("no queued/running heartbeat run is active");
    expect(ownerActions[0]?.description).toContain("retry_source_issue");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("re-wakes an existing stale owner-action issue with no heartbeat instead of duplicating it", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action No Run Company", issuePrefix: `ON${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action no-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action No Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing owner action with no heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_no_execution"),
      expect.stringContaining(ownerAction.identifier ?? ownerAction.id),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "blocked" }),
    }));
  });

  it("re-wakes an existing stale owner-action issue after a failed heartbeat run", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action Failed Run Company", issuePrefix: `OF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action failed-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action Failed Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing owner action after failed heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: ownerAction.id,
      status: "failed",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      error: "Process lost",
      errorCode: "process_lost",
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_after_failed_run"),
      expect.stringContaining(failedRunId),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("does not classify a zero exit code heartbeat as failed stale queue evidence", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Zero Exit Queue Company", issuePrefix: `ZE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Zero exit stale queue mission", status: "active" });
    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Zero Exit Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source after clean exit" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "succeeded",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      exitCode: 0,
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    expect(findings).not.toContain("stale_todo_after_failed_run");
    expect(findings).toContain("stale_todo_no_active_execution");
  });

  it("active supervision escalates a stale todo source after timed_out execution", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Timed Out Todo Escalation Company", issuePrefix: `TT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Timed out todo escalation mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Timed out todo source" });
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_todo_after_failed_run"),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({ missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }));
    expect(ownerActions[0]?.description).toContain("timed_out");
    expect(ownerActions[0]?.description).toContain(timedOutRunId);
    expect(ownerActions[0]?.description).toContain("retry_source_issue");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("does not directly wake a stale in_progress source after terminal heartbeat execution without diagnosis", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-in-progress", runId: "run-in-progress" });

    await db.insert(companies).values({ id: companyId, name: "Stale In Progress Wake Company", issuePrefix: `IP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stale in-progress wake mission", status: "active" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "in_progress", title: "In-progress source after timed out run" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
      errorCode: "timeout",
    });

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:45:00.000Z"),
      dispatchStaleSourceIssueWakeups: true,
    });
    const idempotencyKey = `mission-stale-source-wakeup:${missionId}:${sourceIssue.id}:${timedOutRunId}`;

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_after_failed_run"),
      expect.stringContaining(timedOutRunId),
      expect.stringContaining("diagnosed_only"),
      expect.stringContaining("stale_source_wakeup_requires_diagnosis"),
    ]));
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
    expect(result.missions[0]?.appliedActions).toEqual([]);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).not.toContain("### Mission supervision stale source wakeup dispatched");
    expect(sourceBody).not.toContain(idempotencyKey);
  });

  it("dispatches explicit retry_source_issue wakeup for a stale todo source after failed execution", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-todo", runId: "run-todo" });

    await db.insert(companies).values({ id: companyId, name: "Wake Todo Retry Company", issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake stale todo retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Stale todo wake source" });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-05-31T00:00:00.000Z"),
      finishedAt: new Date("2026-05-31T00:15:00.000Z"),
      errorCode: "timeout",
    });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry stale todo source" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry stale todo after failed execution"].join("\n") });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, assigneeAgentId: workerAgentId, status: "todo" }),
      targetAgentId: workerAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, resultStatus: "todo", wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("dispatches a retry_source_issue wakeup when an earlier apply marker exists without a dispatch marker", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-late" });
    await db.insert(companies).values({ id: companyId, name: "Late Wake Dispatch Company", issuePrefix: `LW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Late wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Previously applied source" });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerAgentId, issueId: sourceIssue.id, status: "timed_out", startedAt: new Date("2026-05-31T00:00:00.000Z"), finishedAt: new Date("2026-05-31T00:15:00.000Z"), errorCode: "timeout" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry applied without dispatch" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry once then dispatch later"].join("\n") });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false });
    expect(first.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "not_requested" }),
    ]));
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T02:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue`;
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: workerAgentId, idempotencyKey }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });

  it("re-wakes a half-applied validator retry after a completed child correction and carries repair evidence into the wake comment", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();
    const correctedPngPath = "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260602-techcrunch-ai-knowledge-comic.png";
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-validator" });
    await db.insert(companies).values({ id: companyId, name: "Validator Child Correction Company", issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: validatorAgentId, companyId, name: "Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Validator retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: validatorAgentId, createdByUserId: "test-operator", missionId, originKind: "workflow_execution", status: "todo", title: "RES-132 validator retry source" });
    await db.insert(heartbeatRuns).values({ id: succeededRunId, companyId, agentId: validatorAgentId, issueId: sourceIssue.id, status: "succeeded", startedAt: new Date("2026-06-02T08:00:00.000Z"), finishedAt: new Date("2026-06-02T08:10:00.000Z"), exitCode: 0 });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry validator after corrected PNG" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: corrected child PNG is ready; run validator again"].join("\n") });
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceIssue.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner retry applied",
        `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: sourceIssue.id, decision: "retry_source_issue" })} -->`,
        "Action: earlier supervision applied the owner retry but did not dispatch a wakeup.",
      ].join("\n"),
    });
    const childCorrection = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, parentId: sourceIssue.id, originKind: "mission_repair_child", status: "done", title: "RES-152 corrected PNG ready" });
    await db.insert(issueComments).values({ companyId, issueId: childCorrection.id, authorAgentId: ownerAgentId, body: [
      "### Corrected validation artifact",
      `Corrected PNG path: ${correctedPngPath}`,
      "RES-148 repair spec: Recheck the original repair spec before deciding PASS.",
      "Existing REQUEST_CHANGES objection panel 3: verify the panel 3 objection is resolved.",
      "Existing REQUEST_CHANGES objection panel 5: verify the panel 5 objection is resolved.",
      "Gate: return only PASS or REQUEST_CHANGES; do not edit the artifact.",
      "Telegram/send is forbidden before PASS.",
    ].join("\n") });

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-06-02T08:40:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: validatorAgentId,
      idempotencyKey,
      wakeCommentId: expect.any(String),
    }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("### Validator retry evidence");
    expect(sourceBody).toContain(correctedPngPath);
    expect(sourceBody).toContain("RES-148 repair spec");
    expect(sourceBody).toContain("panel 3");
    expect(sourceBody).toContain("panel 5");
    expect(sourceBody).toContain("PASS or REQUEST_CHANGES");
    expect(sourceBody).toContain("Telegram/send is forbidden before PASS");
    expect(sourceBody).not.toContain("Direct modification");
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

  it("returns ownerActionExplanations from getById matching supervision path results", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Parity Company", issuePrefix: `EP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Explanation parity mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: parity check"].join("\n") });

    const supervisionResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    const detail = await svc.getById(missionId);
    const supervisionExplanation = supervisionResult.ownerActionExplanations.find((explanation) => explanation.ownerActionIssue.id === unblockIssue.id);
    const detailExplanation = detail.ownerActionExplanations.find((explanation) => explanation.ownerActionIssue.id === unblockIssue.id);

    expect(detailExplanation).toBeDefined();
    expect(supervisionExplanation).toBeDefined();
    expect(detailExplanation).toEqual(expect.objectContaining({
      status: supervisionExplanation!.status,
      explanation: supervisionExplanation!.explanation,
      retryApplied: supervisionExplanation!.retryApplied,
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
      latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
    }));
  });

  it("excludes hidden owner-action issues from supervision and getById explanations", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hidden Explanation Company", issuePrefix: `HE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Hidden explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    const hiddenOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Hidden owner action" });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenOwnerAction.id));

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    const detail = await svc.getById(missionId);

    expect(result.ownerActionExplanations.some((explanation) => explanation.ownerActionIssue.id === hiddenOwnerAction.id)).toBe(false);
    expect(detail.ownerActionExplanations.some((explanation) => explanation.ownerActionIssue.id === hiddenOwnerAction.id)).toBe(false);
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("Hidden owner action");
    expect(JSON.stringify(detail.ownerActionExplanations)).not.toContain("Hidden owner action");
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
        title: "[OVERSIGHT] Plugin Daily",
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

  it("escalates stale plugin execution units into owner-action issues without retrying the source", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runEntityId = randomUUID();
    const stepEntityId = randomUUID();
    const staleObservedAt = new Date("2026-05-31T00:00:00.000Z");
    const now = new Date("2026-05-31T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Stale Plugin Escalation Company",
      issuePrefix: `SP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Main Executor", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Tech Scout", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `stale-plugin-${pluginId}`,
      packageName: "@paperclip/stale-plugin",
      version: "0.0.1",
      manifestJson: { id: `stale-plugin-${pluginId}`, name: "Stale Plugin", version: "0.0.1", apiVersion: 1 },
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tech scout stale mission",
      status: "active",
    });
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "todo",
      title: "Collect Tech Scout Top25",
    });
    await db.insert(pluginEntities).values([
      {
        id: runEntityId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "stale-plugin-run",
        title: "Tech scout plugin workflow",
        status: "running",
        data: { companyId, missionId, workflowId: "tech-scout", workflowName: "Tech Scout", status: "running" },
        createdAt: staleObservedAt,
        updatedAt: staleObservedAt,
      },
      {
        id: stepEntityId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "stale-plugin-step",
        title: "plan-ai-news",
        status: "in_progress",
        data: { companyId, missionId, workflowRunId: runEntityId, stepId: "plan-ai-news", issueId: sourceIssue.id, status: "in_progress" },
        createdAt: staleObservedAt,
        updatedAt: staleObservedAt,
      },
    ]);

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_execution_unit"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: sourceIssue.id,
        sourceRef: expect.objectContaining({ type: "plugin_workflow_step_run", id: stepEntityId }),
        safeToAutoApply: false,
      }),
    ]));

    const missionIssues = await db.select().from(issues).where(eq(issues.missionId, missionId));
    const ownerActionIssues = missionIssues.filter((issue) => issue.originKind === "mission_main_executor_unblock");
    expect(ownerActionIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originId: sourceIssue.id,
        status: "todo",
        title: expect.stringContaining("Collect Tech Scout Top25"),
      }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({
      assigneeAgentId: workerAgentId,
      status: "todo",
    }));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({ id: ownerActionIssues[0]?.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, assigneeAgentId: workerAgentId, status: "todo" }),
    }));

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-05-31T01:05:00.000Z") });
    const repeatedOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedOwnerActions).toHaveLength(1);

    await issueService(db).update(ownerActionIssues[0]!.id, { status: "done" });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerActionIssues[0]!.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: no_action_waiting",
        `Source issue: ${sourceIssue.identifier}`,
        "Reason: The owner believed the stale workflow step was still actively running.",
        "Next action: Wait for the current step to finish.",
        "Evidence: Workflow step status was running.",
      ].join("\n"),
    });

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-05-31T02:00:00.000Z") });
    const renewedOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(renewedOwnerActions).toHaveLength(2);
    expect(renewedOwnerActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerActionIssues[0]!.id, status: "done", originId: sourceIssue.id }),
      expect.objectContaining({ status: "todo", originId: sourceIssue.id, title: expect.stringContaining("Collect Tech Scout Top25") }),
    ]));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(2);
  });

  it("creates and wakes a main-executor recovery issue for failed issue-less tool steps", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-10T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Recovery Company",
      issuePrefix: `TR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tool step recovery mission",
      status: "active",
    }).returning();

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["collect-signals"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [
        {
          id: "collect-signals",
          name: "Collect KR signals",
          type: "tool",
          dependencies: [],
          toolNames: ["collect-signals-kr"],
          description: "Collect market signals via external HTTP sources.",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: new Date("2026-06-10T06:21:11.582Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "collect-signals",
      issueId: null,
      status: "failed",
      startedAt: new Date("2026-06-10T06:21:11.582Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
      expect.stringContaining("recovery_issue_created"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        workflowRunId: runId,
        stepId: "collect-signals",
        safeToAutoApply: false,
      }),
    ]));

    const ownerActionIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActionIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        missionId,
        originId: oversightIssue.id,
        status: "todo",
        title: "[RECOVERY] Tool step failed: collect-signals",
      }),
    ]);
    expect(ownerActionIssues[0]?.description).toContain(`<!-- tool-step-recovery:${runId}:collect-signals -->`);
    expect(ownerActionIssues[0]?.description).toContain("Tool names: collect-signals-kr");
    expect(ownerActionIssues[0]?.description).toContain("Failure class: transient_or_external");
    expect(ownerActionIssues[0]?.description).toContain("Do not blindly retry this step.");
    expect(ownerActionIssues[0]?.description).toContain("If the tool implementation is broken");

    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({ id: ownerActionIssues[0]?.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: oversightIssue.id }),
      reason: "tool_step_failure_recovery_created",
    }));

    const repeated = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-06-10T06:35:00.000Z") });
    expect(repeated.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("recovery_issue_exists"),
    ]));
    const repeatedOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedOwnerActions).toHaveLength(1);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });

  it("automatically retries completed issue-less tool recovery through the unified workflow engine", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const failedStepRunId = randomUUID();
    const downstreamStepRunId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    const now = new Date("2026-06-10T07:30:00.000Z");

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Auto Recovery Company",
      issuePrefix: `TA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tool step auto recovery mission",
      status: "active",
    }).returning();

    const svc = missionService(db);
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["collect-signals", "signal-analysis"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [
        {
          id: "collect-signals",
          name: "Collect KR signals",
          type: "tool",
          dependencies: [],
          toolNames: ["collect-signals-kr"],
          description: "Collect market signals via external HTTP sources.",
        },
        {
          id: "signal-analysis",
          name: "Analyze signals",
          type: "tool",
          dependencies: ["collect-signals"],
          toolNames: ["analyze-signals"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: new Date("2026-06-10T06:21:11.582Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        id: failedStepRunId,
        workflowRunId: runId,
        stepId: "collect-signals",
        issueId: null,
        status: "failed",
        startedAt: new Date("2026-06-10T06:21:11.582Z"),
        completedAt: new Date("2026-06-10T06:23:53.691Z"),
      },
      {
        id: downstreamStepRunId,
        workflowRunId: runId,
        stepId: "signal-analysis",
        issueId: null,
        status: "skipped",
        startedAt: null,
        completedAt: new Date("2026-06-10T06:23:53.691Z"),
      },
    ]);

    const discovery = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now });
    expect(discovery.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
    ]));
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]!);
    expect(recoveryIssue.description).toContain(`<!-- tool-step-recovery:${runId}:collect-signals -->`);

    await issueService(db).update(recoveryIssue.id, { status: "done" });

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-10T07:35:00.000Z"),
      applyOwnerDecisionActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "native_tool_step_retry",
        missionId,
        ownerActionIssueId: recoveryIssue.id,
        workflowRunId: runId,
        stepId: "collect-signals",
        stepRunId: failedStepRunId,
        resultStatus: "running",
      }),
    ]));

    const [runAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(runAfter).toEqual(expect.objectContaining({
      status: "running",
      completedAt: null,
    }));
    const stepRunsAfter = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const retriedStep = stepRunsAfter.find((stepRun) => stepRun.id === failedStepRunId);
    const downstreamStep = stepRunsAfter.find((stepRun) => stepRun.id === downstreamStepRunId);
    expect(retriedStep).toEqual(expect.objectContaining({
      status: "running",
      issueId: null,
    }));
    expect(downstreamStep).toEqual(expect.objectContaining({
      status: "pending",
      issueId: null,
      startedAt: null,
      completedAt: null,
    }));
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      workflowRunId: runId,
      stepRunId: failedStepRunId,
      stepId: "collect-signals",
      toolName: "collect-signals-kr",
    }));

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: failedStepRunId,
      success: false,
    });

    const retryFailedResult = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-10T07:40:00.000Z"),
      applyOwnerDecisionActions: true,
    });
    expect(retryFailedResult.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_recovery_retry_failed_reopened"),
    ]));
    const [reopenedRecoveryIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, recoveryIssue.id));
    expect(reopenedRecoveryIssue).toEqual(expect.objectContaining({
      status: "todo",
      completedAt: null,
    }));
    const recoveryComments = await db.select().from(issueComments).where(eq(issueComments.issueId, recoveryIssue.id));
    expect(recoveryComments.map((comment) => comment.body).join("\n")).toContain("### Native tool step retry failed");
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
        title: "[OVERSIGHT] 2026-05-15 gazua-weekly",
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

  it("does not reuse a workflow mission that reconciles to terminal from linked workflow runs", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Terminal Dedup Company",
      issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-watchlist-refresh",
      stepsJson: [],
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
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      companyId,
      workflowId,
      missionId: first.id,
      status: "cancelled",
      triggeredBy: "test",
      completedAt: new Date("2026-04-30T00:05:00.000Z"),
    });

    const second = await missionService(db).create(input);
    const missionRows = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, companyId));

    expect(second.id).not.toBe(first.id);
    expect(missionRows).toHaveLength(2);
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
    const manualSubissueId = randomUUID();
    const manualGrandchildId = randomUUID();
    const otherCompanySubissueId = randomUUID();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Mission Company",
        issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Mission Company",
        issuePrefix: `OT${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

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
      {
        id: manualSubissueId,
        companyId,
        missionId: null,
        parentId: childIssueId,
        title: "Manual child without direct mission link",
        status: "todo",
        priority: "medium",
        identifier: "MS-3",
      },
      {
        id: manualGrandchildId,
        companyId,
        missionId: null,
        parentId: manualSubissueId,
        title: "Manual grandchild without direct mission link",
        status: "blocked",
        priority: "low",
        identifier: "MS-4",
      },
      {
        id: otherCompanySubissueId,
        companyId: otherCompanyId,
        missionId: null,
        parentId: childIssueId,
        title: "Other company child must not leak",
        status: "todo",
        priority: "low",
        identifier: "OT-1",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result).toHaveLength(4);
    expect(result.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([rootIssueId, childIssueId, manualSubissueId, manualGrandchildId]),
    );
    expect(result.map((issue) => issue.id)).not.toContain(otherCompanySubissueId);
    expect(result.find((issue) => issue.id === childIssueId)?.parentId).toBe(rootIssueId);
    expect(result.find((issue) => issue.id === manualSubissueId)?.parentId).toBe(childIssueId);
    expect(result.find((issue) => issue.id === manualGrandchildId)?.parentId).toBe(manualSubissueId);
  });

  it("returns mission issue tree with issue groups while preserving real parent-child relations", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const actionIssueId = randomUUID();
    const actionChildIssueId = randomUUID();
    const qaIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Grouped Issue Tree Company",
      issuePrefix: `GT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Action Worker",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Validator",
        role: "qa",
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
      title: "Grouped Mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        title: "[PLAN] Grouped Mission",
        status: "done",
        priority: "medium",
        identifier: "GT-1",
      },
      {
        id: actionIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: workerAgentId,
        originKind: "mission_action",
        title: "[ACTION] Gather source evidence",
        status: "todo",
        priority: "medium",
        identifier: "GT-2",
      },
      {
        id: actionChildIssueId,
        companyId,
        missionId: null,
        parentId: actionIssueId,
        assigneeAgentId: workerAgentId,
        originKind: "mission_action",
        title: "[ACTION] Subtask for one source packet",
        status: "todo",
        priority: "medium",
        identifier: "GT-3",
      },
      {
        id: qaIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: qaAgentId,
        originKind: "mission_qa",
        title: "[QA] Verify action evidence",
        status: "todo",
        priority: "high",
        identifier: "GT-4",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        parentId: null,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        title: "[OVERSIGHT] Failure and closeout decisions",
        status: "todo",
        priority: "medium",
        identifier: "GT-5",
      },
    ]);

    const result = await missionService(db).getIssueTree(missionId);

    expect(result.find((issue) => issue.id === planIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "plan" }));
    expect(result.find((issue) => issue.id === actionIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "action" }));
    expect(result.find((issue) => issue.id === actionChildIssueId)).toEqual(expect.objectContaining({ parentId: actionIssueId, issueGroup: "action" }));
    expect(result.find((issue) => issue.id === qaIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "qa" }));
    expect(result.find((issue) => issue.id === oversightIssueId)).toEqual(expect.objectContaining({ parentId: null, issueGroup: "oversight" }));
    const missionLevelSiblings = result.filter((issue) => issue.missionId === missionId && issue.parentId === null).map((issue) => issue.issueGroup).sort();
    expect(missionLevelSiblings).toEqual(["action", "oversight", "plan", "qa"]);
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
          type: "agent",
          agentId: "",
          agentName: "Workflow Owner",
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
        type: "agent",
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

  it("does not terminalize active workflow-created missions from legacy plugin-only terminal runs", async () => {
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

    expect(activeList.find((mission) => mission.id === missionId)?.status).toBe("active");
    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();
    expect(listed.find((mission) => mission.id === missionId)?.status).toBe("active");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("active");
    expect(stored?.completedAt).toBeNull();
  });

  it("auto-completes mission oversight when a linked native workflow run completes with no remaining work", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const workflowIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Completed Native Workflow Company",
      issuePrefix: `CN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Native workflow mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: workflowIssueId,
        companyId,
        missionId,
        title: "Finished workflow step",
        status: "done",
        priority: "medium",
        originKind: "workflow_execution",
        completedAt: new Date("2026-06-09T04:39:18.034Z"),
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Native workflow mission",
        status: "todo",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Native workflow",
      stepsJson: [{ id: "qa", name: "QA", agentId: ownerAgentId }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "completed",
      triggeredBy: "test",
      startedAt: new Date("2026-06-09T04:00:04.837Z"),
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "qa",
      issueId: workflowIssueId,
      status: "completed",
      startedAt: new Date("2026-06-09T04:38:38.108Z"),
      completedAt: new Date("2026-06-09T04:39:18.034Z"),
    });

    const detail = await missionService(db).getById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(detail.status).toBe("completed");
    expect(oversight?.status).toBe("done");
    expect(oversight?.completedAt).toEqual(new Date("2026-06-09T04:41:12.533Z"));
  });

  it("does not auto-complete mission oversight while non-oversight work remains open", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Open Work Oversight Company",
      issuePrefix: `OW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Completed mission with open work",
      status: "completed",
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        missionId,
        title: "Open follow-up",
        status: "todo",
        priority: "medium",
        originKind: "workflow_execution",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Completed mission with open work",
        status: "todo",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
      },
    ]);

    await missionService(db).getById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(oversight?.status).toBe("todo");
    expect(oversight?.completedAt).toBeNull();
  });

  it("cleans up mission runtime state when a mission is cancelled", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const secretId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Cancel Cleanup Company",
      issuePrefix: `CC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "ceo",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Mission Worker",
        role: "researcher",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(agentRuntimeState).values([
      {
        agentId: ownerAgentId,
        companyId,
        adapterType: "codex_local",
        sessionId: "owner-session",
        stateJson: {},
        lastRunStatus: "failed",
        lastError: "owner failed",
      },
      {
        agentId: workerAgentId,
        companyId,
        adapterType: "codex_local",
        sessionId: "worker-session",
        stateJson: {},
        lastRunStatus: "failed",
        lastError: "worker failed",
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Cancelable mission",
      status: "active",
    });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Clean up cancelled mission state",
      refs: {},
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      name: "mission-session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId: ownerAgentId,
      companyId,
      sessionSecretId: secretId,
      adapterType: "codex_local",
      status: "active",
      runCount: 1,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Open mission work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: workerAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerAgentId,
      issueId,
      invocationSource: "targeted_wakeup",
      status: "running",
      contextSnapshot: {},
    });

    const detail = await missionService(db).update(missionId, { status: "cancelled" });

    expect(detail.status).toBe("cancelled");
    expect(detail.activeMissionPlan.available).toBe(false);
    expect(detail.sessionBindings).toEqual([
      expect.objectContaining({ agentId: ownerAgentId, status: "closed" }),
    ]);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const agentRows = await db.select().from(agents).where(inArray(agents.id, [ownerAgentId, workerAgentId]));
    const runtimeRows = await db
      .select()
      .from(agentRuntimeState)
      .where(inArray(agentRuntimeState.agentId, [ownerAgentId, workerAgentId]));

    expect(issue?.status).toBe("cancelled");
    expect(issue?.cancelledAt).toBeTruthy();
    expect(run).toEqual(expect.objectContaining({
      status: "cancelled",
      errorCode: "cancelled",
    }));
    expect(agentRows.map((agent) => [agent.id, agent.status]).sort()).toEqual([
      [ownerAgentId, "idle"],
      [workerAgentId, "idle"],
    ].sort());
    expect(runtimeRows).toHaveLength(2);
    for (const row of runtimeRows) {
      expect(row.lastError).toBeNull();
      expect(row.sessionId).toBeNull();
    }
  });

  it("does not reactivate a completed workflow-created mission from legacy plugin run state", async () => {
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
      status: "failed",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "failed",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: "2026-04-28T00:10:29.987Z",
      },
    });

    const svc = missionService(db);
    const completedList = await svc.list({ companyId, status: "completed" });
    const detail = await svc.getById(missionId);
    const activeList = await svc.list({ companyId, status: "active" });

    expect(completedList.find((mission) => mission.id === missionId)?.status).toBe("completed");
    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-04-27T23:51:06.620Z"));
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("completed");
    expect(stored?.completedAt).toEqual(new Date("2026-04-27T23:51:06.620Z"));
  });

  it("does not reactivate an operator-completed workflow-created mission while a linked native run is still active", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Operator Completed Workflow Company",
      issuePrefix: `OC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-09 tech-scout",
      description: "Created automatically for workflow run: tech-scout",
      status: "completed",
      startedAt: new Date("2026-06-09T07:44:21.648Z"),
      completedAt: new Date("2026-06-09T11:39:30.000Z"),
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-scout",
      stepsJson: [{ id: "publish", name: "Publish", agentId: ownerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "running",
      triggeredBy: "board",
      startedAt: new Date("2026-06-09T07:44:21.655Z"),
      completedAt: null,
    });

    const svc = missionService(db);
    const detail = await svc.getById(missionId);
    const completedList = await svc.list({ companyId, status: "completed" });
    const activeList = await svc.list({ companyId, status: "active" });

    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-06-09T11:39:30.000Z"));
    expect(completedList.find((mission) => mission.id === missionId)?.status).toBe("completed");
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("completed");
    expect(stored?.completedAt).toEqual(new Date("2026-06-09T11:39:30.000Z"));
  });

  it("completes an active workflow-created mission from the latest native run despite stale plugin run state", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const failedRunId = randomUUID();
    const completedRunId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Native Workflow Reconcile Company",
      issuePrefix: `NW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-10 gazua-macro-sentinel",
      description: "Created automatically for workflow run: gazua-macro-sentinel",
      status: "active",
      startedAt: new Date("2026-06-10T01:00:00.000Z"),
      completedAt: null,
    });
    const oversightIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] 2026-06-10 gazua-macro-sentinel",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-macro-sentinel",
      stepsJson: [{ id: "collect", name: "Collect", agentId: ownerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values([
      {
        id: failedRunId,
        workflowId,
        companyId,
        missionId,
        status: "failed",
        triggeredBy: "schedule",
        createdAt: new Date("2026-06-10T01:00:00.000Z"),
        startedAt: new Date("2026-06-10T01:00:00.000Z"),
        completedAt: new Date("2026-06-10T01:05:00.000Z"),
      },
      {
        id: completedRunId,
        workflowId,
        companyId,
        missionId,
        status: "completed",
        triggeredBy: "schedule",
        createdAt: new Date("2026-06-10T02:00:00.000Z"),
        startedAt: new Date("2026-06-10T02:00:00.000Z"),
        completedAt: new Date("2026-06-10T02:08:00.000Z"),
      },
    ]);
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
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "legacy gazua-macro-sentinel run",
      status: "running",
      data: {
        workflowId,
        workflowName: "gazua-macro-sentinel",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        startedAt: "2026-06-10T00:00:00.000Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.getById(missionId);

    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));

    const [storedMission] = await db.select().from(missions).where(eq(missions.id, missionId));
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssue.id));
    expect(storedMission?.status).toBe("completed");
    expect(storedMission?.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));
    expect(storedOversight?.status).toBe("done");
    expect(storedOversight?.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));
  });

  it("cancels stale legacy plugin-only workflow-created missions with no native run", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy Plugin Reconcile Company",
      issuePrefix: `LP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-10 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    const oversightIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] 2026-06-10 gazua-watchlist-refresh",
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
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "legacy gazua-watchlist-refresh run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-watchlist-refresh",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        startedAt: "2020-01-01T00:00:00.000Z",
      },
      updatedAt: new Date("2020-01-01T00:05:00.000Z"),
    });

    const detail = await missionService(db).getById(missionId);

    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2020-01-01T00:05:00.000Z"));

    const [storedMission] = await db.select().from(missions).where(eq(missions.id, missionId));
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssue.id));
    expect(storedMission?.status).toBe("cancelled");
    expect(storedOversight?.status).toBe("cancelled");
    expect(storedOversight?.cancelledAt).toEqual(new Date("2020-01-01T00:05:00.000Z"));
  });

  it("does not promote a planning mission from legacy plugin workflow run state", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Workflow Promotion Company",
      issuePrefix: `PP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Manual mission with plugin execution",
      status: "planning",
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
      title: "failed workflow run",
      status: "failed",
      data: {
        workflowId: randomUUID(),
        workflowName: "manual-mission-workflow",
        companyId,
        missionId,
        status: "failed",
        triggerSource: "manual",
        startedAt: "2026-06-09T04:00:04.837Z",
        completedAt: "2026-06-09T04:23:25.320Z",
      },
    });

    const svc = missionService(db);
    const planningList = await svc.list({ companyId, status: "planning" });
    const detail = await svc.getById(missionId);
    const activeList = await svc.list({ companyId, status: "active" });

    expect(planningList.find((mission) => mission.id === missionId)?.status).toBe("planning");
    expect(detail.status).toBe("planning");
    expect(detail.startedAt).toBeNull();
    expect(detail.completedAt).toBeNull();
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("planning");
    expect(stored?.startedAt).toBeNull();
    expect(stored?.completedAt).toBeNull();
  });

  it("does not complete a planning mission only because linked plugin workflow runs are terminal", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Terminal Workflow Company",
      issuePrefix: `PT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning mission with completed plugin run",
      status: "planning",
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
      title: "completed workflow run",
      status: "completed",
      data: {
        workflowId: randomUUID(),
        workflowName: "manual-mission-workflow",
        companyId,
        missionId,
        status: "completed",
        triggerSource: "manual",
        startedAt: "2026-06-09T04:00:04.837Z",
        completedAt: "2026-06-09T04:23:25.320Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.getById(missionId);

    expect(detail.status).toBe("planning");
    expect(detail.startedAt).toBeNull();
    expect(detail.completedAt).toBeNull();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("planning");
    expect(stored?.startedAt).toBeNull();
    expect(stored?.completedAt).toBeNull();
  });

  it("does not reactivate an operator-cancelled workflow-created mission while a linked plugin run is still active", async () => {
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

    expect(cancelledList.find((mission) => mission.id === missionId)?.status).toBe("cancelled");
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
    expect(stored?.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
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
        type: "agent",
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
