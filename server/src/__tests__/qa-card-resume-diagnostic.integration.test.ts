import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import * as decisionWrites from "../services/operator-decisions-write.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import * as systemLanguage from "../services/missions/system-language.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip resume regression: ${support.reason ?? "unsupported"}`);

describeDb("QA card same-generation replay safety", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-card-resume-diagnostic-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function scenario() {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    return {
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: seed.oversightIssueId,
    };
  }
  const cards = (companyId: string) => db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
  const continuations = (companyId: string) => db.select().from(operatorDecisionContinuations)
    .where(eq(operatorDecisionContinuations.companyId, companyId));
  async function create(input: Parameters<typeof ensureQaSourceDefectOwnerCard>[0]) {
    const result = await ensureQaSourceDefectOwnerCard(input);
    expect(result.outcome, JSON.stringify(result)).toBe("created");
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, result.decisionId));
    return row!;
  }
  async function legacy(input: Parameters<typeof ensureQaSourceDefectOwnerCard>[0]) {
    const first = await create(input);
    // Ordinary c7a091cc pre-v2 payload (not the older pre-#329 contract, whose
    // frozen Git-produced payload regressions live in qa-card-review-fixes).
    const { input: oldInput, requestHash } = validateAndHashOperatorDecisionCreate({
      schemaVersion: first.schemaVersion, requestKey: `qa-source-defect:${input.workflowRunId}:produce:0`,
      priority: first.priority, interactionType: first.interactionType, title: first.title,
      description: first.description, sourceType: first.sourceType, sourceId: first.sourceId,
      sourceContext: first.sourceContext, definition: first.definition, issueId: first.issueId,
      continuationMode: first.continuationMode,
    });
    await db.update(operatorDecisions).set({ requestKey: oldInput.requestKey, requestHash })
      .where(eq(operatorDecisions.id, first.id));
    return first.id;
  }

  // Stop both requests after their absent-row reads; retain real writer/DB outcomes.
  function synchronizeFirstCreates() {
    const factory = decisionWrites.operatorDecisionWriteService;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    vi.spyOn(decisionWrites, "operatorDecisionWriteService").mockImplementation((database) => {
      const writer = factory(database);
      return { ...writer, create: async (...args) => {
        if (++count === 2) release();
        await ready;
        return writer.create(...args);
      } };
    });
  }

  it.each(["resolved", "cancelled"] as const)(
    "reuses a same-generation legacy %s decision without new cards or continuations", async (terminal) => {
      const input = await scenario();
      const id = await legacy(input);
      const write = operatorDecisionWriteService(db);
      if (terminal === "resolved") {
        await write.resolve(id, { actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: null }, "test-user");
      } else {
        await write.cancel(id, { type: "user", id: "test-user" }, "terminal fixture");
      }
      const before = await cards(input.companyId);
      const beforeContinuations = await continuations(input.companyId);
      expect(before[0]!.status).toBe(terminal);
      expect(beforeContinuations).toHaveLength(terminal === "resolved" ? 1 : 0);
      expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: id });
      expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: id });
      expect(await cards(input.companyId)).toEqual(before);
      expect(await continuations(input.companyId)).toEqual(beforeContinuations);
    },
  );

  it("replays the original English card when Korean lookup recovers", async () => {
    const input = await scenario();
    await db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, input.companyId));
    const language = vi.spyOn(systemLanguage, "loadCompanySystemLanguage")
      .mockRejectedValueOnce(new Error("language lookup unavailable"));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const english = await create(input);
    expect(english.definition.options[0]!.label).toBe("Run data collection again");
    language.mockRestore();
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: english.id });
    expect(await cards(input.companyId)).toEqual([english]);
  });

  it("keeps the original Korean card through lookup failure and recovery", async () => {
    const input = await scenario();
    await db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, input.companyId));
    const korean = await create(input);
    expect(korean.definition.options[0]!.label).toBe("자료 수집 다시 실행");
    const language = vi.spyOn(systemLanguage, "loadCompanySystemLanguage")
      .mockRejectedValueOnce(new Error("language lookup unavailable"));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: korean.id });
    language.mockRestore();
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: korean.id });
    expect(await cards(input.companyId)).toEqual([korean]);
  });

  it("replays a valid Korean card even when its English variant exceeds the shared display limit", async () => {
    const input = await scenario();
    input.qaRefs[0]!.qaStepId = "q".repeat(104);
    await db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, input.companyId));
    const korean = await create(input);
    vi.spyOn(systemLanguage, "loadCompanySystemLanguage").mockRejectedValueOnce(new Error("lookup unavailable"));
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: korean.id });
    expect(await cards(input.companyId)).toEqual([korean]);
  });

  it.each(["current", "legacy"] as const)("%s non-display drift still conflicts after language changes", async (kind) => {
    const input = await scenario();
    const id = kind === "legacy" ? await legacy(input) : (await create(input)).id;
    if (kind === "legacy") await operatorDecisionWriteService(db).cancel(id, { type: "user", id: "test-user" });
    const before = await cards(input.companyId);
    await db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, input.companyId));
    const changes = [
      { maxIterations: 3 },
      { findings: [{ ...FINDINGS_SOURCE_ONLY[0]!, layer: "artifact" as const }] },
      { findings: [{ ...FINDINGS_SOURCE_ONLY[0]!, summary: "different official finding" }] },
      { qaRefs: [{ qaStepId: "different-qa", qaIssueId: input.qaRefs[0]!.qaIssueId }] },
      { qaRefs: [{ qaStepId: "qa-validate", qaIssueId: null }] },
      { missionId: null },
      { linkIssueId: null },
    ];
    for (const change of changes) {
      expect((await ensureQaSourceDefectOwnerCard({ ...input, ...change })).outcome, JSON.stringify(change)).toBe("conflict");
      expect(await cards(input.companyId)).toEqual(before);
    }
  });

  it("does not treat an unknown stored hash as replay authority", async () => {
    const input = await scenario();
    const id = await legacy(input);
    await operatorDecisionWriteService(db).cancel(id, { type: "user", id: "test-user" });
    await db.update(operatorDecisions).set({ requestHash: "unrecognized-hash" }).where(eq(operatorDecisions.id, id));
    const before = await cards(input.companyId);
    expect((await ensureQaSourceDefectOwnerCard(input)).outcome).toBe("conflict");
    expect(await cards(input.companyId)).toEqual(before);
  });

  it("allows the next generation after a terminal legacy decision", async () => {
    const input = await scenario();
    const id = await legacy(input);
    await operatorDecisionWriteService(db).cancel(id, { type: "user", id: "test-user" });
    const next = await create({ ...input, iteration: 1 });
    expect(next.sourceId).toBe(`${input.workflowRunId}:produce:1`);
    expect((await cards(input.companyId)).map(({ status }) => status).sort()).toEqual(["cancelled", "pending"]);
  });

  it.each(["resolved", "cancelled"] as const)("waits for an in-flight legacy %s before deciding whether to upgrade", async (terminal) => {
    const input = await scenario();
    const id = await legacy(input);
    let pending: ReturnType<typeof ensureQaSourceDefectOwnerCard> | undefined;
    let result: Awaited<ReturnType<typeof ensureQaSourceDefectOwnerCard>> | undefined;
    try {
      await db.transaction(async (tx) => {
        const writer = operatorDecisionWriteService(tx as unknown as typeof db);
        if (terminal === "resolved") {
          await writer.resolve(id, { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: null }, "test-user");
        } else {
          await writer.cancel(id, { type: "user", id: "test-user" });
        }
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pending = ensureQaSourceDefectOwnerCard(input);
        // Prove actual DB overlap, not just Promise.all or a timing-based sleep.
        await expect.poll(async () => {
          const [row] = await db.$client<{ count: number }[]>`select count(*)::int as count
            from pg_stat_activity where ${pid!} = any(pg_blocking_pids(pid))`;
          return row!.count;
        }, { timeout: 5_000 }).toBeGreaterThan(0);
      });
    } finally {
      result = await pending;
    }
    expect(result).toEqual({ outcome: "replayed", decisionId: id });
    const rows = await cards(input.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(terminal);
    expect(await continuations(input.companyId)).toHaveLength(terminal === "resolved" ? 1 : 0);
  });

  it.each(["resolved", "cancelled"] as const)("preserves legacy %s committed between helper and shared-cancel reads", async (terminal) => {
    const input = await scenario();
    const id = await legacy(input);
    const factory = decisionWrites.operatorDecisionWriteService;
    vi.spyOn(decisionWrites, "operatorDecisionWriteService").mockImplementation((database) => {
      const writer = factory(database);
      return { ...writer, cancel: async (...args) => {
        if (terminal === "resolved") {
          await writer.resolve(id, { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: null }, "test-user");
        } else {
          await writer.cancel(id, { type: "user", id: "test-user" });
        }
        return writer.cancel(...args);
      } };
    });
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: id });
    const rows = await cards(input.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(terminal);
    expect(await continuations(input.companyId)).toHaveLength(terminal === "resolved" ? 1 : 0);
  });

  it("publishes creation only after the card is visible to another database connection", async () => {
    const input = await scenario();
    let readOnNotification: Promise<Awaited<ReturnType<typeof cards>>> | undefined;
    const unsubscribe = subscribeCompanyLiveEvents(input.companyId, (event) => {
      if (event.type === "operator_decision.created") readOnNotification = cards(input.companyId).then((rows) => rows);
    });
    const transaction = db.transaction.bind(db);
    // Delay only commit until any already-emitted event's independent read ends.
    // Without an outer transaction the shared writer commits before publishing.
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async (tx) => {
      const result = await callback(tx);
      if (readOnNotification) await readOnNotification;
      return result;
    }, config));
    try {
      const row = await create(input);
      expect(readOnNotification).toBeDefined();
      expect((await readOnNotification)!.map(({ id }) => id)).toEqual([row.id]);
    } finally {
      unsubscribe();
    }
  });

  it("concurrent different inputs retain the request-key conflict", async () => {
    const input = await scenario();
    synchronizeFirstCreates();
    const results = await Promise.all([
      ensureQaSourceDefectOwnerCard(input), ensureQaSourceDefectOwnerCard({ ...input, maxIterations: 3 }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["conflict", "created"]);
    expect(await cards(input.companyId)).toHaveLength(1);
  });

  it("concurrent first requests with different display languages converge to one unchanged card", async () => {
    const input = await scenario();
    synchronizeFirstCreates();
    let release!: () => void;
    const bothLookups = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    vi.spyOn(systemLanguage, "loadCompanySystemLanguage").mockImplementation(async () => {
      const language = ++count === 1 ? "en" : "ko";
      if (count === 2) release();
      await bothLookups;
      return language;
    });
    const results = await Promise.all([ensureQaSourceDefectOwnerCard(input), ensureQaSourceDefectOwnerCard(input)]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["created", "replayed"]);
    const rows = await cards(input.companyId);
    expect(rows).toHaveLength(1);
    for (const result of results) expect(result).toMatchObject({ decisionId: rows[0]!.id });
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    expect(audit.filter(({ action }) => action === "operator_decision.created")).toHaveLength(1);
    expect(await continuations(input.companyId)).toEqual([]);
  });
});
