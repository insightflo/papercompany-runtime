import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionContinuationStore } from "../services/operator-decision-continuation-store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const definition = {
  options: [],
  actions: [{ id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
} as const;

describeDb("operator decision continuation store", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let decisionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-store-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Store", issuePrefix: `S${companyId.slice(0, 4)}` });
    decisionId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: decisionId,
      companyId,
      requestKey: randomUUID(),
      requestHash: "hash",
      status: "resolved",
      interactionType: "action",
      title: "Card",
      sourceType: "system",
      sourceId: "source",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      definition,
      result: { actionId: "hold", outcome: "hold", selectedOptionIds: [], comment: null },
      resolvedByUserId: "board",
      resolvedAt: new Date(),
      continuationMode: "issue_current_assignee",
    });
  });

  it("CAS claims pending once and allocates the generation attempt key", async () => {
    const [continuation] = await db.insert(operatorDecisionContinuations).values({
      companyId, operatorDecisionId: decisionId, nextAttemptAt: new Date("2026-07-29T11:00:00Z"),
    }).returning();
    const store = operatorDecisionContinuationStore(db);
    const now = new Date("2026-07-29T12:00:00Z");
    const [first, second] = await Promise.all([
      store.claimBatch("worker-a", now),
      store.claimBatch("worker-b", now),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: continuation!.id,
      state: "leased",
      generation: 1,
      attemptCount: 1,
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a1`,
    });
  });

  it("reclaims expired lease without consuming another attempt or key", async () => {
    await db.insert(operatorDecisionContinuations).values({
      companyId,
      operatorDecisionId: decisionId,
      state: "leased",
      generation: 1,
      attemptCount: 2,
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a2`,
      leaseOwner: "dead",
      leaseExpiresAt: new Date("2026-07-29T11:59:00Z"),
    });
    const [claimed] = await operatorDecisionContinuationStore(db).claimBatch("restart", new Date("2026-07-29T12:00:00Z"));
    expect(claimed).toMatchObject({ attemptCount: 2, idempotencyKey: `operator-decision-wake:${decisionId}:g1:a2`, leaseOwner: "restart" });
  });
});
