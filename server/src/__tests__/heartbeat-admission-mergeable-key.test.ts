import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mergeableWakeupKeyCondition } from "../services/quality/heartbeat-admission.js";

const describeEP = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let companyId: string;
let agentId: string;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-mergeable-key-");
  db = createDb(temp.connectionString);
  companyId = randomUUID();
  agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Merge contract", issuePrefix: randomUUID().slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Target" });
}, 60_000);
afterAll(async () => { await temp?.cleanup(); });

async function insertWake(idempotencyKey: string) {
  const id = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id,
    companyId,
    agentId,
    source: "automation",
    status: "deferred_issue_execution",
    idempotencyKey,
  });
  return id;
}

async function matches(id: string, incomingKey: string | null) {
  return db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, id),
    mergeableWakeupKeyCondition(incomingKey),
  )).then((rows) => rows.length === 1);
}

describeEP("mergeableWakeupKeyCondition", () => {
  it("matches only the exact operator-decision attempt key", async () => {
    const decisionA = randomUUID();
    const decisionB = randomUUID();
    const stored = `operator-decision-wake:${decisionA}:g1:a1`;
    const id = await insertWake(stored);

    expect(await matches(id, stored)).toBe(true);
    expect(await matches(id, `operator-decision-wake:${decisionA}:g1:a2`)).toBe(false);
    expect(await matches(id, `operator-decision-wake:${decisionB}:g1:a1`)).toBe(false);
    expect(await matches(id, null)).toBe(false);
  });

  it("keeps the same exact-only rule for qa-remediation refires", async () => {
    const stored = `qa-remediation-refire:${randomUUID()}:g1:a1`;
    const id = await insertWake(stored);
    expect(await matches(id, stored)).toBe(true);
    expect(await matches(id, `${stored}-other`)).toBe(false);
    expect(await matches(id, null)).toBe(false);
  });
});
