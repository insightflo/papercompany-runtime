import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import * as decisionWrites from "../services/operator-decisions-write.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Frozen outputs of the actual Git builders, not the current builder with an old key.
// c7a091cc^ = 0efbe8ee3a96bbdd0b77773dd9b326b2e255a42e; source hash is independently known.
const history = JSON.parse(readFileSync(new URL("./fixtures/qa-card-history/payloads.json", import.meta.url), "utf8")) as Array<{
  kind: string; input: { workflowRunId: string; producerStepId: string; iteration: number; maxIterations: number;
    findings: WorkflowVerdictFinding[]; qaRefs: { qaStepId: string; qaIssueId: string | null }[];
    missionId: null; linkIssueId: null }; payload: Record<string, unknown>;
}>;
const fixture = (kind: string) => history.find((item) => item.kind === kind)!;
const reason = "qa_source_defect_card_superseded_by_newer_generation";
const system = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA review regressions: ${support.reason}`);

describeDb("QA review findings: real historical replay and recoverable upgrade", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-card-review-fixes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  async function scenario(kind = "iteration0") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "QA review", issuePrefix: companyId });
    return { db, companyId, ...fixture(kind).input };
  }
  const rows = (companyId: string) => db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
  const audits = (companyId: string) => db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
  async function seed(companyId: string, kind: string, current = false) {
    const payload = fixture(kind).payload;
    return (await operatorDecisionWriteService(db).create(companyId, {
      ...payload, ...(current ? { requestKey: String(payload.requestKey).replace("qa-source-defect:", "qa-source-defect:v2:") } : {}),
    }, system)).decision;
  }

  it.each(["source", "mixed", "empty"].flatMap((kind) => ["resolved", "cancelled"].map((terminal) => ({ kind, terminal }))))(
    "replays frozen pre-#329 $kind payload in $terminal state", async ({ kind, terminal }) => {
      const input = await scenario(kind);
      const original = await seed(input.companyId, kind);
      if (kind === "source") expect((await rows(input.companyId))[0]!.requestHash).toBe("c747d2743fdca074efc7bedc29ffa54fe0f8752991ee6a4046faa3b1b6af0e1f");
      const write = operatorDecisionWriteService(db);
      if (terminal === "resolved") {
        await write.resolve(original.id, { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: null }, "human");
      } else await write.cancel(original.id, { type: "user", id: "human" }, reason);
      const before = await rows(input.companyId);
      const beforeAudit = await audits(input.companyId);
      expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: original.id });
      expect(await rows(input.companyId)).toEqual(before);
      expect(await audits(input.companyId)).toEqual(beforeAudit);
      expect(await db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, input.companyId))).toEqual([]);
  });

  it("keeps historical non-display changes conflicting without cancelling other cards", async () => {
    const input = await scenario("source");
    const original = await seed(input.companyId, "source");
    await operatorDecisionWriteService(db).cancel(original.id, { type: "user", id: "human" });
    await seed(input.companyId, "iteration1", true);
    const before = await rows(input.companyId);
    for (const change of [
      { maxIterations: 3 }, { findings: [{ id: "f", summary: "Changed", layer: "source_data" as const }] },
      { qaRefs: [{ qaStepId: "different", qaIssueId: null }] }, { missionId: randomUUID() },
    ]) {
      expect((await ensureQaSourceDefectOwnerCard({ ...input, ...change })).outcome).toBe("conflict");
      expect(await rows(input.companyId)).toEqual(before);
    }
  });

  it.each(["iteration0", "source"])("retries %s replacement after committed upgrade cancellation and failed create", async (kind) => {
    const input = await scenario(kind);
    const original = await seed(input.companyId, kind);
    const transaction = db.transaction.bind(db);
    let transactions = 0;
    const fault = vi.spyOn(db, "transaction").mockImplementation((...args) => {
      if (++transactions === 2) throw new Error("injected create failure after committed cancellation");
      return transaction(...args);
    });
    expect((await ensureQaSourceDefectOwnerCard(input)).outcome).toBe("failed");
    fault.mockRestore();
    expect((await rows(input.companyId)).map(({ status }) => status)).toEqual(["cancelled"]);
    expect(await audits(input.companyId)).toEqual(expect.arrayContaining([expect.objectContaining({
      actorType: "user", actorId: "system", action: "operator_decision.cancelled", entityId: original.id,
      details: expect.objectContaining({ schemaVersion: 1, reason, operatorDecisionId: original.id }),
    })]));
    const retry = await ensureQaSourceDefectOwnerCard(input);
    expect(retry.outcome).toBe("created");
    expect((await rows(input.companyId)).map(({ status }) => status).sort()).toEqual(["cancelled", "pending"]);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ ...retry, outcome: "replayed" });
  });

  it("a concurrent upgrader fills the committed-cancel/pre-create window", async () => {
    const input = await scenario();
    await seed(input.companyId, "iteration0");
    const transaction = db.transaction.bind(db);
    let transactions = 0;
    let reached!: () => void;
    let release!: () => void;
    const inWindow = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const faultDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return async (...args: Parameters<typeof transaction>) => {
        if (++transactions === 2) { reached(); await resume; throw new Error("first creator interrupted"); }
        return transaction(...args);
      };
      return Reflect.get(target, key, receiver);
    } });
    const first = ensureQaSourceDefectOwnerCard({ ...input, db: faultDb });
    let second: Awaited<ReturnType<typeof ensureQaSourceDefectOwnerCard>>;
    try {
      await inWindow;
      expect((await rows(input.companyId)).map(({ status }) => status)).toEqual(["cancelled"]);
      second = await ensureQaSourceDefectOwnerCard(input);
    } finally { release(); }
    const firstResult = await first;
    expect(second!.outcome).toBe("created");
    expect(firstResult).toEqual({ ...second!, outcome: "replayed" });
    expect((await rows(input.companyId)).map(({ status }) => status).sort()).toEqual(["cancelled", "pending"]);
    expect((await audits(input.companyId)).filter(({ action }) => action === "operator_decision.created")).toHaveLength(2);
  });

  it("a pending-read CAS loser recovers the concurrent upgrader window", async () => {
    const input = await scenario();
    await seed(input.companyId, "iteration0");
    let atFirstCancel!: () => void, releaseFirst!: () => void, atCreate!: () => void, releaseCreate!: () => void;
    const firstCancel = new Promise<void>((resolve) => { atFirstCancel = resolve; });
    const firstMayCancel = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const createWindow = new Promise<void>((resolve) => { atCreate = resolve; });
    const mayCreate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const factory = decisionWrites.operatorDecisionWriteService;
    let cancels = 0;
    vi.spyOn(decisionWrites, "operatorDecisionWriteService").mockImplementation((database) => {
      const writer = factory(database);
      return { ...writer, cancel: async (...args) => {
        if (++cancels === 1) { atFirstCancel(); await firstMayCancel; }
        return writer.cancel(...args);
      } };
    });
    const transaction = db.transaction.bind(db);
    let transactions = 0;
    const delayedDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return async (...args: Parameters<typeof transaction>) => {
        if (++transactions === 2) { atCreate(); await mayCreate; }
        return transaction(...args);
      };
      return Reflect.get(target, key, receiver);
    } });
    const first = ensureQaSourceDefectOwnerCard(input);
    let second: ReturnType<typeof ensureQaSourceDefectOwnerCard> | undefined;
    let firstResult: Awaited<typeof first> | undefined;
    try {
      await firstCancel;
      second = ensureQaSourceDefectOwnerCard({ ...input, db: delayedDb });
      await createWindow;
      releaseFirst();
      firstResult = await first;
    } finally { releaseFirst(); releaseCreate(); }
    const secondResult = await second;
    expect(firstResult?.outcome).toBe("created");
    expect(secondResult).toEqual({ ...firstResult, outcome: "replayed" });
    expect((await rows(input.companyId)).map(({ status }) => status).sort()).toEqual(["cancelled", "pending"]);
    expect((await audits(input.companyId)).filter(({ action }) => action === "operator_decision.cancelled")).toHaveLength(1);
  });

  it("upgrade recovery rejects changed inputs before cleaning other generations", async () => {
    const input = await scenario();
    const original = await seed(input.companyId, "iteration0");
    await operatorDecisionWriteService(db).cancel(original.id, system, reason);
    await seed(input.companyId, "iteration1", true);
    const before = await rows(input.companyId);
    const beforeAudit = await audits(input.companyId);
    expect((await ensureQaSourceDefectOwnerCard({ ...input, maxIterations: 3 })).outcome).toBe("conflict");
    expect(await rows(input.companyId)).toEqual(before);
    expect(await audits(input.companyId)).toEqual(beforeAudit);
  });

  it.each(["human", "system-other-reason", "missing-audit", "wrong-scope", "wrong-version", "wrong-detail-actor", "wrong-detail-id", "wrong-time"])("does not recover cancellation with %s provenance", async (kind) => {
    const input = await scenario();
    const original = await seed(input.companyId, "iteration0");
    await operatorDecisionWriteService(db).cancel(original.id, { type: "user", id: kind === "human" ? "human" : "system" },
      kind === "system-other-reason" ? "qa_source_defect_card_run_completed" : reason);
    const cancellation = (await audits(input.companyId)).find(({ action }) => action === "operator_decision.cancelled")!;
    if (kind === "missing-audit") await db.delete(activityLog).where(eq(activityLog.id, cancellation.id));
    if (kind === "wrong-scope") await db.update(activityLog).set({ entityId: randomUUID() }).where(eq(activityLog.id, cancellation.id));
    const overrides: Record<string, Record<string, unknown>> = {
      "wrong-version": { schemaVersion: 2 }, "wrong-detail-actor": { cancelledByActorId: "human" },
      "wrong-detail-id": { operatorDecisionId: randomUUID() }, "wrong-time": { cancelledAt: new Date(0).toISOString() },
    };
    if (overrides[kind]) await db.update(activityLog).set({ details: { ...cancellation.details, ...overrides[kind] } })
      .where(eq(activityLog.id, cancellation.id));
    const before = await rows(input.companyId);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await rows(input.companyId)).toEqual(before);
  });

  it("latest exact replay cleans stale pending generations", async () => {
    const input = await scenario("iteration1");
    const stale = await seed(input.companyId, "iteration0", true);
    const latest = await seed(input.companyId, "iteration1", true);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: latest.id });
    const after = await rows(input.companyId);
    expect(after.find(({ id }) => id === stale.id)?.status).toBe("cancelled");
    expect(after.find(({ id }) => id === latest.id)?.status).toBe("pending");
  });

  it("current hash conflict does not clean stale pending generations", async () => {
    const input = await scenario("iteration1");
    await seed(input.companyId, "iteration0", true);
    await seed(input.companyId, "iteration1", true);
    const before = await rows(input.companyId);
    const beforeAudit = await audits(input.companyId);
    expect((await ensureQaSourceDefectOwnerCard({ ...input, maxIterations: 3 })).outcome).toBe("conflict");
    expect(await rows(input.companyId)).toEqual(before);
    expect(await audits(input.companyId)).toEqual(beforeAudit);
  });
});
