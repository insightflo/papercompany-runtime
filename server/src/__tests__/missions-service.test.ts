import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companySecrets,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionDelegations,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionSessions,
  missions,
  pluginEntities,
  plugins,
  qualityReviewItems,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { extractMissionOwnerDecisionFromText, missionService } from "../services/missions.js";
import { buildQaReworkCapDescription } from "../services/missions/qa-rework-cap-oversight.js";
import { loadConsecutiveQaRejectTrend } from "../services/missions/qa-rework-cap-oversight-detection.js";
import { issueService } from "../services/issues.js";
import { missionDelegationService } from "../services/mission-delegations.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import {
  recordMissionOwnerDecision,
  type MissionOwnerDecisionSubmission,
} from "../services/missions/mission-owner-recovery-ledger.js";
import { hashOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

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
    await db.delete(activityLog);
    await db.delete(missionDelegations);
    await db.delete(issueWorkProducts);
    await db.delete(pluginEntities);
    await db.delete(missionPlanArtifacts);
    await db.delete(missionSessions);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySecrets);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function recordOwnerDecision(input: {
    companyId: string;
    missionId: string;
    ownerActionIssueId: string;
    ownerAgentId: string;
    sourceIssueId: string;
    submission: MissionOwnerDecisionSubmission;
  }) {
    const now = new Date();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.ownerAgentId,
      issueId: input.ownerActionIssueId,
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    }).returning({ id: heartbeatRuns.id });
    return recordMissionOwnerDecision({
      db,
      issue: {
        id: input.ownerActionIssueId,
        companyId: input.companyId,
        missionId: input.missionId,
      },
      submission: input.submission,
      sourceIssueId: input.sourceIssueId,
      heartbeatRunId: run!.id,
    });
  }
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
    for (const expected of [
      "POST /api/issues/{planningIssueId}/mission-plan-decision",
      "use `graphWorkProductRequired: false` only for pure condition/input-check/QA units",
      "keep the upstream producer unit true when a downstream unit validates",
    ]) expect(planningIssue?.description).toContain(expected);
    expect(planningIssue?.description).toContain("A Markdown `### Mission owner plan decision` comment is display-only");
    expect(planningIssue?.description).not.toContain("Post exactly one structured `### Mission owner plan decision` JSON comment");
    expect(planningIssue?.description).toContain("\"assigneeAgentId\":\"agent-id-from-roster\"");
    expect(planningIssue?.description).toContain(`Main Executor (operator) id=${ownerAgentId} [mission owner]`);
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
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

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
      description: "Create the daily Tech AI News note, validate the artifact, then deliver it after approval.",
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
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      description: "Daily TechCrunch AI research workflow.",
      stepsJson: [
        { id: "collect-news", name: "Collect news", agentId: workerAgentId, dependencies: [] },
        { id: "generate-infographic", name: "Generate infographic", agentId: workerAgentId, dependencies: ["collect-news"] },
        { id: "validate-ai-news-artifact", name: "Validate AI news artifact", agentId: workerAgentId, dependencies: ["generate-infographic"] },
        { id: "send-telegram", name: "Send Telegram", agentId: ownerAgentId, dependencies: ["validate-ai-news-artifact"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "schedule",
      status: "failed",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
      completedAt: new Date("2026-06-14T06:17:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId,
        stepId: "collect-news",
        issueId: null,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:03:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "generate-infographic",
        issueId: null,
        status: "completed",
        startedAt: new Date("2026-06-14T06:03:00.000Z"),
        completedAt: new Date("2026-06-14T06:12:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "validate-ai-news-artifact",
        issueId: blockedIssue.id,
        status: "failed",
        startedAt: new Date("2026-06-14T06:12:00.000Z"),
        completedAt: new Date("2026-06-14T06:17:00.000Z"),
      },
      {
        workflowRunId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: blockedIssue.id,
      type: "obsidian_note",
      provider: "local-filesystem",
      title: "20260614 Tech AI News Obsidian note",
      status: "ready_for_review",
      isPrimary: true,
      metadata: {
        artifactPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260614.md",
      },
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: blockedIssue.id,
      authorAgentId: workerAgentId,
      body: "REQUEST_CHANGES: regenerate the infographic before delivery; 3 hallucinated panels and 8 missing source articles remain.",
      createdAt: new Date("2026-06-14T06:18:00.000Z"),
      updatedAt: new Date("2026-06-14T06:18:00.000Z"),
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
        parentId: null,
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
    expect(description).toContain("Mission execution digest:");
    expect(description).toContain("- Mission description: Create the daily Tech AI News note, validate the artifact, then deliver it after approval.");
    expect(description).toContain(`- Workflow run: tech-ai-news (${workflowRunId}) status=failed`);
    expect(description).toContain("- Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped");
    expect(description).toContain("- Step validate-ai-news-artifact (Validate AI news artifact) status=failed");
    expect(description).toContain("- Step send-telegram (Send Telegram) status=skipped");
    expect(description).toContain("- Work product");
    expect(description).toContain("20260614 Tech AI News Obsidian note");
    expect(description).toContain("REQUEST_CHANGES: regenerate the infographic before delivery");
    expect(description).toContain("Mission-owner signal from oversight. This is a wakeup plus basic state/evidence; the main executor must judge and act to complete the mission.");
    expect(description).toContain("Main executor brief:");
    expect(description).toContain("- You own mission execution. Your goal is to complete the mission, not merely classify the alert.");
    expect(description).toContain("Mission goal: Blocked workflow mission");
    expect(description).toContain("Current situation: Source issue");
    expect(description).toContain("Main executor role:");
    expect(description).toContain("Mission execution loop:");
    expect(description).toContain("- Inspect the mission goal, plan, workflow/step state, issue tree, comments, work products, and run logs.");
    expect(description).toContain("- Choose and perform the action that best advances the mission: instruct or wake agents, request fixes, retry/resume bounded work, request/re-run tool steps, revalidate outputs, replan, escalate, or report impossible completion with evidence.");
    expect(description).toContain("Oversight signal boundary:");
    expect(description).toContain("- Treat this issue as a wakeup plus basic state/evidence from oversight. Oversight is not the recovery decision-maker.");
    expect(description).toContain("- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.");
    expect(description).toContain("- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.");
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
    expect(description).toContain("Decision authority (REQUIRED control path): submit your decision through the structured API, not a comment:");
    expect(description).toContain("POST /api/issues/{this owner-action issue id}/owner-recovery/decision");
    expect(description).toContain("Optional display-only comment template");
    expect(description).toContain("Comments (including any 'Decision:' block below) are DISPLAY-ONLY and can no longer drive recovery");
    expect(description).toContain("Source issue remains assigned to the original executor unless the structured decision is reassign_source_issue with targetAgentId.");
    expect(description).toContain("targetAgentId is REQUIRED");
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

    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue!.originId!, requestedAt: new Date() });
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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue!.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "The owner confirmed the blocker is transient and the source executor should retry later.",
        nextAction: "Re-dispatch source issue after explicit approval.",
        evidence: "Source issue comment and mission owner review.",
      },
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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "Owner confirmed the blocker has cleared.",
        nextAction: "Retry the source issue without reassignment.",
        evidence: "Owner reviewed blocker details.",
      },
    });

    const readOnlyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(readOnlyResult.appliedActions).toEqual([]);
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));

    const applyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(applyResult.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", missionId, ownerActionIssueId: unblockIssue.id, sourceIssueId: blockedIssue.id, resultStatus: "blocked" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, blockedIssue.id))).resolves.toHaveLength(0);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    expect(sourceComments.map((comment) => comment.body).join("\n")).not.toContain("mission-owner-decision-applied");
    expect(sourceComments.map((comment) => comment.body).join("\n")).toContain("request native workflow resume");
    expect(sourceComments.map((comment) => comment.body).join("\n")).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("[Patch 2 cap-exhausted] native-loop producer at rework cap → AUTO retry_source_issue NOT skipped; producer reopen unauthorized → request_replan", async () => {
    // 회귀 대상: producer rework cap(maxIterations) 이 소진된 native-loop 미션에서 AUTO(grace default)
    //   retry_source_issue 가 기존엔 owner_action_skipped_native_loop 로 막혀 매달리고 있었다.
    //   기대: cap 소진 시 guard 가 skip 을 풀고 owner_action_native_loop_cap_exhausted finding + producer 재오픈.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Cap Exhausted Company", issuePrefix: `CE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Cap exhausted mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "cap-exhausted-loop",
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId: producerAgentId, dependencies: [], conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 1 }], description: "Produce the artifact" },
        { id: "qa-validate", name: "Validate the produced artifact", agentId: qaAgentId, dependencies: ["produce"], description: "QA gate" },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T07:00:00.000Z") });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "cap-exhausted: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "cap-exhausted: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: 1, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", iterationIndex: 0, startedAt: new Date("2026-06-18T07:03:00.000Z"), completedAt: new Date("2026-06-18T07:10:00.000Z") },
    ]);
    // producer iterationIndex=1 == maxIterations=1 → cap exhausted.

    const svc = missionService(db, {});
    // 1차 supervision: qaIssue 가 blocked+stale → unblock issue 생성(originId=qaIssue).
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0] ?? null);
    expect(unblockIssue).toBeTruthy();
    expect(unblockIssue!.originId).toBe(qaIssueId);
    // grace window(20min) 을 넘기기 위해 unblock issue 의 createdAt 을 과거로 세팅(AUTO default 유도).
    //   이 케이스는 structured owner decision 이 없을 때의 grace-default AUTO 경로 회귀 — ledger 기록 없음.
    await db.update(issues).set({ createdAt: new Date("2026-06-18T07:00:00.000Z") }).where(eq(issues.id, unblockIssue!.id));

    // 2차 supervision (applyOwnerDecisionActions + grace 초과) → AUTO retry_source_issue 발화.
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true });

    // cap exhausted → skip 안 함(owner_action_native_loop_cap_exhausted finding). 단 producer reopen 은
    //   authorizeProducerRework(explicit target/fresh RC 없음 → unauthorized) 로 차단 → request_replan(codex nuance).
    expect(result.findings.join("\n")).toContain("owner_action_native_loop_cap_exhausted");
    expect(result.findings.join("\n")).not.toContain("owner_action_skipped_native_loop");
    expect(result.findings.join("\n")).toContain("producer_rework_unauthorized");
    expect(result.appliedActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: producerIssueId }),
    ]));
    const producerAfter = await db.select().from(issues).where(eq(issues.id, producerIssueId)).then((rows) => rows[0]!);
    expect(producerAfter.status).toBe("done");
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: producerIssueId }),
    ]));
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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry anyway",
      },
    });

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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry and wake once"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry and wake once",
      },
    });

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
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });

  it("applies reassign_source_issue to the source issue and wakes the new assignee", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const operationsAgentId = randomUUID();
    const synthesisAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reassign", runId: "run-reassign" });

    await db.insert(companies).values({ id: companyId, name: "Wake Reassign Company", issuePrefix: `WA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      {
        id: operationsAgentId,
        companyId,
        name: "Hermes Operations Manager",
        role: "pm",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { domain: "operations", operatingMode: "chief_of_staff_liaison" },
        permissions: {},
      },
      { id: synthesisAgentId, companyId, name: "Synthesis Editor", role: "pm", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { domain: "synthesis" }, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake reassign mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: operationsAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Publish approved manual" });
    const staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: operationsAgentId,
      issueId: sourceIssue.id,
      invocationSource: "assignment",
      status: "failed",
      startedAt: new Date("2026-06-28T03:06:44.526Z"),
      finishedAt: new Date("2026-06-28T03:07:44.526Z"),
      createdAt: new Date("2026-06-28T03:06:44.502Z"),
    });
    await db.update(issues).set({
      assigneeUserId: randomUUID(),
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionAgentNameKey: "hermes-operations-manager",
      executionLockedAt: new Date("2026-06-28T03:06:44.526Z"),
      completedAt: new Date("2026-06-28T03:07:44.526Z"),
      cancelledAt: new Date("2026-06-28T03:08:44.526Z"),
    }).where(eq(issues.id, sourceIssue.id));
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Reassign publish source" });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: reassign_source_issue",
        `Source issue: ${sourceIssue.identifier}`,
        "Reason: Hermes is a liaison and must not directly execute the publish issue.",
        `Next action: Reassign ${sourceIssue.identifier} to Synthesis Editor ${synthesisAgentId} and wake it.`,
      ].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "reassign_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        targetAgentId: synthesisAgentId,
        reason: "Hermes is a liaison and must not directly execute the publish issue.",
        nextAction: `Target agent: ${synthesisAgentId}`,
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:reassign_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({
        id: sourceIssue.id,
        assigneeAgentId: synthesisAgentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
      targetAgentId: synthesisAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_reassign_source_issue",
        sourceIssueId: sourceIssue.id,
        previousAgentId: operationsAgentId,
        targetAgentId: synthesisAgentId,
        wakeupDispatchStatus: "dispatched",
        idempotencyKey,
      }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({
      status: "todo",
      assigneeAgentId: synthesisAgentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
      cancelledAt: null,
    }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id)).then((rows) => rows.map((comment) => comment.body).join("\n"));
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("reassign_source_issue");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });

  it("carries the latest REQUEST_CHANGES summary into retry_source_issue comments and wake context", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-qa-summary", runId: "run-qa-summary" });

    await db.insert(companies).values({ id: companyId, name: "Retry QA Summary Company", issuePrefix: `RQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry QA summary mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Synthesize report draft",
    });
    const requestChangesSummary = "REQUEST_CHANGES: Tables in Top25 전체 표 have incorrect column counts because the 비고 column contains unescaped pipe characters.";
    const ownerAction = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      description: [
        "Mission-owner signal from validation gate.",
        "",
        "### Validation excerpt",
        "```text",
        requestChangesSummary,
        "```",
      ].join("\n"),
      missionId,
      originKind: "mission_main_executor_unblock",
      originId: sourceIssue.id,
      status: "done",
      title: "Retry report producer after QA request changes",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry with latest QA summary"].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry with latest QA summary",
      },
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-30T23:40:00.000Z"),
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: workerAgentId,
      decisionCommentId: expect.any(String),
    }));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("Latest REQUEST_CHANGES summary");
    expect(sourceBody).toContain(requestChangesSummary);
  });
  it("bundles original source instruction + active workProducts + latest REQUEST_CHANGES into the retry wake context (inactive/foreign excluded)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-bundle-ctx", runId: "run-bundle-ctx" });

    await db.insert(companies).values({ id: companyId, name: "Retry Bundle Context Company", issuePrefix: `RB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry bundle context mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });

    const distinctiveInstruction = "Distinctive-ORIG-INSTRUCTION: rebuild the Top25 table generator so every 비고 cell escapes pipe characters before rendering.";
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Synthesize distinctive report draft",
      description: distinctiveInstruction,
    });

    const activeProductTitle = "Distinctive-ACTIVE-PRODUCT tech-ai-news obsidian note";
    const activeProductUrl = "https://example.test/distinctive/active.md";
    const activeProductExternalId = "/distinctive/artifacts/active-note.md";
    const activeProductMetadataPath = "/distinctive/vault/active-note.md";
    const inactiveProductTitle = "Distinctive-INACTIVE-PRODUCT archived superseded draft (must be excluded)";
    const foreignMissionProductTitle = "Distinctive-FOREIGN-MISSION-PRODUCT same company different mission (must be excluded)";
    const foreignCompanyProductTitle = "Distinctive-FOREIGN-COMPANY-PRODUCT different company (must be excluded)";

    await db.insert(issueWorkProducts).values({ companyId, issueId: sourceIssue.id, type: "local_file", provider: "local_file", title: activeProductTitle, url: activeProductUrl, externalId: activeProductExternalId, metadata: { path: activeProductMetadataPath }, status: "active" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: sourceIssue.id, type: "local_file", provider: "local_file", title: inactiveProductTitle, url: "https://example.test/distinctive/inactive.md", status: "archived" });

    // same company, different mission + different source issue — must be excluded by mission+source scope.
    const foreignMissionId = randomUUID();
    await db.insert(missions).values({ id: foreignMissionId, companyId, ownerAgentId, title: "Foreign mission", status: "active" });
    const foreignMissionSourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId: foreignMissionId, originKind: "workflow_execution", status: "todo", title: "Foreign mission source issue" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: foreignMissionSourceIssue.id, type: "local_file", provider: "local_file", title: foreignMissionProductTitle, url: "https://example.test/distinctive/foreign-mission.md", status: "active" });

    // true foreign-COMPANY isolation: active product in a different company must be excluded by company scope.
    const foreignCompanyId = randomUUID();
    const foreignCompanyAgentId = randomUUID();
    const foreignCompanyMissionId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign Company", issuePrefix: `FC${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: foreignCompanyAgentId, companyId: foreignCompanyId, name: "Foreign Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: foreignCompanyMissionId, companyId: foreignCompanyId, ownerAgentId: foreignCompanyAgentId, title: "Foreign company mission", status: "active" });
    const foreignCompanySourceIssue = await issueService(db).create(foreignCompanyId, { assigneeAgentId: foreignCompanyAgentId, missionId: foreignCompanyMissionId, originKind: "workflow_execution", status: "todo", title: "Foreign company source issue" });
    await db.insert(issueWorkProducts).values({ companyId: foreignCompanyId, issueId: foreignCompanySourceIssue.id, type: "local_file", provider: "local_file", title: foreignCompanyProductTitle, url: "https://example.test/distinctive/foreign-company.md", status: "active" });

    const requestChangesSummary = "REQUEST_CHANGES: Distinctive-RC regenerate the infographic; 3 hallucinated panels and 8 missing source articles remain.";
    const ownerAction = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      description: [
        "Mission-owner signal from validation gate.",
        "",
        "### Validation excerpt",
        "```text",
        requestChangesSummary,
        "```",
      ].join("\n"),
      missionId,
      originKind: "mission_main_executor_unblock",
      originId: sourceIssue.id,
      status: "done",
      title: "Retry report producer with bundled context",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry with full source context"].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry with full source context",
      },
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T01:30:00.000Z"),
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: workerAgentId,
    }));

    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    // (1) original source issue title + description
    expect(sourceBody).toContain("Original source issue instruction:");
    expect(sourceBody).toContain("Title: Synthesize distinctive report draft");
    expect(sourceBody).toContain(distinctiveInstruction);
    // (2) that source issue's own active workProducts — title + url + externalId + metadata path
    expect(sourceBody).toContain("Active workProducts on this source issue");
    expect(sourceBody).toContain(activeProductTitle);
    expect(sourceBody).toContain(`url=${activeProductUrl}`);
    expect(sourceBody).toContain(`externalId=${activeProductExternalId}`);
    expect(sourceBody).toContain(`path=${activeProductMetadataPath}`);
    // (3) exact latest REQUEST_CHANGES feedback
    expect(sourceBody).toContain("Latest REQUEST_CHANGES summary");
    expect(sourceBody).toContain(requestChangesSummary);
    // inactive product excluded (status != active)
    expect(sourceBody).not.toContain(inactiveProductTitle);
    // same-company different mission/source excluded (mission+source scope)
    expect(sourceBody).not.toContain(foreignMissionProductTitle);
    // true foreign-company isolation excluded (company scope)
    expect(sourceBody).not.toContain(foreignCompanyProductTitle);
  });

  it("marks retry_source_issue wakeup handled when workflow resume already dispatched it", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({
      status: "workflow_already_dispatched",
      workflowWakeupRequestId: "workflow-wake-1",
      runId: "workflow-run-1",
    });

    await db.insert(companies).values({ id: companyId, name: "Workflow Handled Retry Company", issuePrefix: `WH${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Workflow handled retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked workflow source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry via workflow wake"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry via workflow wake",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${unblockIssue.id}:${blockedIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: workerAgentId, idempotencyKey }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, wakeupDispatchStatus: "workflow_already_dispatched", idempotencyKey }),
    ]));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("Mission owner retry wakeup handled by workflow");
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

  it("active supervision materializes an unrecorded PLAN decision into a PAQO workflow", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Plan Materialization Recovery Company", issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "running", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan materialization recovery mission", status: "active" });
    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Plan Materialization Recovery Workflow" } });
    const [planningIssue] = await db.insert(issues).values({
      companyId,
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_plan",
      status: "done",
      title: "[PLAN] Plan materialization recovery mission",
    }).returning();
    // Structured authority only: seed the dedicated submission ledger without materializing.
    // Natural-language plan-decision comments are display-only and are never execution authority.
    const decision = {
      missionId,
      missionGoal: "Recover missing PAQO materialization",
      selectedExecutionUnits: [{
        id: "unit-recover",
        kind: "mission_plan_unit",
        title: "[ACTION] Recover execution",
        assigneeAgentId: workerAgentId,
        selectionState: "selected",
        sourceRef: { type: "mission_plan_unit", id: "unit-recover" },
        dependsOn: [],
      }],
      requiredInputs: [],
      successCriteria: ["workflow materialized"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({
      db,
      companyId,
      missionId,
      planningIssueId: planningIssue!.id,
      authorAgentId: ownerAgentId,
      sourceCommentId: null,
      decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      decision,
      status: "submitted",
    });

    const result = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:10:00.000Z"),
      applySafeActions: true,
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_decision_not_materialized"),
    ]));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "materialize_plan_decision", missionId, resultStatus: "plan_qa_pending" }),
    ]));
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId))).toHaveLength(0);

    const [activePlan] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .then((plans) => plans.filter((plan) => plan.status === "active"));
    const planQa = (activePlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string; decisionHash?: string } | undefined;
    expect(planQa).toMatchObject({ issueId: expect.any(String), status: "pending" });
    // Structured PLAN-QA PASS (comment PASS text is not authority).
    await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: planQa!.issueId!,
      decisionHash: planQa!.decisionHash ?? hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      verdict: "pass",
      reviewedBy: { actorType: "user", actorId: "board-user-test" },
    });

    const approved = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:12:00.000Z"),
      applySafeActions: true,
    });
    expect(approved.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "materialize_plan_decision", missionId, resultStatus: "recorded" }),
    ]));
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs).toEqual([expect.objectContaining({ status: "running" })]);

    const followUp = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(followUp.findings.join("\n")).not.toContain("plan_gate_not_ready");
    expect(followUp.findings.join("\n")).not.toContain("plan_outdated");
  });

  it("active supervision reopens a completed PLAN issue when the planning run succeeded without a structured submission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Submission Missing Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning submission missing mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "PS-PLAN",
        title: "[PLAN] Planning submission missing mission",
        status: "done",
        completedAt: new Date("2026-06-28T03:11:09.147Z"),
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "PS-OVERSIGHT",
        title: "[OVERSIGHT] Planning submission missing mission",
        status: "todo",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-06-28T03:06:44.526Z"),
      finishedAt: new Date("2026-06-28T03:11:09.108Z"),
      createdAt: new Date("2026-06-28T03:06:44.502Z"),
    });
    await db.update(issues).set({
      checkoutRunId: succeededRunId,
      executionRunId: succeededRunId,
      executionAgentNameKey: "mission-owner",
      executionLockedAt: new Date("2026-06-28T03:06:44.526Z"),
    }).where(eq(issues.id, planIssueId));

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_submission_missing"),
    ]));

    // Phase 5 connection: the oversight stall must auto-create a company-scoped quality review item.
    const oversightQualityItems = await db
      .select()
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.missionId, missionId));
    expect(oversightQualityItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        missionId,
        triggerSource: "oversight_stall",
        targetType: "mission_output",
        failureType: "plan_submission_missing",
      }),
    ]));
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_missing", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_missing",
        planIssueId,
        succeededRunId,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const [storedPlanIssue] = await db.select().from(issues).where(eq(issues.id, planIssueId));
    expect(storedPlanIssue).toEqual(expect.objectContaining({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission required"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: `mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`,
      wakeCommentId: expect.any(String),
    }));

    await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
  });

  it("active supervision reopens PLAN with rejected submission reason instead of missing-submission wording", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const planQaIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const decisionHash = "rejected-decision-hash";
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Rejected Submission Company",
      issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Rejected submission mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "RS-PLAN",
        title: "[PLAN] Rejected submission mission",
        status: "done",
        completedAt: new Date("2026-07-04T03:11:09.147Z"),
      },
      {
        id: planQaIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_plan_qa",
        identifier: "RS-QA",
        title: "[QA] Rejected submission mission plan",
        status: "done",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "RS-OVERSIGHT",
        title: "[OVERSIGHT] Rejected submission mission",
        status: "todo",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-07-04T03:06:44.526Z"),
      finishedAt: new Date("2026-07-04T03:11:09.108Z"),
      createdAt: new Date("2026-07-04T03:06:44.502Z"),
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "rejected-submission-workflow",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-07-04T03:12:00.000Z"),
    });
    await db.insert(missionPlanDecisionSubmissions).values({
      companyId,
      missionId,
      planningIssueId: planIssueId,
      authorAgentId: ownerAgentId,
      sourceRunId: succeededRunId,
      decisionHash,
      decision: { selectedExecutionUnits: [] },
      status: "rejected",
      rejectionReason: "invalid_selected_execution_unit_source_ref",
      diagnostics: [{ code: "workflow_definition_not_found", message: "Workflow definition missing" }],
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-04T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings.join("\n")).toContain("plan_submission_rejected");
    expect(missionResult?.findings.join("\n")).not.toContain("plan_submission_missing");
    expect(missionResult?.findings.join("\n")).toContain("workflow_definition_not_found");
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_rejected",
        planIssueId,
        decisionHash,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission rejected"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: expect.stringMatching(new RegExp(`^mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-[a-f0-9]{12}$`)),
      wakeCommentId: expect.any(String),
    }));
  });

  it("does not treat a reusable workflow mission without a PLAN issue as missing plan submission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Mission Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Reusable workflow mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Reusable Workflow",
      stepsJson: [{ id: "run", name: "Run", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "manual",
      status: "completed",
      completedAt: new Date("2026-06-28T03:10:00.000Z"),
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      missionIds: [missionId],
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });

    // [settlement contract] 실행이 완료된 재사용 워크플로 미션은 이제 정리(settle) 대상이다:
    //   선택되어 mission 이 completed 로 수렴하지만, plan 이슈 생성/누락 취급은 여전히 하지 않는다.
    expect(result.missionIds).toContain(missionId);
    expect(onPlanSubmissionMissing).not.toHaveBeenCalled();
    const planIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_plan"));
    expect(planIssues).toHaveLength(0);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settleActions = result.missions[0]?.appliedActions.filter((action) => action.type === "mission_settled_from_workflow_runs") ?? [];
    expect(settleActions).toHaveLength(1);
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
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action with no heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_no_execution"),
      expect.stringContaining(ownerAction.identifier ?? ownerAction.id),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
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
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action after failed heartbeat" });
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
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("keeps unblock owner actions flat when the source issue is already nested", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Nested Source Unblock Company", issuePrefix: `NS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Nested source unblock mission", status: "active" });

    const parentIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Parent source" });
    const nestedSource = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, parentId: parentIssue.id, originKind: "manual", status: "blocked", title: "Nested source" });

    const ownerAction = await missionService(db).ensureMainExecutorUnblockIssue(
      (await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]!)),
      nestedSource,
    );

    expect(ownerAction).toEqual(expect.objectContaining({
      originKind: "mission_main_executor_unblock",
      originId: nestedSource.id,
      parentId: null,
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

  it("treats a todo source with a pending queued execution-request as waiting, not stale (Phase 1.5)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Queue Wait Company", issuePrefix: `QW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Queue wait mission", status: "active" });
    const svc = missionService(db);
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source with pending queue request" });
    // 옛날 createdAt → ageMs 가 staleAfter(1min) 를 넘게(10min).
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    // pending execution-request (wakeup queue): status=queued, runId=null, payload.issueId=source.
    // requestedAt 를 now 기준 2min 전으로 → TTL(staleAfter*4=4min) 이내 → 대기 상태.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: workerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: sourceIssue.id },
      status: "queued",
      runId: null,
      requestedAt: new Date("2026-06-02T00:08:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    // [AREA: wakeup queue / Phase 1.5] pending queue request 가 있으므로 대기로 해석, stale 오판 방지.
    expect(findings).toContain("queued_waiting_for_execution");
    expect(findings).not.toContain("stale_todo_no_active_execution");
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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry stale todo after failed execution",
      },
    });

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

  it("dispatches a workProduct-reuse wake when a blocked producer has no workProduct, a stalled recovery, and the artifact file exists", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse", runId: "run-reuse" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Company", issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });

    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer (no workProduct)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });

    // recovery (unblock) issue for the source whose heartbeat run timed out (RES-350 scenario)
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });

    // expected artifact file already exists under the step output dir (registration is the only gap)
    const stepOutputDir = path.join(workProductRoot, "missions", missionId, "runs", workflowRunId, "steps", stepId);
    const artifactPath = path.join(stepOutputDir, "index.html");
    mkdirSync(stepOutputDir, { recursive: true });
    writeFileSync(artifactPath, "<html>report</html>");
    // (no issueWorkProducts inserted for the source -> listForIssue is empty)

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });
    const idempotencyKey = `mission-workproduct-reuse-wakeup:${missionId}:${sourceIssue.id}:${artifactPath}`;

    expect(result.missionIds).toContain(missionId);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: producerAgentId,
      artifactPath,
      stalledRecoveryIssueId: recoveryIssue.id,
      idempotencyKey,
    }));
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workproduct_reuse_wakeup", sourceIssueId: sourceIssue.id, artifactPath, idempotencyKey }),
    ]));
    const sourceCommentRows = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceCommentRows.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("workProduct-reuse wakeup dispatched");
    expect(sourceBody).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(sourceBody).toContain("This is the only registration authority.");
    expect(sourceBody).toContain(artifactPath);
    expect(sourceBody).toContain("or an `[ARTIFACT]` marker to register");
    expect(sourceBody).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(sourceBody).not.toContain(`[ARTIFACT]: ${artifactPath}`);
    expect(sourceBody).toContain(idempotencyKey);
    const reuseEvents = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.idempotencyKey, idempotencyKey));
    expect(reuseEvents).toHaveLength(1);

    // idempotent: a second sweep must NOT dispatch another reuse wake
    await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:05:00.000Z") });
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);

    rmSync(workProductRoot, { recursive: true, force: true });
  });

  it("does not dispatch a workProduct-reuse wake when the artifact file is absent (no fake success)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse-2", runId: "run-reuse-2" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-noop-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Noop Company", issuePrefix: `WN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse noop mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow Noop", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer noop (no workProduct, no file)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer noop" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });
    // intentionally DO NOT create the artifact file -> wake must not fire

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });

    expect(onWorkProductReuseWakeRequested).not.toHaveBeenCalled();
    expect((result.missions[0]?.appliedActions ?? []).filter((action) => action.type === "workproduct_reuse_wakeup")).toEqual([]);

    rmSync(workProductRoot, { recursive: true, force: true });
  });

  it("dispatches a retry_source_issue wakeup when an earlier apply marker exists without a dispatch marker", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-late" });
    await db.insert(companies).values({ id: companyId, name: "Late Wake Dispatch Company", issuePrefix: `LW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Late wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Previously applied source" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry applied without dispatch" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry once then dispatch later"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry once then dispatch later",
      },
    });

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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "corrected child PNG is ready; run validator again",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_apply",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:apply`,
      payload: { sourceIssueId: sourceIssue.id },
    });
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
      decisionCommentId: expect.any(String),
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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry once"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry once",
      },
    });

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

  it("reopens owner action when an already-applied producer retry leaves the gate blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Retry Unresolved Company", issuePrefix: `RU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry unresolved mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "retry-unresolved-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });

    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: ownerAction.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner decision",
          "Decision: retry_source_issue",
          `Source issue: ${qaIssue.identifier}`,
          `Rework target: ${producerIssue.identifier}`,
          "Reason: producer must provide signal-analysis evidence before QA can complete.",
        ].join("\n"),
      },
      {
        companyId,
        issueId: producerIssue.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner retry applied",
          `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: producerIssue.id, decision: "retry_source_issue" })} -->`,
          "Action: retry_source_issue already reopened this producer once.",
        ].join("\n"),
      },
    ]);
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: qaIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: qaIssue.identifier ?? qaIssue.id,
        reworkTargetRef: producerIssue.identifier ?? producerIssue.id,
        reason: "producer must provide signal-analysis evidence before QA can complete.",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_wakeup",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`,
      toStatus: "dispatched",
      payload: { sourceIssueId: producerIssue.id },
    });

    const svc = missionService(db, { onOwnerActionCreated });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(result.findings.join("\n")).toContain("owner_action_retry_unresolved_escalated");
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: qaIssue.id, safeToAutoApply: false }),
      expect.objectContaining({ type: "escalate_blocked", issueId: ownerAction.id, safeToAutoApply: false }),
    ]));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_unresolved",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        blockedIssueId: qaIssue.id,
        resultStatus: "todo",
        wakeupDispatchStatus: "dispatched",
      }),
    ]));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      issue: expect.objectContaining({ id: ownerAction.id }),
      sourceIssue: expect.objectContaining({ id: qaIssue.id }),
      reason: "mission_unblock_action_stalled",
    }));
    await expect(db.select().from(issues).where(eq(issues.id, ownerAction.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "todo", completedAt: null }));
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(db.select().from(issues).where(eq(issues.id, qaIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked" }));
    const ownerActionBody = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerAction.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(ownerActionBody).toContain("mission-owner-retry-unresolved");
    expect(ownerActionBody).toContain("Required next decision");

    onOwnerActionCreated.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:01:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).toContain("owner_action_retry_unresolved_already_escalated");
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
    const ownerActionBodies = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerAction.id));
    expect(ownerActionBodies.filter((row) => row.body.includes("mission-owner-retry-unresolved"))).toHaveLength(1);
  });

  it("settles an orphaned active mission whose run completed and only the oversight issue remains open", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");

    await db.insert(companies).values({ id: companyId, name: "Settlement Orphan Company", issuePrefix: `SO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settlement orphan mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "settle-orphan",
      stepsJson: [
        { id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    const oversightIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settle-orphan" });

    const svc = missionService(db, {});
    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-08-15T14:50:00.000Z"),
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    // 선택: 실행은 완료됐지만 oversight 만 열려 있으면 settlement 후보로 감독 스윕에 들어와야 한다.
    expect(result.missionIds).toContain(missionId);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settledOversight = await db.select().from(issues).where(eq(issues.id, oversightIssue.id)).then((rows) => rows[0]);
    expect(settledOversight?.status).toBe("done");
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mission_settled_from_workflow_runs", missionId, resultStatus: "completed" }),
    ]));
  });

  it("requests mission closeout once when a terminal workflow run leaves the mission active (closeout bridge)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");
    const onMissionTerminalRunCloseoutWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Closeout Bridge Company", issuePrefix: `CB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Closeout bridge mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "closeout-bridge",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] closeout-bridge" });
    // 열린 비-oversight 이슈 → settlement 차단(종결 브리지가 대신 발동해야 하는 상황).
    await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "todo", title: "Residual open work" });
    // plan 은 아직 running → rule_mismatch + terminal run → closeout bridge.
    await db.insert(missionPlanArtifacts).values({
      companyId, missionId, revision: 1, status: "active", ownerAgentId,
      missionGoal: "Closeout bridge plan", refs: { executionUnits: [{ sourceRef: { type: "native_workflow_run", id: workflowRunId }, status: "running" }] },
      assumptions: [], requiredInputs: [], successCriteria: [], risks: [], steps: [],
    });

    const svc = missionService(db, { onMissionTerminalRunCloseoutWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:50:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain(`rule_mismatch: plan unit=native_workflow_run:${workflowRunId} status=running runtime_status=completed`);
    expect(first.findings.join("\n")).toContain(`workflow_run_terminal_closeout_wake_requested: run=${workflowRunId} status=completed`);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: workflowRunId, status: "completed" },
      planUnitKey: `native_workflow_run:${workflowRunId}`,
    }));
    // mission 은 여전히 active(열린 owner work) — 종결은 오너 몫.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "active" }));

    // 멱등: 두 번째 스윕에는 재발사하지 않는다(마커 클레임).
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:55:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("workflow_run_terminal_closeout_wake_requested");
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
  });

  it("re-wakes the owner once when a recorded retry decision keeps failing to dispatch (dispatch-stall escalation)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    // 재발사가 계속 not_requested 로 실패하는 상황(원 사고: 6시간 무응답).
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "not_requested", reason: "cap_override_no_marker" });
    const onOwnerDecisionDispatchStalledWakeRequested = vi.fn().mockResolvedValue(undefined);

    await db.insert(companies).values({ id: companyId, name: "Stalled Escalation Company", issuePrefix: `SE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stalled escalation mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "stalled-escalation-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values({
      companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${qaIssue.identifier}`, `Rework target: ${producerIssue.identifier}`, "Reason: producer must fix the artifact."].join("\n"),
    });
    await recordOwnerDecision({
      companyId, missionId, ownerActionIssueId: ownerAction.id, ownerAgentId, sourceIssueId: qaIssue.id,
      submission: { decision: "retry_source_issue", sourceIssueRef: qaIssue.identifier ?? qaIssue.id, reworkTargetRef: producerIssue.identifier ?? producerIssue.id, reason: "producer must fix the artifact." },
    });
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    await db.insert(workflowTransitionEvents).values([
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_apply", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: `${wakeupKey}:apply`, toStatus: "done", payload: { sourceIssueId: producerIssue.id } },
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_wakeup", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: wakeupKey, toStatus: "not_requested", payload: { sourceIssueId: producerIssue.id } },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied, onOwnerDecisionDispatchStalledWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain("owner_action_retry_wakeup_stalled");
    expect(first.findings.join("\n")).toContain("owner_decision_dispatch_stalled_wake_requested");
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id }),
      sourceIssue: expect.objectContaining({ id: producerIssue.id }),
      dispatchStatus: "not_requested",
    }));

    // 두 번째 스윕: 재발사는 계속 시도하되(기존 동작), 오너 재깨움은 1회로 멱등.
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(2);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(second.findings.join("\n")).not.toContain("owner_decision_dispatch_stalled_wake_requested");
  });

  it("counts consecutive QA rejects for the repeated-defect trend and enriches the cap description", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    const at = (h: number) => new Date(`2026-08-17T0${h}:00:00.000Z`);

    await db.insert(companies).values({ id: companyId, name: "Reject Trend Company", issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "[QA] Inspect", status: "done", originKind: "workflow_execution" });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId, status: "succeeded", startedAt: at(1), finishedAt: at(1) });
    const verdict = (verdictValue: string, hour: number, reason: string | null) => ({
      companyId, issueId, heartbeatRunId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: verdictValue, decision: verdictValue, reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: at(hour), payload: { kind: "workflow_validation_verdict", verdict: verdictValue, ...(reason ? { reason } : {}) },
    });
    await db.insert(workflowTransitionEvents).values([
      verdict("pass", 1, "earlier pass"),
      verdict("request_changes", 2, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 3, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 4, "contrast 4.47:1 below 4.5:1"),
    ]);

    const trend = await loadConsecutiveQaRejectTrend(db, companyId, issueId);
    expect(trend.count).toBe(3);
    expect(trend.latestReason).toContain("4.47");

    // 최신이 pass 면 연속 0.
    await db.insert(workflowTransitionEvents).values(verdict("pass", 5, "fixed"));
    expect((await loadConsecutiveQaRejectTrend(db, companyId, issueId)).count).toBe(0);

    // 설명 강화: 연속 ≥2면 추세 경고, 1이면 없음.
    const exhaustion = {
      workflowRunId: "run-1", producerStepId: "materialize", qaStepId: "inspection", qaStepRunId: "step-run-1",
      producerIteration: 6, maxIterations: 2, producerCompletedAt: at(4), producerIssueId: "prod-1", qaIssueId: issueId,
    } as never;
    const enriched = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:1", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 4, latestReason: "contrast 4.02:1 below 4.5:1" } });
    expect(enriched).toContain("Consecutive QA rejects on this gate: 4");
    expect(enriched).toContain("원천(생성기/템플릿/스킬)");
    expect(enriched).toContain("Latest QA defect: contrast 4.02:1 below 4.5:1");
    const plain = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:2", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 1, latestReason: null } });
    expect(plain).not.toContain("Consecutive QA rejects");
  });

  it("wakes the owner for periodic mission review while work is in flight (bucket-idempotent)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Periodic Review Company", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Periodic review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "periodic-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "in_progress", title: "Produce report" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] periodic-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    // 같은 30분 버킷 안의 두 스윕 → 1회만 깨움.
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      inFlightUnitLabels: expect.arrayContaining([`native_workflow_run:${workflowRunId}:running`]),
    }));

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:12:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);

    // 다음 버킷 → 다시 1회.
    const third = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:38:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(third.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(2);
  });

  it("does not wake for periodic review when execution is fully settled", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-18T11:00:00.000Z");
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Settled Review Company", issuePrefix: `SR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settled review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "settled-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settled-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T11:10:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();
    // settlement 가 미션을 종결했고 리뷰 대상이 없다.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("half-applied owner retry (wakeup marker not_requested) re-dispatches instead of stalling forever", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "dispatched", runId: "run-1" });

    await db.insert(companies).values({ id: companyId, name: "Half Applied Company", issuePrefix: `HA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Half applied retry mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "half-applied-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });

    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: retry_source_issue",
        `Source issue: ${qaIssue.identifier}`,
        `Rework target: ${producerIssue.identifier}`,
        "Reason: producer must provide signal-analysis evidence before QA can complete.",
      ].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: qaIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: qaIssue.identifier ?? qaIssue.id,
        reworkTargetRef: producerIssue.identifier ?? producerIssue.id,
        reason: "producer must provide signal-analysis evidence before QA can complete.",
      },
    });
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    // [half-applied] apply marker recorded + wakeup marker recorded with not_requested
    //   (2026-08-15 GAZ ef12d027 stall: native resume could not prove a link, so nothing was dispatched).
    await db.insert(workflowTransitionEvents).values([
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_apply",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: `${wakeupKey}:apply`,
        toStatus: "done",
        payload: { sourceIssueId: producerIssue.id },
      },
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_wakeup",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: wakeupKey,
        toStatus: "not_requested",
        payload: { sourceIssueId: producerIssue.id },
      },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    // 핵심: not_requested 마커는 '이미 적용됨'이 아니다 — 재발사가 일어나야 한다.
    expect(result.findings.join("\n")).not.toContain("owner_action_decision_already_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: producerAgentId,
      idempotencyKey: wakeupKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_source_issue",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        wakeupDispatchStatus: "dispatched",
      }),
    ]));
    // dispatch-only: 반쪽 적용 상태에선 apply(reopen/재코멘트)를 반복하지 않는다.
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) =>rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));

    // 수렴: 발사 마커가 dispatched 로 기록된 뒤엔 재발사하지 않는다.
    onOwnerDecisionRetrySourceIssueApplied.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(second.appliedActions.filter((action) => action.type === "owner_decision_retry_source_issue")).toEqual([]);
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
    // [owner-action contract] 이 테스트는 source assignee 없는 케이스 자체가 목적이므로 guard를 우회해 fixture done 처리.
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, unblockIssue.id));
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry unassigned source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry unassigned source",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(result.findings.join("\n")).toContain("source issue has no assignee; wakeup dispatch skipped");
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, resultStatus: "blocked", wakeupDispatchStatus: "skipped_no_assignee" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: null }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).not.toContain("mission-owner-decision-applied");
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
      await recordOwnerDecision({
        companyId,
        missionId,
        ownerActionIssueId: ownerAction.id,
        ownerAgentId,
        sourceIssueId: sourceIssue.id,
        submission: {
          decision: "retry_source_issue",
          sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
          reason: "should not mutate",
        },
      });
    }
    const missingSourceId = randomUUID();
    const missingOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: missingSourceId, status: "done", title: "Missing owner action" });
    await db.insert(issueComments).values({ companyId, issueId: missingOwnerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${missingSourceId}`, "Reason: should not mutate missing source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: missingOwnerAction.id,
      ownerAgentId,
      sourceIssueId: missingSourceId,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: missingSourceId,
        reason: "should not mutate missing source",
      },
    });

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
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "replan_mission",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "plan must change",
      },
    });

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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
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

  it("does not explain a retry as applied when no wakeup was queued", async () => {
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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: apply retry"].join("\n") });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_recorded_read_only",
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        retryApplied: false,
        explanation: expect.stringContaining("recorded but not applied"),
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
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
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
      name: "Invalid owner-decision comment is display-only",
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
    expect(result.findings).not.toEqual(expect.arrayContaining([
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
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("artifact_recovery_available"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
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
    // Display-only missing-artifact comment must not authorize recurring-replan by itself.
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
    // Structured gate activity is the only authority for recurring artifact-missing detection.
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.artifact_work_product_missing_auto_blocked",
        entityType: "issue",
        entityId: previousIssue.id,
        details: { reason: "missing_work_product_registration" },
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.artifact_work_product_missing_auto_blocked",
        entityType: "issue",
        entityId: currentIssue.id,
        details: { reason: "missing_work_product_registration" },
      },
    ]);

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

  it("replaces stale workflow run execution units when a workflow mission restarts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const staleRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Restarted Workflow Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-06-14 tech-ai-news",
      status: "active",
    });

    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({
      companyId,
      missionId,
      sourceHints: {
        workflowName: "tech-ai-news",
        sourceRunId: staleRunId,
        workflowStepIds: ["collect-ai-news-evidence", "validate-ai-news-artifact"],
      },
    });
    await svc.ensureMissionExecutionPlan({
      companyId,
      missionId,
      sourceHints: {
        workflowName: "tech-ai-news",
        sourceRunId: currentRunId,
        workflowStepIds: ["collect-ai-news-evidence", "validate-ai-news-note", "send-telegram"],
      },
    });

    const [planArtifact] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));
    const refs = planArtifact?.refs as Record<string, unknown>;
    const executionUnits = refs.executionUnits as Array<Record<string, unknown>>;
    const sourceRefs = executionUnits.map((unit) => unit.sourceRef as Record<string, unknown>);

    expect(refs.sourceRunId).toBe(currentRunId);
    expect(sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentRunId, type: "native_workflow_run" }),
      expect.objectContaining({ id: "validate-ai-news-note", workflowRunId: currentRunId }),
      expect.objectContaining({ id: "send-telegram", workflowRunId: currentRunId }),
    ]));
    expect(sourceRefs.some((sourceRef) => sourceRef.id === staleRunId || sourceRef.workflowRunId === staleRunId)).toBe(false);
    expect(sourceRefs.some((sourceRef) => sourceRef.id === "validate-ai-news-artifact")).toBe(false);
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
        parentId: sourceIssue.id,
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
    const commentOnlyOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(commentOnlyOwnerActions).toHaveLength(1);
    expect(commentOnlyOwnerActions[0]).toEqual(expect.objectContaining({
      id: ownerActionIssues[0]!.id,
      status: "done",
      originId: sourceIssue.id,
    }));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });

  it("restores terminal mission oversight when the mission is still active", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();
    const completedAt = new Date("2026-06-12T09:52:51.477Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Oversight Restore Company",
      issuePrefix: `OR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Active mission with closed oversight",
      status: "active",
    }).returning();
    await db.insert(issues).values({
      id: oversightIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] stale title",
      status: "done",
      priority: "medium",
      completedAt,
    });

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 30,
      now: new Date("2026-06-12T10:00:00.000Z"),
    });

    expect(supervision.oversightIssueId).toBe(oversightIssueId);
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));
    expect(storedOversight).toEqual(expect.objectContaining({
      status: "todo",
      completedAt: null,
      assigneeAgentId: ownerAgentId,
      title: "[OVERSIGHT] stale title",
    }));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, oversightIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission oversight restored"))).toBe(true);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, oversightIssueId));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "mission.oversight_restored",
        entityType: "issue",
        entityId: oversightIssueId,
      }),
    ]));
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
        parentId: oversightIssue.id,
        status: "todo",
        title: "[Owner Action] Tool step failed: collect-signals",
      }),
    ]);
    expect(ownerActionIssues[0]?.description).toContain(`<!-- tool-step-recovery:${runId}:collect-signals -->`);
    expect(ownerActionIssues[0]?.description).toContain("Tool names: collect-signals-kr");
    expect(ownerActionIssues[0]?.description).toContain("Local signal hint: transient_or_external");
    expect(ownerActionIssues[0]?.description).toContain("Local retry hint: retry_with_bounded_backoff");
    expect(ownerActionIssues[0]?.description).toContain("Main executor brief:");
    expect(ownerActionIssues[0]?.description).toContain("Mission goal: Tool step recovery mission");
    expect(ownerActionIssues[0]?.description).toContain("Mission execution loop:");
    expect(ownerActionIssues[0]?.description).toContain("Oversight signal boundary:");
    expect(ownerActionIssues[0]?.description).toContain("- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.");
    expect(ownerActionIssues[0]?.description).toContain("- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.");

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

  it("does not create tool recovery issues for unlaunched failed issue-less tool steps", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-10T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Unlaunched Tool Step Company",
      issuePrefix: `UT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Unlaunched tool step mission",
      status: "active",
    }).returning();

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMainExecutorOversightIssue(mission!, "gazua-morning", {
      sourceRunId: runId,
      workflowStepIds: ["sync-dashboard"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          type: "tool",
          dependencies: ["inspection"],
          toolNames: ["gazua.oracle-data-sync"],
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
      startedAt: new Date("2026-06-10T06:00:00.000Z"),
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "sync-dashboard",
      issueId: null,
      status: "failed",
      startedAt: null,
      completedAt: new Date("2026-06-10T06:23:53.691Z"),
      metadata: { graphWorkProductRequired: false },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failure_unlaunched_skipped"),
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_failed_requires_recovery"),
    ]));
    expect(result.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", workflowRunId: runId, stepId: "sync-dashboard" }),
    ]));
    const ownerActionIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActionIssues).toHaveLength(0);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
  });

  it("classifies issue-less tool recovery from captured runtime evidence before step metadata heuristics", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-12T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Step Missing File Recovery Company",
      issuePrefix: `MF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Missing file recovery mission",
      status: "active",
    }).returning();

    const svc = missionService(db);
    const oversightIssue = await svc.ensureMainExecutorOversightIssue(mission!, "gazua-macro-sentinel", {
      sourceRunId: runId,
      workflowStepIds: ["scan"],
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-macro-sentinel",
      stepsJson: [
        {
          id: "scan",
          name: "Macro event scan",
          type: "tool",
          dependencies: [],
          toolNames: ["collect-macro"],
          description: "Scan macro signals from external sources.",
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
      startedAt: new Date("2026-06-12T06:00:26.096Z"),
      completedAt: new Date("2026-06-12T06:00:26.323Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "scan",
      issueId: null,
      status: "failed",
      startedAt: new Date("2026-06-12T06:00:26.106Z"),
      completedAt: new Date("2026-06-12T06:00:26.302Z"),
      metadata: {
        toolResult: {
          toolName: "collect-macro",
          success: false,
          exitCode: 2,
          error: "Command failed: python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode macro",
          stdout: "",
          stderr: "/Users/kwak/.pyenv/versions/3.11.6/bin/python3: can't open file '/Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py': [Errno 2] No such file or directory",
        },
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("class=missing_file"),
    ]));
    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows.find((issue) => issue.originId === oversightIssue.id)!);
    expect(recoveryIssue).toEqual(expect.objectContaining({
      assigneeAgentId: ownerAgentId,
      status: "todo",
      title: "[Owner Action] Tool step failed: scan",
    }));
    expect(recoveryIssue.description).toContain(`<!-- tool-step-recovery:${runId}:scan -->`);
    expect(recoveryIssue.description).toContain("Local signal hint: missing_file");
    expect(recoveryIssue.description).toContain("Local retry hint: do_not_retry_until_config_fixed");
    expect(recoveryIssue.description).toContain("can't open file");
    expect(recoveryIssue.description).toContain("No such file or directory");
    expect(recoveryIssue.description).toContain("No recovery action has been selected by automation.");
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
    const duplicateRecoveryIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      description: recoveryIssue.description,
      missionId,
      originKind: "mission_main_executor_unblock",
      originId: oversightIssue.id,
      priority: "high",
      status: "todo",
      title: "[Owner Action] Tool step failed: collect-signals duplicate",
    });

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
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_recovery_duplicate_closed"),
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
    expect(executeToolStep).not.toHaveBeenCalled();
    const retryDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(retryDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      workflowRunId: runId,
      stepRunId: failedStepRunId,
      stepId: "collect-signals",
      toolName: "collect-signals-kr",
    }));
    const [closedDuplicateRecoveryIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, duplicateRecoveryIssue.id));
    expect(closedDuplicateRecoveryIssue).toEqual(expect.objectContaining({
      status: "done",
    }));
    const duplicateRecoveryComments = await db.select().from(issueComments).where(eq(issueComments.issueId, duplicateRecoveryIssue.id));
    expect(duplicateRecoveryComments.map((comment) => comment.body).join("\n")).toContain("### Duplicate native tool step recovery closed");

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

  it("creates a separate active mission for every workflow trigger (no same-title active-mission reuse)", async () => {
    // [GAZ 2026-08-28 bce2fa1f] Legacy April-era dedupe used to glue a second
    // same-day trigger onto the day's still-ACTIVE mission (title = runDate +
    // workflow name, inputs invisible), interleaving multiple runs' issues in
    // one mission. Duplicate SCHEDULED runs are prevented upstream (slot claim
    // + active-run/mission guards), so mission create must not reuse — every
    // trigger gets its own mission.
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

    expect(second.id).not.toBe(first.id);
    expect(missionRows).toHaveLength(2);
    // Each mission keeps exactly one main-executor oversight issue of its own.
    const oversightRows = await db
      .select({ missionId: issues.missionId })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .where(eq(issues.originKind, "mission_main_executor_oversight"));
    expect(oversightRows).toHaveLength(2);
    expect(new Set(oversightRows.map((row) => row.missionId)).size).toBe(2);
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
      timezone: "Asia/Seoul",
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
        createdAt: new Date("2026-03-31T14:59:59.999Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range start",
        status: "active",
        createdAt: new Date("2026-03-31T15:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range end",
        status: "active",
        createdAt: new Date("2026-04-29T14:59:59.999Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "After range",
        status: "active",
        createdAt: new Date("2026-04-29T15:00:00.000Z"),
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

  it("breaks updatedAt ties deterministically (newer createdAt first, then id desc)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const tiedUpdatedAt = new Date("2026-08-27T04:26:53.970Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tie Sort Mission Company",
      issuePrefix: `TS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Tie Sort Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // 동일 updatedAt 타이: createdAt도 같으면 id desc로, createdAt이 다르면 최신 createdAt 우선.
    // 삽입 순서(id 0000 먼저, ffff 나중; 오래 만든 것 먼저)와 기대 순서를 반대로 놓아
    // tiebreaker 없는 현재 구현이 힙 순서(삽입 순)를 반환하면 실패하도록 만든다.
    await db.insert(missions).values([
      {
        id: "00000000-0000-4000-8000-000000000000",
        companyId,
        ownerAgentId,
        title: "Tie same-created low-id",
        status: "active",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId,
        ownerAgentId,
        title: "Tie same-created high-id",
        status: "active",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId,
        ownerAgentId,
        title: "Tie newer-created",
        status: "active",
        createdAt: new Date("2026-08-26T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        companyId,
        ownerAgentId,
        title: "Distinct newer updatedAt",
        status: "active",
        createdAt: new Date("2026-08-19T00:00:00.000Z"),
        updatedAt: new Date("2026-08-27T04:32:03.615Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      sortBy: "updatedAt",
      sortOrder: "desc",
    });

    expect(result.map((mission) => mission.title)).toEqual([
      "Distinct newer updatedAt",
      "Tie newer-created",
      "Tie same-created high-id",
      "Tie same-created low-id",
    ]);
  });

  it("does not re-stamp updatedAt when reconciling an already-settled workflow mission (read path stays read-only)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const runCompletedAt = new Date("2026-08-27T02:39:53.000Z");
    const settledUpdatedAt = new Date("2026-08-27T02:39:53.000Z");
    const missionId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Noop Reconcile Company",
      issuePrefix: `NR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Noop Reconcile Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-report", stepsJson: [] });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-08-27 youtube-report",
      description: "Created automatically for workflow run: run-1",
      status: "completed",
      startedAt: new Date("2026-08-27T01:52:23.000Z"),
      completedAt: runCompletedAt,
      updatedAt: settledUpdatedAt,
    });
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "completed",
      startedAt: new Date("2026-08-27T01:52:23.000Z"),
      completedAt: runCompletedAt,
      runDate: "2026-08-27",
    });

    await missionService(db).list({ companyId, sortBy: "updatedAt", sortOrder: "desc" });
    await missionService(db).list({ companyId, sortBy: "updatedAt", sortOrder: "desc" });

    const [row] = await db.select({ updatedAt: missions.updatedAt }).from(missions).where(eq(missions.id, missionId));
    expect(row?.updatedAt.getTime()).toBe(settledUpdatedAt.getTime());
  });

  it("interprets date-only mission filters as local-day boundaries", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Local Date Filter Mission Company",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
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
    const workProductId = randomUUID();

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

    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Mission brief",
      url: "file:///tmp/mission-brief.md",
      status: "ready_for_review",
      isPrimary: true,
      summary: "Brief draft produced by workflow step",
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
        workProducts: [
          expect.objectContaining({
            id: workProductId,
            title: "Mission brief",
            url: "file:///tmp/mission-brief.md",
            status: "ready_for_review",
            isPrimary: true,
            summary: "Brief draft produced by workflow step",
          }),
        ],
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

  it("reopens a completed workflow mission so oversight can recover remaining blocked work", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const blockedIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Recovery Company",
      issuePrefix: `MR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Workflow mission with unresolved work",
      description: "Created automatically for workflow run: recovery-workflow",
      status: "completed",
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        missionId,
        title: "Blocked producer",
        status: "blocked",
        priority: "medium",
        originKind: "workflow_execution",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Workflow mission with unresolved work",
        status: "done",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
        completedAt: new Date("2026-06-09T04:41:12.533Z"),
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Recovery workflow",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "completed",
      triggeredBy: "test",
      startedAt: new Date("2026-06-09T04:00:00.000Z"),
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });

    const detail = await missionService(db).getById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();
    expect(oversight?.status).toBe("todo");
    expect(oversight?.completedAt).toBeNull();

    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Workflow Company",
      issuePrefix: `FW${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, blockedIssueId));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, oversightIssueId));
    await db.update(missions).set({ status: "completed", completedAt: new Date() }).where(eq(missions.id, missionId));
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: foreignCompanyId,
      missionId,
      title: "Foreign blocked issue with invalid mission linkage",
      status: "blocked",
      priority: "medium",
      originKind: "workflow_execution",
    });

    const settledDetail = await missionService(db).getById(missionId);
    expect(settledDetail.status).toBe("completed");
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
