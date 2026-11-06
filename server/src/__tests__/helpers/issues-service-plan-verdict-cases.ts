// issueService cases moved out of issues-service.test.ts (T16d, file <=1000 lines).
// Slice: planning ingestion + workflow validation verdict ledger describes (whole blocks).
// Describe blocks are moved verbatim, including their own embedded-postgres lifecycle.
// The caller passes its describe/describe.skip selector so skip semantics are unchanged.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, describe } from "vitest";
import { activityLog, agentRuntimeState, agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueExecutionCards, issueWorkProducts, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { issueService } from "../../services/issues.ts";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.ts";

export function registerIssuesServicePlanVerdictCases(embeddedPostgresSupported: boolean) {
const describeEmbeddedPostgres = embeddedPostgresSupported ? describe : describe.skip;

function decisionComment(decision: Record<string, unknown>) {
  return `### Mission owner plan decision
\`\`\`json
${JSON.stringify(decision)}
\`\`\``;
}

describeEmbeddedPostgres("issueService.addComment mission owner planning ingestion", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-owner-plan-comments-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlanningFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const normalIssueId = randomUUID();
    const workflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Plan Company",
      issuePrefix: `IP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowDefinitionId,
      companyId,
      name: "Smoke workflow",
    });
    await db.insert(issues).values([
      {
        id: planningIssueId,
        companyId,
        missionId,
        title: "Mission owner planning",
        originKind: "mission_main_executor_plan",
        status: "todo",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: normalIssueId,
        companyId,
        missionId,
        title: "Normal workflow issue",
        originKind: "workflow_execution",
        status: "todo",
      },
    ]);

    return { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId, normalIssueId, workflowDefinitionId };
  }

  function validDecision(missionId: string, workflowDefinitionId: string, title = "Run smoke") {
    return {
      missionId,
      missionGoal: "Ship controlled rollout",
      selectedExecutionUnits: [
        {
          id: `wf:${workflowDefinitionId}:step:smoke`,
          kind: "workflow_definition_step",
          title,
          selectionState: "selected",
          reason: "Required for validation",
          sourceRef: { type: "workflow_definition_step", id: workflowDefinitionId, stepId: "smoke" },
        },
      ],
      ruleRefs: ["rule:security"],
      kbRefs: ["kb:rollout"],
      requiredInputs: ["stagingUrl"],
      successCriteria: ["smoke passes"],
      steps: [{ id: "step-1", title: "Verify staging" }],
    };
  }

  async function activePlans(missionId: string) {
    return db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .then((rows) => rows.filter((row) => row.status === "active"));
  }

  async function recordedActivities() {
    return db.select().from(activityLog).where(eq(activityLog.action, "mission.owner_plan.recorded"));
  }

  async function passPlanQaAndNudgePlanningIssue(input: { companyId: string; missionId: string; planningIssueId: string; ownerAgentId: string }) {
    const plans = await activePlans(input.missionId);
    const planQa = (plans[0]?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string } | undefined;
    expect(planQa).toMatchObject({ issueId: expect.any(String), status: "pending" });
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: planQa!.issueId!,
      authorUserId: "board-user-test",
      body: "Plan QA passed.\nPASS",
    });
    await svc.addComment(input.planningIssueId, "Re-check PLAN-QA gate after review.", { agentId: input.ownerAgentId });
  }

  it("does not ingest an authorized owner planning decision comment as a mission plan (display-only)", async () => {
    const { ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    const comment = await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });

    expect(comment).toEqual(expect.objectContaining({ issueId: planningIssueId, authorAgentId: ownerAgentId }));
    // Natural-language decision comments are display/audit only; the runtime must
    // never read them back as plan-decision authority (no plan, no activity).
    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("does not record a revision or activity when the same planning decision comment is posted again", async () => {
    const { ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });
    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });

    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("does not record a revision or activity from a later planning comment repeating the latest decision", async () => {
    const { ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });
    await svc.addComment(planningIssueId, "Acknowledged; proceed with that plan.", { agentId: ownerAgentId });

    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("ignores decision-looking comments on non-planning issues", async () => {
    const { ownerAgentId, missionId, normalIssueId, workflowDefinitionId } = await seedPlanningFixture();

    await svc.addComment(normalIssueId, decisionComment(validDecision(missionId, workflowDefinitionId)), { agentId: ownerAgentId });

    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("keeps unauthorized planning comments without recording a mission plan", async () => {
    const { otherAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();

    const comment = await svc.addComment(planningIssueId, decisionComment(validDecision(missionId, workflowDefinitionId)), {
      agentId: otherAgentId,
    });

    expect(comment.authorAgentId).toBe(otherAgentId);
    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("keeps invalid planning decision comments without recording a revision or activity", async () => {
    const { ownerAgentId, missionId, planningIssueId } = await seedPlanningFixture();
    const invalidDecision = {
      ...validDecision(missionId, randomUUID()),
      selectedExecutionUnits: [{ sourceRef: { type: "workflow_definition_step", id: randomUUID() } }],
    };

    const comment = await svc.addComment(planningIssueId, decisionComment(invalidDecision), { agentId: ownerAgentId });

    expect(comment.body).toContain("Mission owner plan decision");
    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("still returns the comment and updates issue updatedAt", async () => {
    const { ownerAgentId, planningIssueId } = await seedPlanningFixture();
    const before = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, planningIssueId))
      .then((rows) => rows[0]!.updatedAt);

    const comment = await svc.addComment(planningIssueId, "Plain comment", { agentId: ownerAgentId });

    expect(comment).toEqual(expect.objectContaining({ issueId: planningIssueId, body: "Plain comment" }));
    const after = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, planningIssueId))
      .then((rows) => rows[0]!.updatedAt);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describeEmbeddedPostgres("issueService workflow validation verdict ledger gate", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-validation-ledger-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(issueExecutionCards);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWorkflowValidationIssue(overrides: {
    readonly issueTitle?: string;
    readonly stepId?: string;
    readonly stepName?: string;
    readonly cardVerdictRequired?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const stepRunId = randomUUID();
    const startedAt = new Date("2026-07-05T03:38:00.000Z");
    const stepId = overrides.stepId ?? "qa-review";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip QA Ledger",
      issuePrefix: `QL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "qa-ledger-workflow",
      stepsJson: [{
        id: stepId,
        name: overrides.stepName ?? "Validate delivery artifact",
        agentId,
        dependencies: [],
      }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      startedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: overrides.issueTitle ?? "[QA] Validate delivery artifact",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: workflowRunId,
      originRunId: workflowRunId,
      startedAt,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId,
      issueId,
      status: "running",
      startedAt,
    });
    if (typeof overrides.cardVerdictRequired === "boolean") {
      await db.insert(issueExecutionCards).values({
        companyId,
        issueId,
        workflowRunId,
        workflowStepRunId: stepRunId,
        cardVersion: 1,
        contentHash: "test-card-verdict-required",
        cardJson: {
          version: 1,
          issue: {
            id: issueId,
            title: overrides.issueTitle ?? "[QA] Validate delivery artifact",
            assigneeAgentId: agentId,
            originKind: "workflow_execution",
          },
          workflow: {
            definitionId: workflowId,
            runId: workflowRunId,
            stepRunId,
            stepId,
            dependencyStepIds: [],
          },
          requiredOutputs: {
            workProduct: {
              required: false,
              artifactMarker: "[ARTIFACT]: <absolute path>",
            },
            verdict: {
              required: overrides.cardVerdictRequired,
              ledger: overrides.cardVerdictRequired ? "workflow_validation_verdict" : null,
              allowed: overrides.cardVerdictRequired ? ["PASS", "REQUEST_CHANGES"] as const : [],
            },
            deliveryReadback: {
              required: false,
              marker: null,
            },
          },
          evidenceRefs: [],
          preservedProseMarkers: [],
          source: {
            descriptionHash: "test",
            generatedBy: "test",
          },
        },
      });
    }

    return { companyId, workflowRunId, issueId, stepRunId };
  }

  it("rejects done for workflow QA issues without a verdict ledger row", async () => {
    const seeded = await seedWorkflowValidationIssue();

    await expect(svc.update(seeded.issueId, { status: "done" })).rejects.toThrow(
      "workflow_validation_verdict",
    );
  });

  it("rejects done when the execution card requires a verdict without QA naming", async () => {
    const seeded = await seedWorkflowValidationIssue({
      issueTitle: "Audit source coverage and confidence",
      stepId: "audit-source-coverage",
      stepName: "Audit source coverage and confidence",
      cardVerdictRequired: true,
    });

    await expect(svc.update(seeded.issueId, { status: "done" })).rejects.toThrow(
      "workflow_validation_verdict",
    );
  });

  it("allows done for workflow QA issues after a verdict ledger row exists", async () => {
    const seeded = await seedWorkflowValidationIssue();
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]!);
    const heartbeatRunId = randomUUID();
    const recordedAt = new Date("2026-07-05T03:39:00.000Z");

    // Official structured contract: checked-out heartbeat scoped to this QA issue + workflow_api verdict helper.
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: seeded.companyId,
      agentId: issue.assigneeAgentId!,
      issueId: seeded.issueId,
      status: "succeeded",
      invocationSource: "automation",
      startedAt: recordedAt,
      finishedAt: recordedAt,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
    const ledger = await recordWorkflowValidationVerdict({
      db,
      issue,
      verdict: "pass",
      source: "workflow_api",
      heartbeatRunId,
      sourceText: "test",
    });
    expect(ledger.satisfied).toBe(true);
    expect(ledger.verdict).toBe("pass");

    const updated = await svc.update(seeded.issueId, { status: "done" });

    expect(updated?.status).toBe("done");
  });

  it("does not require a verdict ledger for ordinary validate workflow steps", async () => {
    const seeded = await seedWorkflowValidationIssue({
      issueTitle: "Validate API response shape",
      stepId: "validate-api-response",
      stepName: "Validate API response shape",
    });

    const updated = await svc.update(seeded.issueId, { status: "done" });

    expect(updated?.status).toBe("done");
  });
});
}
