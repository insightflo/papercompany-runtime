import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issueComments, issues, missionPlanArtifacts, missions, workflowRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { hashOwnerPlanDecision } from "../../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";

export function registerMissionPlanSupervisionCases(getDb: () => ReturnType<typeof createDb>) {
  it("active supervision escalates a stale todo mission source when no issue is actually running", async () => {
    const db = getDb();
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
    const db = getDb();
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
}
