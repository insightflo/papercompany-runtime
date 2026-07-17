import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hasLiveWakeCoverage } from "../services/missions/qa-rework-cap-oversight-wake.js";
import {
  cleanQaCapFixture,
  seedQaCapBase,
  type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap wake: ${support.reason ?? "unsupported"}`);

/** Create a coalesced wakeup request linked to a heartbeat run with the given run status. */
async function seedCoalescedWake(
  db: QaCapTestDb, base: { companyId: string; agentId: string; missionId: string },
  runStatus: string,
): Promise<string> {
  const [issueRow] = await db.insert(issues).values({
    companyId: base.companyId, missionId: base.missionId,
    title: "Wake test issue", status: "in_progress", assigneeAgentId: base.agentId,
  }).returning();
  const issueId = issueRow.id;
  // 1. Create wakeup request (initially queued, no runId).
  const [wake] = await db.insert(agentWakeupRequests).values({
    companyId: base.companyId, agentId: base.agentId,
    source: "assignment", status: "queued", reason: "test",
    issueId, missionId: base.missionId,
  }).returning();
  // 2. Create heartbeat run linked to wakeup.
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: base.companyId, agentId: base.agentId,
    issueId, status: runStatus, wakeupRequestId: wake.id,
  }).returning();
  // 3. Mark wakeup as coalesced with linked runId (mirrors heartbeat.ts enqueueWakeup).
  await db.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id })
    .where(eq(agentWakeupRequests.id, wake.id));
  return issueId;
}

describeEP("QA cap oversight wake liveness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("queued request status is live", async () => {
    const base = await seedQaCapBase(db);
    const issueId = crypto.randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: base.companyId, agentId: base.agentId,
      source: "assignment", status: "queued", reason: "test",
      issueId, missionId: base.missionId,
    });
    expect(await hasLiveWakeCoverage(db, base.companyId, issueId)).toBe(true);
  });

  it("coalesced request with linked run queued/running is live", async () => {
    const base = await seedQaCapBase(db);
    const issueId = await seedCoalescedWake(db, base, "running");
    expect(await hasLiveWakeCoverage(db, base.companyId, issueId)).toBe(true);
  });

  it("coalesced request with terminal linked run is NOT live (must re-wake)", async () => {
    const base = await seedQaCapBase(db);
    const issueId = await seedCoalescedWake(db, base, "succeeded");
    expect(await hasLiveWakeCoverage(db, base.companyId, issueId)).toBe(false);
  });
});
