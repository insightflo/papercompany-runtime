import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, createDb, heartbeatRuns, issues, issueWorkProducts, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { missionService } from "../services/missions.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

// Preserve real supervision/DB logic; seal only incidental external-agent dispatch.
const { wakeup } = vi.hoisted(() => ({ wakeup: vi.fn().mockResolvedValue({ id: "sealed-wake" }) }));
vi.mock("../services/heartbeat.js", async (original) => ({
  ...await original<typeof import("../services/heartbeat.js")>(), heartbeatService: () => ({ wakeup }),
}));
vi.mock("../services/issue-assignment-wakeup.js", async (original) => {
  const actual = await original<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
    actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup } }) };
});

describe("stage1 supervision continuity with durable recovery authority", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-stage1-");
    db = createDb(temp.connectionString);
    setWorkflowToolStepExecutor(async () => { throw new Error("External tool execution is sealed"); });
  }, 60_000);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await db?.$client.end();
    await temp?.cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  async function seed(decision: "recover_artifact" | "retry_source_issue") {
    const s = await seedToolRecoveryScenario({ db, artifactExists: true });
    roots.push(s.tempRoot);
    await db.update(agents).set({ adapterConfig: { command: 'node -e "setTimeout(()=>process.exit(0),500)"' } })
      .where(eq(agents.id, s.ownerAgentId));
    const [card] = await db.select().from(issues).where(eq(issues.id, s.recoveryIssueId));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: s.companyId,
      agentId: s.ownerAgentId, issueId: card.id, status: "succeeded" });
    const recoveryTarget = { kind: "tool_step" as const, workflowRunId: s.workflowRunId, stepRunId: s.stepRunId,
      expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null };
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: card.id, workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId,
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery",
      idempotencyKey: `owner-tool-card:${s.stepRunId}`, payload: { schemaVersion: 1, kind: "tool_step",
        workflowRunId: s.workflowRunId, stepRunId: s.stepRunId } });
    const record = await recordMissionOwnerDecision({ db,
      issue: { id: card.id, companyId: s.companyId, missionId: s.missionId }, heartbeatRunId,
      sourceIssueId: card.originId, submission: { decision, recoveryTarget, sourceIssueRef: card.id } });
    if (decision === "recover_artifact") {
      const workProductId = randomUUID();
      await db.insert(issueWorkProducts).values({ id: workProductId, companyId: s.companyId, issueId: card.id,
        type: "file", provider: "local", title: "recovered.json", externalId: s.artifactPath,
        status: "active", isPrimary: true, metadata: { path: s.artifactPath } });
      await db.insert(activityLog).values({ companyId: s.companyId, actorType: "agent", actorId: s.ownerAgentId,
        action: "issue.workflow_artifact_registered", entityType: "issue", entityId: card.id, details: { workProductId } });
    } else {
      await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
        discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    }
    return { ...s, record, recoveryTarget };
  }

  // A real PostgreSQL rejection reaches the native completion/retry path, not a fake service return.
  async function fault(stepRunId: string) {
    await db.$client.unsafe(`CREATE FUNCTION stage1_recovery_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${stepRunId}'::uuid THEN RAISE EXCEPTION 'stage1 recovery fault'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER stage1_recovery_fault BEFORE UPDATE ON workflow_step_runs
      FOR EACH ROW EXECUTE FUNCTION stage1_recovery_fault()`);
  }
  const clearFault = () => db.$client.unsafe("DROP TRIGGER stage1_recovery_fault ON workflow_step_runs; DROP FUNCTION stage1_recovery_fault()");
  const supervise = (missionIds: string[], apply = true) => missionService(db).runActiveMissionOwnerSupervision({
    missionIds, staleAfterMinutes: 1, now: new Date("2026-07-06T05:07:00Z"), applyOwnerDecisionActions: apply });

  it.each(["recover_artifact", "retry_source_issue"] as const)("keeps %s exceptions blocked and still retries the later unrelated mission", async (decision) => {
    const first = await seed(decision), second = await seed("retry_source_issue");
    // Ordinary oversight maintenance touches updatedAt; execution/checkout state must stay unchanged.
    const sourceState = async () => (await db.select().from(issues).where(eq(issues.id, first.oversightIssueId)))
      .map(({ updatedAt: _updatedAt, ...state }) => state);
    const beforeSource = await sourceState();
    await fault(first.stepRunId);
    try {
      const result = await supervise([first.missionId, second.missionId]);
      expect(result.missionIds).toEqual([first.missionId, second.missionId]);
      expect(result.missions.map((m) => m.missionId)).toEqual([first.missionId, second.missionId]);
      expect(result.missions[0].recoveryOutcomes).toContainEqual(expect.objectContaining({ schemaVersion: 1,
        ownerActionIssueId: first.recoveryIssueId, decisionEventId: first.record.eventId, target: first.recoveryTarget,
        kind: "no_op", outcome: "blocked", reason: decision === "recover_artifact" ? "artifact_recovery_failed" : "tool_retry_failed" }));
      expect(result.missions[0].appliedActions.some((a) => a.type === "owner_decision_retry_source_issue"
        || a.type === "native_tool_step_retry" || a.type === "native_tool_step_recovery_result")).toBe(false);
      expect(await sourceState()).toEqual(beforeSource);
      const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, first.stepRunId));
      expect(failed.status).toBe("failed");
      expect(failed.lastDispatchRequestId).toBeNull();
      const [retried] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, second.stepRunId));
      expect(retried.status).toBe("running");
      expect(retried.lastDispatchRequestId).toBeTruthy();
      expect(retried.metadata).toMatchObject({ toolQueue: { status: "queued" } });
      expect(result.missions[1].recoveryOutcomes).toContainEqual(expect.objectContaining({
        kind: "retry_requested", outcome: "dispatched", dispatchRequestId: retried.lastDispatchRequestId }));
    } finally { await clearFault(); }
  });

  it.each(["recover_artifact", "retry_source_issue"] as const)("does not execute %s with apply=false", async (decision) => {
    const s = await seed(decision);
    const beforeSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId));
    const beforeRun = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    await fault(s.stepRunId);
    try {
      const result = await supervise([s.missionId], false);
      expect(result.missions[0].recoveryOutcomes).toContainEqual(expect.objectContaining({ outcome: "blocked", reason: "not_requested" }));
      expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId))).toEqual(beforeSteps);
      expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId))).toEqual(beforeRun);
    } finally { await clearFault(); }
  });
});
