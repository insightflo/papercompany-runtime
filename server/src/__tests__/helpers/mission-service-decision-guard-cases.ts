import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, issueComments, issues, missionPlanArtifacts, missions, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionDecisionGuardCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("does not create an unblock action when the active plan says the issue prerequisites are blocked", async () => {
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
}
