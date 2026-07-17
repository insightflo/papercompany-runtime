// server/src/__tests__/source-issue-cap-override-integration.test.ts
//
// [목적] REAL owner decision comment → mission supervision → native cap-override 통합. mock 수신 여부가
//   아니라 실제 DB 상태(iteration+1, run running, step pending, exact wake key queue row, issue todo,
//   audit accepted) 로 성공을 검증한다. callback/queue failure 시 issue/run/step 가 원복되고 todo-only
//   잔재가 남지 않는다(supervision 이 cap-override candidate 에서 선재 reopen 하지 않기 때문).
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { missionService } from "../services/missions.js";
import { auditEvents, drainHeartbeatRuns, MAX_ITER, PRODUCER, reloadRun, reloadStepRun, seedCapExhaustedRun, startCapOverrideTestDb, testWake, type SeedOpts } from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip cap-override-integration tests: ${support.reason ?? "unsupported host"}`);

// REAL native callback — mirrors server/src/app.ts onOwnerDecisionRetrySourceIssueApplied. No mock.
function realCallback(db: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"]) {
  return async ({ mission, ownerActionIssue, sourceIssue, targetAgentId, decisionCommentId }: {
    mission: { companyId: string; id: string }; ownerActionIssue: { id: string }; sourceIssue: { id: string };
    targetAgentId: string; decisionCommentId?: string | null;
  }) => {
    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: mission.companyId, issueId: sourceIssue.id, allowBlockedIssue: true, agentId: targetAgentId,
      ownerAction: { ownerActionIssueId: ownerActionIssue.id, missionId: mission.id, decisionCommentId: decisionCommentId ?? "" },
      wakeFn: testWake(db),
    });
    if (outcome.kind === "dispatched" || outcome.kind === "cap_override_applied") return { status: "dispatched" as const, runId: outcome.workflowRunId };
    if (outcome.kind === "already_in_flight" || outcome.kind === "cap_override_already_applied") return { status: "workflow_already_dispatched" as const };
    return { status: "not_requested" as const };
  };
}

describeEP("owner decision comment → supervision → native cap-override (real integration)", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  // no afterEach row clearing — isolation is by randomUUID company scope (all queries company-scoped).
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  async function runSupervision(missionId: string, companyId: string, now: Date) {
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied: realCallback(db) });
    return svc.runMainExecutorSupervision({ missionId, now, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
  }

  it("SUCCESS: real owner retry_source_issue comment drives supervision → cap-override (iter+1, run running, step pending, exact wake row, issue todo)", async () => {
    const s = await seedCapExhaustedRun(db);
    await runSupervision(s.missionId, s.companyId, new Date("2026-07-10T00:25:00.000Z"));

    expect((await reloadRun(db, s.workflowRunId)).status).toBe("running");
    expect((await reloadRun(db, s.workflowRunId)).completedAt).toBeNull();
    const producer = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(MAX_ITER + 1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    // supervision did NOT pre-reopen (cap-override candidate); cap-override reopened atomically (completedAt cleared).
    // the real heartbeat may then promote todo→in_progress — both prove the producer is runnable post-override.
    expect(["todo", "in_progress"]).toContain(issue.status);
    expect(issue.completedAt).toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.workflowStepRunId, s.producerStepRunId), eq(agentWakeupRequests.requestKind, "workflow_resume"), eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.decisionCommentId}`)));
    expect(wakes).toHaveLength(1);
    const events = await auditEvents(db, s.companyId);
    expect(events).toHaveLength(1);
    expect(events[0]!.idempotencyKey).toBe(`cap-override:${s.decisionCommentId}`);
    expect((events[0]!.payload as Record<string, unknown>).status).toBe("accepted");
  });

  it("FAILURE: non-reopenable (cancelled) producer → cap-override queue rollback; issue/run/step stay consistent (no todo-only leftover)", async () => {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus: "cancelled" } as SeedOpts);
    await runSupervision(s.missionId, s.companyId, new Date("2026-07-10T00:25:00.000Z"));
    // supervision skipped pre-reopen (cap-override candidate); cap-override forward issue CAS lost → rolled back.
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
    const producer = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(MAX_ITER);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    expect(issue.status).toBe("cancelled");   // NOT reopened to todo — no inconsistent todo-only state
    expect(await auditEvents(db, s.companyId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.workflowStepRunId, s.producerStepRunId), eq(agentWakeupRequests.requestKind, "workflow_resume")))).toHaveLength(0);
  });
  it("D resolver: newer recognized replan supersedes retry; supervision does not pass stale retry decision or wake producer", async () => {
    const s = await seedCapExhaustedRun(db);
    await db.insert(issueComments).values({
      companyId: s.companyId,
      issueId: s.ownerActionIssueId,
      authorAgentId: s.ownerAgentId,
      createdAt: new Date("2026-07-10T00:40:00.000Z"),
      body: `### Mission owner decision\nDecision: replan_mission\nSource issue: ${s.producerIssueId}\nReason: supersede retry.`,
    });
    await runSupervision(s.missionId, s.companyId, new Date("2026-07-10T00:45:00.000Z"));
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
    expect((await reloadStepRun(db, s.workflowRunId, PRODUCER)).status).toBe("completed");
    expect(await auditEvents(db, s.companyId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
      eq(agentWakeupRequests.workflowStepRunId, s.producerStepRunId),
    ))).toHaveLength(0);
  });
});
