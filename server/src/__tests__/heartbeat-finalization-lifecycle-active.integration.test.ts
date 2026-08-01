import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { lifecycleActiveClause } from "../services/heartbeat-finalization/lifecycle-active.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip lifecycle-active tests: ${support.reason ?? "unsupported"}`);

async function activeCount(db: ReturnType<typeof createDb>, agentId: string): Promise<number> {
  const clause = await lifecycleActiveClause(db);
  const [{ n }] = await db
    .select({ n: count() })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), clause));
  return Number(n ?? 0);
}

describeEP("heartbeat finalization lifecycle-active clause (flag-gated)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lifecycle-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "LifeCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Life agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // running; succeeded-unsettled-v1; succeeded-settled-v1; succeeded-unsettled-legacy(v0)
    await db.insert(heartbeatRuns).values([
      { id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "running" },
      { id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "succeeded", finalizationVersion: 1, settledAt: null },
      { id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "succeeded", finalizationVersion: 1, settledAt: new Date() },
      { id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "succeeded", finalizationVersion: 0, settledAt: null },
    ] as never);
  });
  afterAll(() => { tempDb = null; });

  async function setFlag(on: boolean): Promise<void> {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: on } } as never);
  }

  it("flag OFF: counts only status='running' (legacy exact)", async () => {
    await setFlag(false);
    expect(await activeCount(db, agentId)).toBe(1);
  });

  it("flag ON: counts running + terminal-but-unsettled v1 (settled_at null), excluding settled and legacy", async () => {
    await setFlag(true);
    // running(1) + succeeded-unsettled-v1(1) = 2; settled-v1 and legacy-v0 excluded
    expect(await activeCount(db, agentId)).toBe(2);
  });
});
