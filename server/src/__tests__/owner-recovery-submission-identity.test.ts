import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { loadLatestMissionOwnerDecision, loadMissionOwnerDecisions } from "../services/missions/mission-owner-recovery-ledger.js";

// Real DB: removing the pre-check allows checkout repair and persists an unreadable decision.
describe("owner recovery submission identity before checkout writes", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-identity-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
    const issueId = randomUUID(), sourceId = randomUUID(), oldRunId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "identity", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "owner", role: "operator" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "identity", status: "active" });
    await db.insert(issues).values([
      { id: sourceId, companyId, missionId, title: "source", status: "blocked" },
      { id: issueId, companyId, missionId, title: "owner", status: "in_progress", assigneeAgentId: agentId,
        originKind: "mission_main_executor_unblock", originId: sourceId },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: oldRunId, companyId, agentId, issueId, status: "succeeded" },
      { id: runId, companyId, agentId, issueId, status: "running" },
    ]);
    await db.update(issues).set({ checkoutRunId: oldRunId }).where(eq(issues.id, issueId));
    return { companyId, agentId, missionId, issueId, sourceId, oldRunId, runId };
  }
  const submit = (s: Awaited<ReturnType<typeof seed>>) => submitMissionOwnerDecision({
    db, issueId: s.issueId,
    actor: { actorType: "agent", actorId: s.agentId, agentId: s.agentId, runId: s.runId },
    data: { decision: "no_action_waiting", sourceIssueRef: s.sourceId },
  });

  it.each(["null_issue", "other_issue", "other_agent", "other_company"])("rejects %s without checkout adoption or event writes", async (variant) => {
    const s = await seed();
    const foreign = await seed();
    const patch = variant === "null_issue" ? { issueId: null }
      : variant === "other_issue" ? { issueId: s.sourceId }
      : variant === "other_agent" ? { agentId: foreign.agentId }
      : { companyId: foreign.companyId };
    await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, s.runId));
    const before = await db.select().from(issues).where(eq(issues.id, s.issueId));
    await expect(submit(s)).rejects.toMatchObject({ status: 409, details: { reason: "owner_recovery_submission_identity_mismatch" } });
    expect(await db.select().from(issues).where(eq(issues.id, s.issueId))).toEqual(before);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId))).toEqual([]);
  });

  it("preserves same-issue stale-lock adoption and reader parity after checkout is gone", async () => {
    const s = await seed();
    // No new running-only restriction: a completed authenticated heartbeat remains a valid author.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    const event = await submit(s);
    const [adopted] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(adopted.checkoutRunId).toBe(s.runId);
    await db.update(issues).set({ checkoutRunId: null, status: "done" }).where(eq(issues.id, s.issueId));
    expect((await loadLatestMissionOwnerDecision({ db, companyId: s.companyId, ownerActionIssueId: s.issueId }))?.eventId).toBe(event.eventId);
    expect((await loadMissionOwnerDecisions({ db, companyId: s.companyId, missionId: s.missionId }))[0]?.eventId).toBe(event.eventId);
  });

  it("rejects an out-of-scope or stale exact target before checkout adoption", async () => {
    const s = await seed();
    const workflowId = randomUUID(), workflowRunId = randomUUID(), stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId: s.companyId, name: "target", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId: s.companyId, missionId: s.missionId, status: "failed", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "selected", status: "failed" });
    const target = { kind: "tool_step" as const, workflowRunId, stepRunId,
      expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null };
    const post = (recoveryTarget: typeof target) => submitMissionOwnerDecision({ db, issueId: s.issueId,
      actor: { actorType: "agent", actorId: s.agentId, agentId: s.agentId, runId: s.runId },
      data: { decision: "retry_source_issue", recoveryTarget } });
    for (const invalid of [{ ...target, stepRunId: randomUUID() }, { ...target, expectedAuthorityVersion: 1 },
      { ...target, expectedExecutionGeneration: 1 }, { ...target, failedDispatchRequestId: "other-attempt" }]) {
      await expect(post(invalid)).rejects.toMatchObject({ status: 409 });
      const [unchanged] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(unchanged.checkoutRunId).toBe(s.oldRunId);
    }
    const event = await post(target);
    const read = await loadLatestMissionOwnerDecision({ db, companyId: s.companyId, ownerActionIssueId: s.issueId });
    expect(read?.eventId).toBe(event.eventId);
    expect(read?.decision.recoveryTarget).toEqual(target);
  });

  it("rejects a different mission owner and a closed owner action without writes", async () => {
    const s = await seed();
    const other = await seed();
    await db.update(missions).set({ ownerAgentId: other.agentId }).where(eq(missions.id, s.missionId));
    await expect(submit(s)).rejects.toMatchObject({ status: 403 });
    await db.update(missions).set({ ownerAgentId: s.agentId }).where(eq(missions.id, s.missionId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.issueId));
    await expect(submit(s)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId))).toEqual([]);
  });
});
