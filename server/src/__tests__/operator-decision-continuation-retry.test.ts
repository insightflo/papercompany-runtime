import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const definition = {
  options: [], actions: [{ id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false }],
  selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [], forbiddenScope: [],
} as const;

describeDb("operator decision continuation retry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let decisionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-retry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => tempDb?.cleanup());
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry", issuePrefix: `Y${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "todo", assigneeAgentId: agentId });
    decisionId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: decisionId, companyId, requestKey: randomUUID(), requestHash: "hash", status: "resolved",
      interactionType: "action", title: "Card", sourceType: "system", sourceId: "source",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId, definition, result: { actionId: "hold", outcome: "hold", selectedOptionIds: [], comment: null },
      resolvedByUserId: "board", resolvedAt: new Date(), continuationMode: "issue_current_assignee",
    });
  });

  it("re-arms exhausted generations twice with cleared proof and fresh counters", async () => {
    await db.insert(operatorDecisionContinuations).values({
      companyId, operatorDecisionId: decisionId, issueId, state: "exhausted", attemptCount: 3,
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a3`, errorCode: "attempts_exhausted",
    });
    const service = operatorDecisionWriteService(db);
    const first = await service.retryContinuation(decisionId, "board");
    expect(first).toMatchObject({ applied: true, continuation: { state: "pending", generation: 2, manualRetryCount: 1, attemptCount: 0 } });
    await db.update(operatorDecisionContinuations).set({ state: "exhausted", attemptCount: 3, errorCode: "attempts_exhausted" })
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    const second = await service.retryContinuation(decisionId, "board");
    expect(second.continuation).toMatchObject({ generation: 3, manualRetryCount: 2, attemptCount: 0 });
    await db.update(operatorDecisionContinuations).set({ state: "exhausted", attemptCount: 3 })
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    await expect(service.retryContinuation(decisionId, "board")).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(activityLog).where(eq(activityLog.action, "operator_decision.continuation_retried")))).toHaveLength(2);
  });

  it("requires repair for blocked unassigned and never retries missing issues", async () => {
    await db.insert(operatorDecisionContinuations).values({
      companyId, operatorDecisionId: decisionId, issueId, state: "blocked", errorCode: "issue_unassigned",
    });
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    const service = operatorDecisionWriteService(db);
    await expect(service.retryContinuation(decisionId, "board")).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await expect(service.retryContinuation(decisionId, "board")).resolves.toMatchObject({ applied: true });
    await db.update(operatorDecisionContinuations).set({ state: "blocked", errorCode: "issue_missing" })
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    await expect(service.retryContinuation(decisionId, "board")).rejects.toMatchObject({ status: 409 });
  });

  it("cancels an old queued request with the exact CAS before assignee-change retry", async () => {
    const oldAgentId = randomUUID();
    await db.insert(agents).values({ id: oldAgentId, companyId, name: "Old" });
    const [wakeup] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: oldAgentId, source: "automation", status: "queued", issueId,
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a1`,
    }).returning();
    await db.insert(operatorDecisionContinuations).values({
      companyId, operatorDecisionId: decisionId, issueId, state: "accepted", attemptCount: 1,
      targetAgentId: oldAgentId, wakeupRequestId: wakeup!.id,
      idempotencyKey: wakeup!.idempotencyKey, acceptedAt: new Date(),
    });
    await operatorDecisionWriteService(db).retryContinuation(decisionId, "board");
    const [cancelled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup!.id));
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Superseded by operator decision retry" });
    expect(cancelled?.finishedAt).toBeInstanceOf(Date);
  });
});
