import { randomUUID } from "node:crypto";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
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
    const post = (recoveryTarget: NonNullable<MissionOwnerDecisionSubmit["recoveryTarget"]>) => submitMissionOwnerDecision({ db, issueId: s.issueId,
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

  async function toolCard(s: Awaited<ReturnType<typeof seed>>) {
    const workflowRunId = randomUUID(), stepRunId = randomUUID();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: s.companyId,
      name: "tool card", stepsJson: [{ id: "selected", type: "tool", toolNames: ["fixture"] }] }).returning();
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId: definition.id,
      companyId: s.companyId, missionId: s.missionId, status: "failed", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "selected", status: "failed" });
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.issueId, workflowRunId, workflowStepRunId: stepRunId, layer: "mission_owner_recovery",
      eventType: "owner_tool_recovery_target_v1", idempotencyKey: `owner-tool-card:${stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId, stepRunId } });
    // Removing the display marker must not disable the durable card contract.
    await db.update(issues).set({ description: "No recovery instructions in this description" }).where(eq(issues.id, s.issueId));
    return { kind: "tool_step" as const, workflowRunId, stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: 0, failedDispatchRequestId: null };
  }
  const postDecision = (s: Awaited<ReturnType<typeof seed>>, data: MissionOwnerDecisionSubmit) =>
    submitMissionOwnerDecision({ db, issueId: s.issueId,
      actor: { actorType: "agent", actorId: s.agentId, agentId: s.agentId, runId: s.runId }, data });

  it.each(["retry_source_issue", "recover_artifact"] as const)("requires a tool target for structured %s before any writes", async (decision) => {
    const s = await seed();
    await toolCard(s);
    const beforeIssue = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const beforeEvents = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId));
    for (const recoveryTarget of [undefined, { kind: "issue" as const, issueId: s.sourceId }]) {
      await expect(postDecision(s, { decision, recoveryTarget })).rejects.toMatchObject({ status: 409,
        details: { reason: "owner_recovery_tool_target_required" } });
      expect(await db.select().from(issues).where(eq(issues.id, s.issueId))).toEqual(beforeIssue);
      expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId))).toEqual(beforeEvents);
    }
  });

  it("accepts and preserves a valid exact structured tool target", async () => {
    const s = await seed();
    const recoveryTarget = await toolCard(s);
    const result = await postDecision(s, { decision: "retry_source_issue", recoveryTarget });
    const latest = await loadLatestMissionOwnerDecision({ db, companyId: s.companyId, ownerActionIssueId: s.issueId });
    expect(latest?.eventId).toBe(result.eventId);
    expect(latest?.decision.recoveryTarget).toEqual(recoveryTarget);
  });

  it.each(["request_input", "escalate", "no_action_waiting"] as const)("allows structured tool-card %s without a tool target", async (decision) => {
    const s = await seed();
    await toolCard(s);
    const result = await postDecision(s, { decision, reason: "Human decision needed" });
    expect((await loadLatestMissionOwnerDecision({ db, companyId: s.companyId, ownerActionIssueId: s.issueId }))?.eventId).toBe(result.eventId);
  });

  it.each(["request_input", "escalate"] as const)("preserves oversight %s target prohibition", async (decision) => {
    const s = await seed();
    await db.update(issues).set({ originKind: "mission_main_executor_oversight" }).where(eq(issues.id, s.issueId));
    const before = await db.select().from(issues).where(eq(issues.id, s.issueId));
    await expect(postDecision(s, { decision, recoveryTarget: { kind: "issue", issueId: s.sourceId } })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issues).where(eq(issues.id, s.issueId))).toEqual(before);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId))).toEqual([]);
    expect((await postDecision(s, { decision })).eventId).toBeTruthy();
  });

  it("does not require targets from legacy description text or one failed tool step", async () => {
    const s = await seed();
    const target = await toolCard(s);
    await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId));
    await db.update(issues).set({ description: `<!-- tool-step-recovery:${target.workflowRunId}:selected -->` }).where(eq(issues.id, s.issueId));
    expect((await postDecision(s, { decision: "retry_source_issue" })).eventId).toBeTruthy();
  });

  it("does not treat foreign-scope or unsupported-version links as this card", async () => {
    for (const variant of ["foreign_mission", "unsupported_version"] as const) {
      const s = await seed();
      await toolCard(s);
      if (variant === "foreign_mission") {
        const [other] = await db.insert(missions).values({ companyId: s.companyId, ownerAgentId: s.agentId, title: "other" }).returning();
        await db.update(workflowTransitionEvents).set({ missionId: other.id }).where(eq(workflowTransitionEvents.issueId, s.issueId));
      } else {
        await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: 2, kind: "tool_step" } }).where(eq(workflowTransitionEvents.issueId, s.issueId));
      }
      expect((await postDecision(s, { decision: "retry_source_issue" })).eventId).toBeTruthy();
    }
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
