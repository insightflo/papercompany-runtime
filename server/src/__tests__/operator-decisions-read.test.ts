import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionReadService } from "../services/operator-decisions-read.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const sourceContext = { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] };
const definition = {
  options: [],
  actions: [{ id: "hold", label: "Hold", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled" as const, label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
};

describeDb("operator decision read service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decisions-read-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => tempDb?.cleanup());

  beforeEach(async () => {
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Read", issuePrefix: `R${companyId.slice(0, 4)}` });
  });

  async function insertDecision(overrides: Partial<typeof operatorDecisions.$inferInsert> = {}) {
    const [row] = await db.insert(operatorDecisions).values({
      companyId,
      requestKey: randomUUID(),
      requestHash: randomUUID().replaceAll("-", ""),
      interactionType: "action",
      title: "Card",
      sourceType: "system",
      sourceId: "source",
      sourceContext,
      definition,
      ...overrides,
    }).returning();
    return row!;
  }

  it("orders pending by priority then created/id and paginates with bound cursors", async () => {
    const low = await insertDecision({ priority: "low", createdAt: new Date("2026-07-29T02:00:00Z") });
    const critical = await insertDecision({ priority: "critical", createdAt: new Date("2026-07-29T03:00:00Z") });
    const high = await insertDecision({ priority: "high", createdAt: new Date("2026-07-29T01:00:00Z") });
    const service = operatorDecisionReadService(db);
    const first = await service.list(companyId, { view: "pending", limit: 2 });
    expect(first.data.map((item) => item.id)).toEqual([critical.id, high.id]);
    expect(first.page.nextCursor).toBeTruthy();
    const second = await service.list(companyId, { view: "pending", limit: 2, cursor: first.page.nextCursor! });
    expect(second.data.map((item) => item.id)).toEqual([low.id]);
    await expect(service.list(companyId, { view: "history", limit: 2, cursor: first.page.nextCursor! }))
      .rejects.toBeDefined();
  });

  it("returns explicit nullable view fields and company isolation", async () => {
    const row = await insertDecision({ requestedByUserId: "user-1" });
    const service = operatorDecisionReadService(db);
    await expect(service.getById(row.id)).resolves.toMatchObject({
      id: row.id,
      requestedBy: { type: "user", id: "user-1" },
      result: null,
      continuation: null,
    });
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: `X${otherCompany.slice(0, 4)}` });
    expect((await service.list(otherCompany, { view: "pending", limit: 50 })).data).toEqual([]);
  });

  it("lists continuation attention while excluding fresh pending continuation", async () => {
    const fresh = await insertDecision({
      status: "resolved",
      result: { actionId: "hold", outcome: "hold", selectedOptionIds: [], comment: null },
      resolvedByUserId: "board",
      resolvedAt: new Date(),
    });
    const blocked = await insertDecision({
      status: "resolved",
      result: { actionId: "hold", outcome: "hold", selectedOptionIds: [], comment: null },
      resolvedByUserId: "board",
      resolvedAt: new Date(),
    });
    await db.insert(operatorDecisionContinuations).values([
      { companyId, operatorDecisionId: fresh.id, state: "pending", nextAttemptAt: new Date() },
      { companyId, operatorDecisionId: blocked.id, state: "blocked", errorCode: "issue_unassigned" },
    ]);
    const result = await operatorDecisionReadService(db).list(companyId, { view: "attention", limit: 50 });
    expect(result.data.map((item) => item.id)).toEqual([blocked.id]);
    expect(result.data[0]?.continuation).toMatchObject({ effectiveStatus: "blocked", errorCode: "issue_unassigned" });
  });
});
