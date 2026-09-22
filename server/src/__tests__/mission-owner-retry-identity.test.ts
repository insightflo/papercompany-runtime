import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { buildMissionOwnerDecisionWakeupIdempotencyKey } from "../services/missions/mission-owner-recovery-events.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("owner-retry-identity-"); }, 60_000);
afterAll(async () => { await temp?.cleanup(); });

async function seed() {
  const db = createDb(temp.connectionString);
  const companyId = randomUUID(), missionId = randomUUID(), ownerId = randomUUID(), workerId = randomUUID();
  const sourceId = randomUUID(), ownerIssueId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Retry identity", issuePrefix: `RI${companyId.slice(0, 8)}` });
  await db.insert(agents).values([ownerId, workerId].map(id => ({ id, companyId, name: id, role: "engineer", status: "active", adapterType: "process" })));
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "Retry", status: "active" });
  await db.insert(issues).values([
    { id: sourceId, companyId, missionId, title: "Source", status: "blocked", assigneeAgentId: workerId, originKind: "workflow_execution" },
    { id: ownerIssueId, companyId, missionId, title: "Recovery", status: "in_progress", assigneeAgentId: ownerId, originKind: "mission_main_executor_unblock", originId: sourceId },
  ]);
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId: ownerIssueId, status: "succeeded", finishedAt: new Date() });
  const dispatch = vi.fn(async () => ({ status: "dispatched" as const, runId: randomUUID() }));
  const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied: dispatch });
  const sweep = () => svc.runMainExecutorSupervision({ missionId, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
  const decision = (reason: string, option: "retry_source_issue" | "no_action_waiting" = "retry_source_issue") => recordMissionOwnerDecision({
    db, issue: { id: ownerIssueId, companyId, missionId }, sourceIssueId: sourceId, heartbeatRunId: runId,
    submission: { decision: option, sourceIssueRef: sourceId, reason },
  });
  const legacyKey = buildMissionOwnerDecisionWakeupIdempotencyKey({ missionId, ownerActionIssueId: ownerIssueId, sourceIssueId: sourceId });
  const legacy = async (at: Date) => {
    await db.insert(workflowTransitionEvents).values({ companyId, missionId, issueId: ownerIssueId, eventType: "mission_owner_retry_wakeup", layer: "mission_owner_recovery", decision: "retry_source_issue", idempotencyKey: legacyKey, toStatus: "dispatched", createdAt: at });
  };
  return { db, companyId, missionId, ownerId, workerId, sourceId, ownerIssueId, runId, dispatch, sweep, decision, legacy };
}

suite("owner retry identity through real structured ledger and supervision", () => {
  it("dispatches each new decision once, preserving same-event idempotency", async () => {
    const s = await seed();
    const first = await s.decision("first failure corrected");
    await s.sweep(); await s.sweep();
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    const second = await s.decision("second failure corrected");
    await s.sweep(); await s.sweep();
    expect(s.dispatch).toHaveBeenCalledTimes(2);
    expect(s.dispatch.mock.calls.map(call => (call as unknown as [{ decisionCommentId: string }])[0].decisionCommentId)).toEqual([first.eventId, second.eventId]);
  });
  it("does not replay a decision already consumed by legacy dispatch", async () => {
    const s = await seed(); const old = await s.decision("old");
    await s.legacy(new Date(old.createdAt.getTime() + 1));
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("does not let legacy dispatch consume a later decision", async () => {
    const s = await seed();
    await s.legacy(new Date("2026-01-01T00:00:00Z"));
    await s.decision("new failure corrected");
    await s.sweep(); await s.sweep(); expect(s.dispatch).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent sweeps from independent service instances", async () => {
    const s = await seed(); await s.sweep(); await s.decision("one retry");
    s.dispatch.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return { status: "dispatched", runId: randomUUID() }; });
    const other = missionService(s.db, { onOwnerDecisionRetrySourceIssueApplied: s.dispatch });
    await Promise.all([s.sweep(), other.runMainExecutorSupervision({ missionId: s.missionId, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true })]);
    await s.sweep(); expect(s.dispatch).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch while the source has active execution", async () => {
    const s = await seed(); await s.decision("retry");
    await s.db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.workerId, issueId: s.sourceId, status: "running" });
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("refuses a retry superseded by a structured waiting decision", async () => {
    const s = await seed(); await s.decision("old retry"); await s.decision("wait", "no_action_waiting");
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("refuses a decision with mismatched heartbeat issue binding", async () => {
    const s = await seed(); await s.decision("mismatched");
    await s.db.update(heartbeatRuns).set({ issueId: s.sourceId }).where(eq(heartbeatRuns.id, s.runId));
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("preserves half-applied legacy retry without a new apply record", async () => {
    const s = await seed(); const record = await s.decision("legacy pending");
    const key = buildMissionOwnerDecisionWakeupIdempotencyKey({ missionId: s.missionId, ownerActionIssueId: s.ownerIssueId, sourceIssueId: s.sourceId });
    await s.db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId, issueId: s.ownerIssueId, eventType: "mission_owner_retry_apply", layer: "mission_owner_recovery", idempotencyKey: `${key}:apply`, createdAt: new Date(record.createdAt.getTime() + 1) });
    await s.sweep(); await s.sweep(); expect(s.dispatch).toHaveBeenCalledTimes(1);
    const rows = await s.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.ownerIssueId));
    expect(rows.filter(row => row.eventType === "mission_owner_retry_apply")).toHaveLength(1);
  });
  it("refuses foreign mission and non-owner authors without gaining identity authority", async () => {
    const s = await seed(); const record = await s.decision("wrong author");
    await s.db.update(heartbeatRuns).set({ agentId: s.workerId }).where(eq(heartbeatRuns.id, s.runId));
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
    await s.db.update(heartbeatRuns).set({ agentId: s.ownerId }).where(eq(heartbeatRuns.id, s.runId));
    const foreign = randomUUID();
    await s.db.insert(missions).values({ id: foreign, companyId: s.companyId, ownerAgentId: s.ownerId, title: "Foreign" });
    await s.db.update(workflowTransitionEvents).set({ missionId: foreign }).where(eq(workflowTransitionEvents.id, record.eventId));
    await s.sweep(); expect(s.dispatch).not.toHaveBeenCalled();
  });
});
