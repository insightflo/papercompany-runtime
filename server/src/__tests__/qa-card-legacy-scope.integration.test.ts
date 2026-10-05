import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Frozen actual c7a091cc builder outputs; only the colliding source field changes.
const history = JSON.parse(readFileSync(new URL("./fixtures/qa-card-history/payloads.json", import.meta.url), "utf8")) as Array<{
  kind: string;
  input: Omit<Parameters<typeof ensureQaSourceDefectOwnerCard>[0], "db" | "companyId">;
  payload: Record<string, unknown>;
}>;
const original = history.find(({ kind }) => kind === "iteration0")!;
const next = history.find(({ kind }) => kind === "iteration1")!;
const system = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA legacy scope regressions: ${support.reason}`);

describeDb("QA legacy key collision source scope", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-card-legacy-scope-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "QA legacy scope", issuePrefix: id });
    return id;
  }
  async function snapshot(companyId: string) {
    return {
      decisions: await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId)).orderBy(operatorDecisions.id),
      audits: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id),
      continuations: await db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, companyId)).orderBy(operatorDecisionContinuations.id),
    };
  }

  it.each([
    { name: "different source kind", override: { sourceType: "unrelated_review" } },
    { name: "different run/producer identity", override: { sourceId: "another-run:another-producer:0" } },
    { name: "same run/producer but different iteration", override: { sourceId: "11111111-1111-4111-8111-111111111111:produce:1" } },
  ])("rejects $name without any DB mutation", async ({ override }) => {
    const companyId = await company();
    const writer = operatorDecisionWriteService(db);
    await writer.create(companyId, { ...original.payload, ...override }, system);
    // Even an otherwise eligible stale card must survive this conflict unchanged.
    await writer.create(companyId, next.payload, system);
    const before = await snapshot(companyId);
    expect(before.decisions).toHaveLength(2);
    expect(before.decisions.every(({ status }) => status === "pending")).toBe(true);
    const result = await ensureQaSourceDefectOwnerCard({ db, companyId, ...original.input });
    expect.soft(result.outcome).toBe("conflict");
    expect(await snapshot(companyId)).toEqual(before);
  });

  it("leaves a foreign-company same-key card untouched while creating the requested card", async () => {
    const foreignCompanyId = await company();
    const companyId = await company();
    await operatorDecisionWriteService(db).create(foreignCompanyId, original.payload, system);
    const before = await snapshot(foreignCompanyId);
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId, ...original.input })).outcome).toBe("created");
    expect(await snapshot(foreignCompanyId)).toEqual(before);
    expect((await snapshot(companyId)).decisions).toHaveLength(1);
  });

  it.each([false, true])("preserves same-generation migration with unknown template=%s", async (unknownTemplate) => {
    const companyId = await company();
    const seeded = await operatorDecisionWriteService(db).create(companyId, {
      ...original.payload, ...(unknownTemplate ? { title: "Unknown legacy display template" } : {}),
    }, system);
    const input = { db, companyId, ...original.input };
    const result = await ensureQaSourceDefectOwnerCard(input);
    expect(result.outcome).toBe("created");
    const after = await snapshot(companyId);
    expect(after.decisions).toHaveLength(2);
    expect(after.decisions.find(({ id }) => id === seeded.decision.id)?.status).toBe("cancelled");
    expect(after.decisions.filter(({ status }) => status === "pending")).toHaveLength(1);
    expect(after.audits.filter(({ action }) => action === "operator_decision.cancelled")).toHaveLength(1);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ ...result, outcome: "replayed" });
    expect(await snapshot(companyId)).toEqual(after);
  });
});
