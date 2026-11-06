import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, workflowDefinitions } from "@paperclipai/db";
import { seedMissionOwnerTaskContextFixture } from "./heartbeat-owner-context-fixture.js";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatOwnerPlanCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("attaches mission-owner-planning context when the heartbeat issue originKind is mission_main_executor_plan", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_plan");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-plan:plan", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerPlanningContext).toEqual(
      expect.objectContaining({
        mission: expect.objectContaining({
          id: fixture.missionId,
          title: "Mission owner context mission",
          status: "active",
          companyId: fixture.companyId,
          ownerAgentId: fixture.agentId,
        }),
        planningIssueId: fixture.ownerTaskIssueId,
        activePlan: expect.objectContaining({ available: false }),
        executionSourceSnapshot: {
          missionId: fixture.missionId,
          companyId: fixture.companyId,
          units: [],
          runtimes: [],
        },
        ruleRefs: [],
        workflowCandidates: [],
        kbRefs: [],
        agentRoster: [],
        todoMarkers: [],
        sourceRefVocabulary: expect.arrayContaining(["native_workflow_run", "native_workflow_step_run"]),
      }),
    );
    // mission_main_executor_plan does not satisfy isMissionOwnerTaskIssue, so task context must be absent
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });

  it("does not attach mission-owner-planning context for normal workflow_execution issues", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "workflow_execution");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "worker:normal", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerPlanningContext).toBeUndefined();
    // Existing test already covers task context absence; included for symmetry
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });

  it("serializes PLAN-QA request_changes rework across an active planning run (no concurrent run, queued follow-up)", async () => {
    const db = getDb();

    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Rework Queue Co", issuePrefix: "RQ", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: { promptTemplate: "Plan." }, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "Plan QA Reviewer", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Source WF", stepsJson: [{ id: "scout", name: "Scout", dependencies: [] }] });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Rework queue mission", status: "active" });
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Planning", originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: ownerAgentId, description: "ORIGINAL-INSTRUCTION-MARKER" });

    const { missionPlanArtifactService } = await import("../../services/mission-plan-artifacts.js");
    const { recordMissionOwnerPlanDecisionSubmission } = await import("../../services/missions/mission-plan-decision-submissions.js");
    const { recordMissionPlanQaVerdict } = await import("../../services/missions/mission-plan-qa-verdicts.js");
    const { recordLatestAuthorizedMissionOwnerPlanDecision } = await import("../../services/mission-owner-plan-decisions.js");
    const { createPlanningIssueWakeupHandler } = await import("../../services/missions/plan-qa-wakeup.js");

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const first = await recordMissionOwnerPlanDecisionSubmission({
      db, companyId, missionId, planningIssueId,
      requestedBy: { actorType: "agent", actorId: ownerAgentId },
      decision: {
        missionId, missionGoal: "Ship controlled rollout",
        selectedExecutionUnits: [{ id: "unit-rework-distinctive", kind: "workflow_definition_step", title: "Run smoke", reason: "ev", selectionState: "selected", sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" } }],
        requiredInputs: ["stagingUrl"], successCriteria: ["smoke passes"], steps: [{ id: "s1", title: "Verify" }],
      },
    });
    expect(first.status).toBe("plan_qa_pending");

    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQaRef = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    if (!planQaRef?.issueId) throw new Error("no active PLAN-QA issue");
    await recordMissionPlanQaVerdict({
      db, companyId, missionId, planQaIssueId: planQaRef.issueId, decisionHash: planQaRef.decisionHash ?? first.decisionHash ?? "",
      verdict: "request_changes",
      diagnostics: [{ code: "plan_qa_rework_race_gap", message: "Distinctive rework diagnostic that must survive the active-run race" }],
      reviewedBy: { actorType: "agent", actorId: qaAgentId },
    });

    // ── Start an active run for the planning issue, held open ──────────────
    const heartbeat = heartbeatService(db);
    let executeCallCount = 0;
    let releaseActiveRun!: () => void;
    const activeRunGate = new Promise<void>((resolve) => { releaseActiveRun = resolve; });
    let releaseFollowUpRun!: () => void;
    const followUpGate = new Promise<void>((resolve) => { releaseFollowUpRun = resolve; });
    executeSpy.mockImplementation(async () => {
      executeCallCount += 1;
      if (executeCallCount === 1) await activeRunGate;
      else await followUpGate;
      return successfulAdapterResult();
    });

    const activeRun = await heartbeat.invoke(ownerAgentId, "on_demand", { issueId: planningIssueId, missionId }, "plan-active", { actorType: "agent", actorId: ownerAgentId });
    expect(activeRun).not.toBeNull();
    await waitForIssueStatus(db, planningIssueId, (i) => i.status === "in_progress" && !!i.executionRunId);

    // ── Deliver PLAN-QA request_changes with real queue wiring ─────────────
    const enqueuePlanningIssueWakeup = createPlanningIssueWakeupHandler(
      { wakeup: (agentId: string, opts: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]) => heartbeat.wakeup(agentId, opts) },
    );
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanningIssueWakeup });
    expect(result.status).toBe("plan_qa_changes_requested");

    // ── Assert: durable queued wakeup exists immediately, runId=null ───────
    const queuedRequests = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, ownerAgentId),
      eq(agentWakeupRequests.status, "queued"),
      eq(agentWakeupRequests.issueId, planningIssueId),
      sql`${agentWakeupRequests.runId} is null`,
    ));
    expect(queuedRequests).toHaveLength(1);
    expect(queuedRequests[0].reason).toBe("mission_owner_plan_rework_requested");
    const queuedContextSnapshot = (queuedRequests[0].payload as Record<string, unknown> | null)?.["_paperclipWakeContext"] as Record<string, unknown> | undefined;
    expect(queuedContextSnapshot?.forceFreshSession).toBe(true);
    expect(queuedContextSnapshot?.decisionHash).toBe(planQaRef.decisionHash ?? first.decisionHash ?? "");

    // ── Assert: no concurrent run (only the active run is live) ────────────
    const liveRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, ownerAgentId),
      inArray(heartbeatRuns.status, ["queued", "running"]),
    ));
    expect(liveRuns).toHaveLength(1);

    // ── Assert: revision baseline carried into the issue description ───────
    const [planningIssue] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, planningIssueId));
    expect(planningIssue.description).toContain("ORIGINAL-INSTRUCTION-MARKER");
    expect(planningIssue.description).toContain("unit-rework-distinctive");
    expect(planningIssue.description).toContain("plan_qa_rework_race_gap");

    // ── Idempotency: duplicate rework-wakeup delivery does not create a second record ─
    await enqueuePlanningIssueWakeup({
      companyId, agentId: ownerAgentId, issueId: planningIssueId, issueStatus: "in_progress",
      missionId, planQaIssueId: planQaRef.issueId, decisionHash: planQaRef.decisionHash ?? "",
    });
    const queuedAfterDup = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.status, "queued"),
      eq(agentWakeupRequests.issueId, planningIssueId),
      sql`${agentWakeupRequests.runId} is null`,
    ));
    expect(queuedAfterDup).toHaveLength(1);
    expect((queuedAfterDup[0].coalescedCount ?? 0)).toBeGreaterThanOrEqual(1);

    // ── Complete the active run → follow-up promoted by queue runner ───────
    releaseActiveRun();
    await waitForRunTerminal(heartbeat, activeRun!.id);

    const followUpDeadline = Date.now() + 5_000;
    let followUpRun: typeof heartbeatRuns.$inferSelect | null = null;
    while (Date.now() < followUpDeadline) {
      const candidates = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, ownerAgentId),
        sql`${heartbeatRuns.id} != ${activeRun!.id}`,
      ));
      followUpRun = candidates.find((r) => r.status === "queued" || r.status === "running") ?? null;
      if (followUpRun) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(followUpRun).not.toBeNull();

    // ── Assert: issue reopened for the follow-up (exactly one) ─────────────
    const [reopened] = await db.select().from(issues).where(eq(issues.id, planningIssueId));
    expect(reopened.status).toBe("in_progress");
    expect(reopened.executionRunId).toBe(followUpRun!.id);

    releaseFollowUpRun();
    if (followUpRun) await waitForRunTerminal(heartbeat, followUpRun.id).catch(() => {});
  });
}
