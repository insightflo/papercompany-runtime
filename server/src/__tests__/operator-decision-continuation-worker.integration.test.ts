import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const definition = {
  options: [{ id: "one", label: "One", description: null, facts: [], evidenceRefs: [] }],
  actions: [{ id: "choose", label: "Choose", outcome: "submit", tone: "primary", requiresSelection: true }],
  selection: { min: 1, max: 1 },
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [], forbiddenScope: [],
} as const;

describeDb("operator decision continuation worker", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let decisionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-worker-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker", issuePrefix: `W${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Target" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "todo", assigneeAgentId: agentId });
    decisionId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: decisionId, companyId, requestKey: randomUUID(), requestHash: "hash", status: "resolved",
      interactionType: "single_select", title: "Choose", sourceType: "workflow_step", sourceId: "step",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId, definition, result: { actionId: "choose", outcome: "submit", selectedOptionIds: ["one"], comment: null },
      resolvedByUserId: "board", resolvedAt: new Date(), continuationMode: "issue_current_assignee",
    });
    await db.insert(operatorDecisionContinuations).values({ companyId, operatorDecisionId: decisionId, issueId });
  });

  it("calls heartbeat with the exact envelope and accepts durable proof", async () => {
    const wakeup = vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId: targetAgentId, source: "automation", status: "queued",
        triggerDetail: "system", reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        requestedByActorType: "user", requestedByActorId: "board",
        idempotencyKey: options.idempotencyKey as string,
        issueId,
      });
    });
    const worker = operatorDecisionContinuationWorker(db, { wakeup, workerId: "test-worker" });
    await worker.pollOnce();
    // [delivery bridge] payload/contextSnapshot 매칭에 paperclipOperatorDecisionResolution 키 추가 —
    //   기존 키의 의미는 변경 없음(신규 전달 필드 추가).
    expect(wakeup).toHaveBeenCalledWith(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "operator_decision_resolved",
      payload: {
        kind: "operator_decision_resolution",
        operatorDecisionId: decisionId,
        issueId,
        actionId: "choose",
        selectedOptionIds: ["one"],
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: decisionId,
          options: [{ id: "one", label: "One", description: null }],
        },
      },
      contextSnapshot: {
        issueId,
        wakeReason: "operator_decision_resolved",
        operatorDecisionId: decisionId,
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: decisionId,
          options: [{ id: "one", label: "One", description: null }],
        },
      },
      requestedByActorType: "user",
      requestedByActorId: "board",
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a1`,
    });
    const [continuation] = await db.select().from(operatorDecisionContinuations);
    expect(continuation).toMatchObject({ state: "accepted", targetAgentId: agentId, attemptCount: 1 });
    expect(continuation?.wakeupRequestId).toBeTruthy();
    expect((await db.select().from(activityLog)).map((row) => row.action)).toContain("operator_decision.continuation_accepted");
  });

  it.each([
    ["missing", null, "issue_missing"],
    ["unassigned", { status: "todo", assigneeAgentId: null }, "issue_unassigned"],
    ["terminal", { status: "done", assigneeAgentId: agentId }, "issue_terminal"],
  ])("blocks %s issue before heartbeat", async (_name, issueUpdate, errorCode) => {
    if (issueUpdate === null) await db.delete(issues).where(eq(issues.id, issueId));
    else await db.update(issues).set(issueUpdate).where(eq(issues.id, issueId));
    const wakeup = vi.fn();
    await operatorDecisionContinuationWorker(db, { wakeup, workerId: "blocker" }).pollOnce();
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({ state: "blocked", errorCode });
  });

  it("retries absent proof at 5s/30s and exhausts the third attempt", async () => {
    const wakeup = vi.fn().mockRejectedValue(new Error("no proof"));
    const worker = operatorDecisionContinuationWorker(db, { wakeup, workerId: "retry" });
    const times = [
      new Date("2026-07-29T12:00:00Z"),
      new Date("2026-07-29T12:00:06Z"),
      new Date("2026-07-29T12:00:37Z"),
    ];
    await db.update(operatorDecisionContinuations).set({ nextAttemptAt: times[0] }).where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    for (const time of times) await worker.pollOnce(time);
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({ state: "exhausted", attemptCount: 3 });
    expect(wakeup).toHaveBeenCalledTimes(3);
  });
});
