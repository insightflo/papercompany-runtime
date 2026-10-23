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
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionContinuationStore } from "../services/operator-decision-continuation-store.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const now = new Date("2026-10-23T00:00:00Z");
const definition = {
  options: [],
  actions: [{ id: "continue", label: "Continue", outcome: "submit", tone: "primary", requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
} as const;

describeDb("C08 owner continuation delivery identity", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let decisionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("c08-owner-delivery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    decisionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C08", issuePrefix: `C${companyId.slice(0, 4)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover", status: "todo", assigneeAgentId: agentId });
    await db.insert(operatorDecisions).values({
      id: decisionId,
      companyId,
      requestKey: randomUUID(),
      requestHash: "hash",
      status: "resolved",
      interactionType: "action",
      title: "Continue recovery",
      sourceType: "workflow_step",
      sourceId: "recovery",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId,
      definition,
      result: { actionId: "continue", outcome: "submit", selectedOptionIds: [], comment: null },
      resolvedByUserId: "board",
      resolvedAt: now,
      continuationMode: "issue_current_assignee",
      requestedByUserId: "board",
    });
    await db.insert(operatorDecisionContinuations).values({
      companyId,
      operatorDecisionId: decisionId,
      issueId,
      nextAttemptAt: now,
    });
  });

  it("rejects target selection after the claimed generation key changes", async () => {
    const store = operatorDecisionContinuationStore(db);
    const [claimed] = await store.claimBatch("c08-cas", now);
    expect(claimed).toBeTruthy();
    await db.update(operatorDecisionContinuations)
      .set({ idempotencyKey: `${claimed!.idempotencyKey}:new` })
      .where(eq(operatorDecisionContinuations.id, claimed!.id));

    const targeted = await store.setTarget(claimed!.id, "c08-cas", agentId, {
      generation: claimed!.generation,
      attemptCount: claimed!.attemptCount,
      idempotencyKey: claimed!.idempotencyKey!,
      issueId: claimed!.issueId!,
    });

    expect(targeted).toBeNull();
    const [stored] = await db.select().from(operatorDecisionContinuations);
    expect(stored).toMatchObject({ state: "leased", targetAgentId: null });
  });

  it("builds wakeup and acceptance from the row returned by target selection", async () => {
    await db.execute(sql.raw(`
      CREATE FUNCTION c08_returned_delivery_key() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.idempotency_key := NEW.idempotency_key || ':returned';
        RETURN NEW;
      END $$;
      CREATE TRIGGER c08_returned_delivery_key
      BEFORE UPDATE OF target_agent_id ON operator_decision_continuations
      FOR EACH ROW WHEN (OLD.target_agent_id IS DISTINCT FROM NEW.target_agent_id)
      EXECUTE FUNCTION c08_returned_delivery_key();
    `));
    const wakeup = vi.fn(async (targetAgentId: string, options: { idempotencyKey: string; payload: { issueId: string } }) => {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: targetAgentId,
        source: "automation",
        status: "queued",
        issueId: options.payload.issueId,
        idempotencyKey: options.idempotencyKey,
      });
    });

    try {
      expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "c08-returned" }).pollOnce(now)).toBe(1);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER c08_returned_delivery_key ON operator_decision_continuations; DROP FUNCTION c08_returned_delivery_key();"));
    }

    const expectedKey = `operator-decision-wake:${decisionId}:g1:a1:returned`;
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ idempotencyKey: expectedKey }));
    const [stored] = await db.select().from(operatorDecisionContinuations);
    expect(stored).toMatchObject({ state: "accepted", targetAgentId: agentId, idempotencyKey: expectedKey });
  });
});
