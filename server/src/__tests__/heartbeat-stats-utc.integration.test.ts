import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import {
  createBoundedReadsTestDb,
  freshAgent,
  seedRun,
} from "./helpers/bounded-reads-test-utils.js";
import { statsHeartbeatRuns } from "../services/heartbeat-bounded-reads.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip UTC stats test: ${support.reason ?? "unsupported"}`);

describeEP("heartbeat stats UTC boundary (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentA: string;

  beforeAll(async () => {
    const setup = await createBoundedReadsTestDb("heartbeat-stats-utc-");
    db = setup.db;
    tempDb = setup.tempDb;
    companyId = setup.companyId;
    agentA = await freshAgent(db, companyId);
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.cleanup();
      tempDb = null;
    }
  });

  it("day keys are UTC YYYY-MM-DD and align with the 14-day window", async () => {
    // Seed a run exactly at today's UTC midnight boundary
    const todayUtcMidnight = new Date();
    todayUtcMidnight.setUTCHours(0, 0, 0, 0);

    await seedRun(db, companyId, agentA, "succeeded", todayUtcMidnight);

    const stats = await statsHeartbeatRuns(db, { companyId, days: 14 });
    expect(stats.days).toHaveLength(14);

    // The last day should be today's UTC date
    const todayKey = todayUtcMidnight.toISOString().slice(0, 10);
    const lastDay = stats.days[stats.days.length - 1]!;
    expect(lastDay.day).toBe(todayKey);
    expect(lastDay.succeeded).toBeGreaterThanOrEqual(1);

    // The first day should be 13 days ago (14-day window: 13..0)
    const oldestKey = new Date(todayUtcMidnight);
    oldestKey.setUTCDate(oldestKey.getUTCDate() - 13);
    const firstDay = stats.days[0]!;
    expect(firstDay.day).toBe(oldestKey.toISOString().slice(0, 10));
  });

  it("does not include data older than the 14-day UTC window", async () => {
    const company = await (await import("./helpers/bounded-reads-test-utils.js")).freshCompany(db);
    const agent = await freshAgent(db, company);

    // Seed a run 15 days ago at UTC midnight — should be excluded
    const old = new Date();
    old.setUTCHours(0, 0, 0, 0);
    old.setUTCDate(old.getUTCDate() - 15);
    await seedRun(db, company, agent, "failed", old);

    const stats = await statsHeartbeatRuns(db, { companyId: company, days: 14 });
    // No day in the 14-day window should have this run
    const totalAcrossDays = stats.days.reduce((sum, d) => sum + d.total, 0);
    expect(totalAcrossDays).toBe(0);
    expect(stats.total).toBe(0);
  });
});
