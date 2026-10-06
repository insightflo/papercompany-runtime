import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { inArray } from "drizzle-orm";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const history = JSON.parse(readFileSync(new URL("./fixtures/qa-card-history/payloads.json", import.meta.url), "utf8")) as Array<{
  kind: string; payload: Record<string, unknown>;
}>;
const payload = history.find(({ kind }) => kind === "iteration0")!.payload;
const system = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA cleanup scope regressions: ${support.reason}`);

describeDb("QA previous-card cleanup uses literal run/producer identity", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cleanup-scope-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "QA cleanup scope", issuePrefix: id });
    return id;
  }
  async function scenario(producerStepId = "produce_one") {
    return {
      db, companyId: await company(), workflowRunId: randomUUID(), producerStepId,
      iteration: 11, maxIterations: 20, missionId: null, linkIssueId: null,
      findings: [{ id: "source", summary: "Source data missing", layer: "source_data" as const }],
      qaRefs: [],
    };
  }
  // Seed previous cards without invoking the cleanup under test during setup.
  async function seed(companyId: string, workflowRunId: string, producerStepId: string, iteration = 0,
    sourceType = "workflow_qa_rejection") {
    const sourceId = `${workflowRunId}:${producerStepId}:${iteration}`;
    return (await operatorDecisionWriteService(db).create(companyId, {
      ...payload, requestKey: `fixture:${randomUUID()}`, sourceType, sourceId,
      sourceContext: { missionId: null, workflowId: null, workflowRunId, artifactRefs: [] },
    }, system)).decision.id;
  }
  const rows = (companyIds: string[]) => db.select({
    id: operatorDecisions.id, companyId: operatorDecisions.companyId, sourceId: operatorDecisions.sourceId,
    sourceType: operatorDecisions.sourceType, requestKey: operatorDecisions.requestKey,
    requestHash: operatorDecisions.requestHash, status: operatorDecisions.status, result: operatorDecisions.result,
    resolvedByUserId: operatorDecisions.resolvedByUserId, resolvedAt: operatorDecisions.resolvedAt,
    cancelledAt: operatorDecisions.cancelledAt, updatedAt: operatorDecisions.updatedAt,
  }).from(operatorDecisions).where(inArray(operatorDecisions.companyId, companyIds)).orderBy(operatorDecisions.id);
  async function snapshot(companyIds: string[]) {
    return {
      decisions: await rows(companyIds),
      audits: await db.select({ id: activityLog.id, entityId: activityLog.entityId, action: activityLog.action,
        actorId: activityLog.actorId, details: activityLog.details }).from(activityLog)
        .where(inArray(activityLog.companyId, companyIds)).orderBy(activityLog.id),
      continuations: await db.select({ id: operatorDecisionContinuations.id,
        operatorDecisionId: operatorDecisionContinuations.operatorDecisionId, state: operatorDecisionContinuations.state,
      }).from(operatorDecisionContinuations).where(inArray(operatorDecisionContinuations.companyId, companyIds)),
    };
  }

  // Removing literal escaping must fail either isolation or intended superseding.
  // Short %/backslash IDs cannot enter the readable request-key contract; long
  // identities reach the existing hash-key path without changing that contract.
  const longPrefix = "p".repeat(105);
  const identities = [
    { name: "underscore", producer: "produce_one", other: "produceXone" },
    { name: "percent", producer: `${longPrefix}%one`, other: `${longPrefix}-extra-one` },
    { name: "backslash", producer: `${longPrefix}\\one`, other: `${longPrefix}one` },
    { name: "trailing backslash", producer: `${longPrefix}\\`, other: longPrefix },
    { name: "combined escapes", producer: `${longPrefix}\\_%one`, other: `${longPrefix}_XXone` },
  ];
  it.each(identities.flatMap((identity) => ["create", "replay"].map((mode) => ({ ...identity, mode }))))(
    "$mode with $name supersedes only literal same-source pending cards", async ({ producer, other, mode }) => {
      const input = await scenario(producer);
      const foreignCompany = await company();
      const companyIds = [input.companyId, foreignCompany];
      let currentId: string | undefined;
      if (mode === "replay") {
        const initial = await ensureQaSourceDefectOwnerCard(input);
        expect(initial.outcome).toBe("created");
        if (initial.outcome !== "created") throw new Error(JSON.stringify(initial));
        currentId = initial.decisionId;
      }
      const staleIds = [
        await seed(input.companyId, input.workflowRunId, producer, 0),
        await seed(input.companyId, input.workflowRunId, producer, 10),
      ];
      const unrelatedIds = [
        await seed(input.companyId, input.workflowRunId, other),
        await seed(input.companyId, randomUUID(), producer),
        await seed(foreignCompany, input.workflowRunId, producer),
        await seed(input.companyId, input.workflowRunId, producer, 0, "unrelated_review"),
      ];
      const before = await rows(companyIds);
      const result = await ensureQaSourceDefectOwnerCard(input);
      expect(result.outcome, JSON.stringify(result)).toBe(mode === "create" ? "created" : "replayed");
      if (result.outcome !== "created" && result.outcome !== "replayed") throw new Error(JSON.stringify(result));
      if (currentId) expect(result.decisionId).toBe(currentId);
      const after = await snapshot(companyIds);
      expect.soft(after.decisions.filter(({ id }) => unrelatedIds.includes(id)))
        .toEqual(before.filter(({ id }) => unrelatedIds.includes(id)));
      expect.soft(after.decisions.filter(({ id }) => staleIds.includes(id)).map(({ status }) => status))
        .toEqual(["cancelled", "cancelled"]);
      expect(after.decisions.find(({ id }) => id === result.decisionId)?.status).toBe("pending");
      expect.soft(after.audits.filter(({ action }) => action === "operator_decision.cancelled")
        .map(({ entityId }) => entityId).sort()).toEqual([...staleIds].sort());
      expect(after.continuations).toEqual([]);
      expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: result.decisionId });
      expect(await snapshot(companyIds)).toEqual(after);
    });

  it.each(["resolved", "cancelled"])("preserves a human %s same-source card", async (terminal) => {
    const input = await scenario();
    const prior = await ensureQaSourceDefectOwnerCard({ ...input, iteration: 0 });
    expect(prior.outcome).toBe("created");
    if (prior.outcome !== "created") throw new Error(JSON.stringify(prior));
    const write = operatorDecisionWriteService(db);
    if (terminal === "resolved") await write.resolve(prior.decisionId, {
      actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: "Human decision",
    }, "human");
    else await write.cancel(prior.decisionId, { type: "user", id: "human" });
    const before = await snapshot([input.companyId]);
    expect((await ensureQaSourceDefectOwnerCard(input)).outcome).toBe("created");
    expect(await ensureQaSourceDefectOwnerCard({ ...input, iteration: 0 }))
      .toEqual({ outcome: "replayed", decisionId: prior.decisionId });
    const after = await snapshot([input.companyId]);
    expect(after.decisions.find(({ id }) => id === prior.decisionId)).toEqual(before.decisions[0]);
    expect(after.audits.filter(({ entityId }) => entityId === prior.decisionId)).toEqual(before.audits);
    expect(after.continuations).toEqual(before.continuations);
  });

  it("a current hash conflict leaves all cards and audits untouched", async () => {
    const input = await scenario();
    expect((await ensureQaSourceDefectOwnerCard(input)).outcome).toBe("created");
    await seed(input.companyId, input.workflowRunId, input.producerStepId);
    await seed(input.companyId, input.workflowRunId, "produceXone");
    const before = await snapshot([input.companyId]);
    expect((await ensureQaSourceDefectOwnerCard({ ...input, maxIterations: 21 })).outcome).toBe("conflict");
    expect(await snapshot([input.companyId])).toEqual(before);
  });
});
