import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping provider-model-outcomes integration tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeDb("costService.providerModelOutcomes", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let costs: ReturnType<typeof costService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-outcomes-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `PO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${name} Agent`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "test",
      status: input.status,
      contextSnapshot: {},
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
    return runId;
  }

  async function seedCostEvent(input: {
    companyId: string;
    agentId: string;
    runId: string;
    provider: string;
    model: string;
    costCents: number;
    occurredAt: Date;
  }): Promise<void> {
    await db.insert(costEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      heartbeatRunId: input.runId,
      provider: input.provider,
      biller: input.provider,
      billingType: "metered_api",
      model: input.model,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costCents: input.costCents,
      occurredAt: input.occurredAt,
    });
  }

  it("aggregates outcomes, latency percentiles, and cost per (provider, model)", async () => {
    const { companyId, agentId } = await seedCompany("Outcomes Co");
    const now = new Date();

    // provider-a/model-x: 2 succeeded + 1 failed run; one run has two events.
    const okRun1 = await seedRun({ companyId, agentId, status: "succeeded", startedAt: new Date(now.getTime() - 10 * 60_000), finishedAt: new Date(now.getTime() - 9 * 60_000) });
    const okRun2 = await seedRun({ companyId, agentId, status: "succeeded", startedAt: new Date(now.getTime() - 10 * 60_000), finishedAt: new Date(now.getTime() - 2 * 60_000) });
    const failRun = await seedRun({ companyId, agentId, status: "failed", startedAt: new Date(now.getTime() - 10 * 60_000), finishedAt: new Date(now.getTime() - 9.5 * 60_000) });
    await seedCostEvent({ companyId, agentId, runId: okRun1, provider: "provider-a", model: "model-x", costCents: 30, occurredAt: now });
    await seedCostEvent({ companyId, agentId, runId: okRun1, provider: "provider-a", model: "model-x", costCents: 20, occurredAt: now }); // second event on the same run must not double-count the run
    await seedCostEvent({ companyId, agentId, runId: okRun2, provider: "provider-a", model: "model-x", costCents: 100, occurredAt: now });
    await seedCostEvent({ companyId, agentId, runId: failRun, provider: "provider-a", model: "model-x", costCents: 50, occurredAt: now });

    // provider-b/model-y: 1 timed-out run, no successes.
    const timeoutRun = await seedRun({ companyId, agentId, status: "timed_out", startedAt: new Date(now.getTime() - 30 * 60_000), finishedAt: new Date(now.getTime()) });
    await seedCostEvent({ companyId, agentId, runId: timeoutRun, provider: "provider-b", model: "model-y", costCents: 10, occurredAt: now });

    // runs without cost events must not appear.
    await seedRun({ companyId, agentId, status: "succeeded", startedAt: now, finishedAt: now });

    const rows = await costs.providerModelOutcomes(companyId);

    expect(rows).toHaveLength(2);
    const rowA = rows.find((row) => row.provider === "provider-a" && row.model === "model-x");
    const rowB = rows.find((row) => row.provider === "provider-b" && row.model === "model-y");
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    expect(rowA).toMatchObject({
      runs: 3,
      succeededRuns: 2,
      failedRuns: 1,
      timedOutRuns: 0,
      cancelledRuns: 0,
      otherRuns: 0,
      costCents: 200,
    });
    expect(rowA!.successRate).toBeCloseTo(2 / 3, 3);
    // durations: 60s, 480s, 30s → median 60s; p95 interpolates between 60 and 480 → 438s
    expect(rowA!.medianDurationSec).toBe(60);
    expect(rowA!.p95DurationSec).toBe(438);
    // 200 cents total / 2 succeeded runs
    expect(rowA!.costPerSucceededRunCents).toBe(100);
    expect(typeof rowA!.lastOccurredAt).toBe("string");

    expect(rowB).toMatchObject({
      runs: 1,
      succeededRuns: 0,
      timedOutRuns: 1,
      successRate: 0,
      costCents: 10,
      costPerSucceededRunCents: 0,
    });
    expect(rowB!.medianDurationSec).toBe(1800);
  });

  it("scopes to the company and honors the date range", async () => {
    const { companyId, agentId } = await seedCompany("Scoped Co");
    const other = await seedCompany("Other Co");
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 24 * 60 * 60_000);

    const run = await seedRun({ companyId, agentId, status: "succeeded", startedAt: now, finishedAt: now });
    const otherRun = await seedRun({ companyId: other.companyId, agentId: other.agentId, status: "succeeded", startedAt: now, finishedAt: now });
    const oldRun = await seedRun({ companyId, agentId, status: "succeeded", startedAt: old, finishedAt: old });

    await seedCostEvent({ companyId, agentId, runId: run, provider: "p", model: "m", costCents: 1, occurredAt: now });
    await seedCostEvent({ companyId: other.companyId, agentId: other.agentId, runId: otherRun, provider: "p", model: "m", costCents: 1, occurredAt: now });
    await seedCostEvent({ companyId, agentId, runId: oldRun, provider: "p", model: "m-old", costCents: 1, occurredAt: old });

    const allRows = await costs.providerModelOutcomes(companyId);
    expect(allRows.map((row) => row.model).sort()).toEqual(["m", "m-old"]);

    const recentRows = await costs.providerModelOutcomes(companyId, {
      from: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
    });
    expect(recentRows.map((row) => row.model)).toEqual(["m"]);

    const otherRows = await costs.providerModelOutcomes(other.companyId);
    expect(otherRows.map((row) => row.model)).toEqual(["m"]);
  });

  it("keeps a multi-provider run as one row per provider slice", async () => {
    const { companyId, agentId } = await seedCompany("Fallback Co");
    const now = new Date();
    const run = await seedRun({ companyId, agentId, status: "succeeded", startedAt: new Date(now.getTime() - 60_000), finishedAt: now });
    await seedCostEvent({ companyId, agentId, runId: run, provider: "primary", model: "m1", costCents: 5, occurredAt: now });
    await seedCostEvent({ companyId, agentId, runId: run, provider: "fallback", model: "m2", costCents: 7, occurredAt: now });

    const rows = await costs.providerModelOutcomes(companyId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.runs).toBe(1);
      expect(row.succeededRuns).toBe(1);
      expect(row.successRate).toBe(1);
    }
    expect(rows.find((row) => row.provider === "primary")?.costCents).toBe(5);
    expect(rows.find((row) => row.provider === "fallback")?.costCents).toBe(7);
  });
});
