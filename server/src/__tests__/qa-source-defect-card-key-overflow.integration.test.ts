import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, operatorDecisions, workflowDefinitions, workflowStepRuns } from "@paperclipai/db";
import { workflowStepDefinitionSchema } from "@paperclipai/shared/validators/workflow";
import { and, eq } from "drizzle-orm";
import { buildQaSourceDefectCardRequestKey, ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const runId = "11111111-1111-4111-8111-111111111111";
const producerIds = ["p".repeat(102), "p".repeat(101) + "q"];
const digests = [
  "ffb422e2818dd9501f967e1d32e379661da2fa9c36dcb0295faa37d5e1f8defc",
  "4df87477e27f7c7aa75d6641b1d9572912d5c72d2aa0c6fa8d533b19bb1b804c",
];

describe("QA card request key overflow", () => {
  // Hashing at >=160 instead of >160 would change an existing readable identity.
  it.each([7, 101])("preserves readable keys with producer length %i through the 160-unit boundary", (length) => {
    const input = { workflowRunId: runId, producerStepId: "p".repeat(length), iteration: 0 };
    const expected = `qa-source-defect:v2:${runId}:${input.producerStepId}:0`;
    expect(expected.length).toBe(length + 59);
    expect(buildQaSourceDefectCardRequestKey(input)).toBe(expected);
    expect(buildQaSourceDefectCardRequestKey({ ...input })).toBe(expected);
  });
  // Missing overflow hashing or truncating the producer would fail these independent digest fixtures.
  it("uses the full deterministic SHA-256 producer digest only for overflow", () => {
    const keys = producerIds.map((producerStepId, index) => {
      const input = { workflowRunId: runId, producerStepId, iteration: 0 };
      const key = buildQaSourceDefectCardRequestKey(input);
      expect(key).toBe(`qa-source-defect-sha256:v2:${runId}:${digests[index]}:0`);
      expect(key.length).toBeLessThanOrEqual(160);
      expect(buildQaSourceDefectCardRequestKey({ ...input })).toBe(key);
      return key;
    });
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("QA card overflow namespace isolation", () => {
  // A digest token under the readable prefix aliases a legitimate short producer ID.
  it("keeps a long producer distinct from its valid literal sha256 producer ID", () => {
    const literalProducerId = `sha256-${digests[0]}`;
    expect(workflowStepDefinitionSchema.safeParse({ id: literalProducerId, type: "agent", name: "Literal producer" }).success).toBe(true);
    const input = { workflowRunId: runId, iteration: 0 };
    const readable = buildQaSourceDefectCardRequestKey({ ...input, producerStepId: literalProducerId });
    expect(readable).toBe(`qa-source-defect:v2:${runId}:${literalProducerId}:0`);
    expect(buildQaSourceDefectCardRequestKey({ ...input, producerStepId: producerIds[0]! })).not.toBe(readable);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA card overflow DB test: ${support.reason ?? "unsupported"}`);

describeDb("QA card overflow persistence", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-card-overflow-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  // Missing NFC guard either strands normalized identities or cancels stale cards before validation fails.
  it.each(["e\u0301".repeat(60), "\u0344".repeat(102)])("rejects NFC-changing overflow identity before DB mutations: %s", async (producerStepId) => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const input = { db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId, iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null };
    const sourceId = `${seed.runId}:${producerStepId}:0`;
    expect(sourceId.length).toBeLessThanOrEqual(200);
    expect(sourceId.normalize("NFC")).not.toBe(sourceId);
    const stale = await ensureQaSourceDefectOwnerCard({ ...input, producerStepId: "stale" });
    if (stale.outcome !== "created") throw new Error(JSON.stringify(stale));
    await db.update(operatorDecisions).set({ sourceId: `${seed.runId}:${producerStepId}:9` })
      .where(eq(operatorDecisions.id, stale.decisionId));
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId));
    const result = await ensureQaSourceDefectOwnerCard(input);
    expect(result.outcome, JSON.stringify(result)).toBe("failed");
    if (result.outcome !== "failed") throw new Error(JSON.stringify(result));
    expect(result.message).toMatch(/NFC.*before.*supersede.*write/iu);
    expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId))).toEqual(before);
  });

  // Removing the identity guard admits truncated source IDs and may cancel a stale card before failing.
  it.each([161, 162])("handles complete source identity length %i + 39 before mutations", async (length) => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const producerStepId = "p".repeat(length);
    expect(workflowStepDefinitionSchema.safeParse({ id: producerStepId, type: "agent", name: "Producer" }).success).toBe(true);
    const input = { db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId, iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null };
    expect(`${seed.runId}:${producerStepId}:0`.length).toBe(length + 39);
    const stale = await ensureQaSourceDefectOwnerCard({ ...input, producerStepId: "stale" });
    if (stale.outcome !== "created") throw new Error(JSON.stringify(stale));
    // A matching stale identity deliberately exercises the unchanged supersede query.
    await db.update(operatorDecisions).set({ sourceId: `${seed.runId}:${producerStepId}:9` })
      .where(eq(operatorDecisions.id, stale.decisionId));
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId));
    const result = await ensureQaSourceDefectOwnerCard(input);
    if (length === 161) {
      expect(result.outcome, JSON.stringify(result)).toBe("created");
      if (result.outcome !== "created") throw new Error(JSON.stringify(result));
      expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: result.decisionId });
      const rows = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId));
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === stale.decisionId)!.status).toBe("cancelled");
      const card = rows.find(row => row.id === result.decisionId)!;
      expect(card.sourceId).toBe(`${seed.runId}:${producerStepId}:0`);
      expect(card.sourceId!.length).toBe(200);
      expect(card.requestKey).toMatch(/^qa-source-defect-sha256:v2:/u);
      expect(card.requestKey.length).toBeLessThanOrEqual(160);
    } else {
      expect(result.outcome, JSON.stringify(result)).toBe("failed");
      if (result.outcome !== "failed") throw new Error(JSON.stringify(result));
      expect(result.message).toMatch(/source.*201.*200.*UTF-16/iu);
      expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId))).toEqual(before);
    }
  });

  // The old hash-token namespace makes the second valid producer conflict with the first card.
  it("creates and replays separate DB cards for a long producer and its literal digest token", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const ids = [producerIds[0]!, `sha256-${digests[0]}`];
    const steps = ids.map(id => ({ ...seed.steps[1]!, id }));
    steps.forEach(step => expect(workflowStepDefinitionSchema.safeParse(step).success).toBe(true));
    await db.update(workflowDefinitions).set({ stepsJson: [seed.steps[0]!, ...steps,
      { ...seed.steps[2]!, dependencies: ids }] }).where(eq(workflowDefinitions.companyId, seed.companyId));
    const input = { db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null };
    const decisionIds: string[] = [];
    for (const producerStepId of ids) {
      const created = await ensureQaSourceDefectOwnerCard({ ...input, producerStepId });
      expect(created.outcome, JSON.stringify(created)).toBe("created");
      if (created.outcome !== "created") throw new Error(JSON.stringify(created));
      decisionIds.push(created.decisionId);
      expect(await ensureQaSourceDefectOwnerCard({ ...input, producerStepId }))
        .toEqual({ outcome: "replayed", decisionId: created.decisionId });
    }
    const rows = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId));
    expect(rows).toHaveLength(2);
    expect(new Set(decisionIds).size).toBe(2);
    expect(new Set(rows.map(row => row.requestKey)).size).toBe(2);
    rows.forEach(row => { expect(row.status).toBe("pending"); expect(row.requestKey.length).toBeLessThanOrEqual(160); });
  });

  // Unbounded v2 keys cancel legacy cards but fail creation; producer truncation conflates distinct cards.
  it("supersedes legacy cards for two distinct valid long producers and creates/replays both in one generation", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const input = { db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null };
    const steps = producerIds.map(id => ({ ...seed.steps[1]!, id }));
    steps.forEach(step => expect(workflowStepDefinitionSchema.safeParse(step).success).toBe(true));
    await db.update(workflowDefinitions).set({ stepsJson: [seed.steps[0]!, ...steps,
      { ...seed.steps[2]!, dependencies: producerIds }] }).where(eq(workflowDefinitions.companyId, seed.companyId));
    await db.update(workflowStepRuns).set({ stepId: producerIds[0] }).where(and(
      eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    await db.insert(workflowStepRuns).values({ workflowRunId: seed.runId, companyId: seed.companyId,
      stepId: producerIds[1]!, issueId: seed.producerIssueId, status: "completed", iterationIndex: 0 });

    const currentIds: string[] = [];
    for (const producerStepId of producerIds) {
      // Start with a real valid card, then model its already-persisted legacy identity/template.
      const legacy = await ensureQaSourceDefectOwnerCard({ ...input, producerStepId: `legacy-${currentIds.length}` });
      expect(legacy.outcome).toBe("created");
      if (legacy.outcome !== "created") throw new Error(JSON.stringify(legacy));
      const legacyKey = `qa-source-defect:${seed.runId}:${producerStepId}:0`;
      expect(legacyKey.length).toBe(158);
      await db.update(operatorDecisions).set({ requestKey: legacyKey, requestHash: "legacy-template-hash",
        sourceId: `${seed.runId}:${producerStepId}:0` }).where(eq(operatorDecisions.id, legacy.decisionId));
      const current = await ensureQaSourceDefectOwnerCard({ ...input, producerStepId });
      expect(current.outcome, JSON.stringify(current)).toBe("created");
      if (current.outcome !== "created") throw new Error(JSON.stringify(current));
      currentIds.push(current.decisionId);
      const [old] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, legacy.decisionId));
      expect(old!.status).toBe("cancelled");
      expect(old!.cancelledAt).toBeInstanceOf(Date);
      expect(await ensureQaSourceDefectOwnerCard({ ...input, producerStepId }))
        .toEqual({ outcome: "replayed", decisionId: current.decisionId });
    }
    const rows = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId));
    expect(rows).toHaveLength(4);
    const pending = rows.filter(row => row.status === "pending");
    expect(pending.map(row => row.id).sort()).toEqual(currentIds.sort());
    expect(new Set(pending.map(row => row.requestKey)).size).toBe(2);
    pending.forEach(row => expect(row.requestKey.length).toBeLessThanOrEqual(160));
  });
});
