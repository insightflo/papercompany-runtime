import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issues, missions, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionOwnerActionExplanationCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("keeps non-replan owner decisions read-only even with explicit owner-decision apply and wakeup dispatch enabled", async () => {
    const db = getDb();
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
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Input owner action" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: request_input", `Source issue: ${blockedIssue.identifier}`, "Reason: operator input is required"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "request_input",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "operator input is required",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("explains decision-required owner actions without leaking unrelated text", async () => {
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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
}
