import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { requeueCoalescedWakeupsForFinishedRun } from "../services/heartbeat.js";

// [CMP-199] 활성 런에 coalesce 된 operator-decision-wake 깨움이 런 종료 후 유실되지 않고
// queued 로 재전달되는 계약: 접두사 키만 재큐, 다른 키는 건드리지 않음, 반복 sweep 은 멱등.
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coalesced wakeup requeue for finished run", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let finishedRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wakeup-coalesced-requeue-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Requeue Co", issuePrefix: `Q${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Target Agent" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Wake work", status: "in_progress", assigneeAgentId: agentId });
    finishedRunId = randomUUID();
  });

  async function seedCoalescedRow(input: { idempotencyKey: string; runId?: string }) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId,
      agentId,
      source: "operator",
      reason: "operator_decision_continuation",
      payload: { issueId },
      status: "coalesced",
      coalescedCount: 1,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId ?? finishedRunId,
      finishedAt: new Date(),
    });
    return id;
  }

  async function fetchWakeupRow(id: string) {
    const [row] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.id, id),
    ));
    return row;
  }

  it("requeues an operator-decision-wake coalesced row bound to the finished run", async () => {
    const wakeupId = await seedCoalescedRow({ idempotencyKey: `operator-decision-wake:${randomUUID()}:g1:a1` });

    const requeued = await requeueCoalescedWakeupsForFinishedRun(db, { companyId, runId: finishedRunId });

    expect(requeued).toBe(1);
    const row = await fetchWakeupRow(wakeupId);
    expect(row?.status).toBe("queued");
    expect(row?.runId).toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.coalescedCount).toBe(2);
    const logs = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "agent_wakeup.coalesced_requeued"),
    ));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityType).toBe("issue");
    expect(logs[0]?.entityId).toBe(issueId);
    expect(logs[0]?.actorType).toBe("system");
    expect(logs[0]?.actorId).toBe("heartbeat");
    expect(logs[0]?.details).toMatchObject({ wakeupRequestId: wakeupId, runId: finishedRunId });
  });

  it("leaves coalesced rows with other idempotency keys untouched", async () => {
    const otherId = await seedCoalescedRow({ idempotencyKey: `mission-wake:${randomUUID()}` });
    await seedCoalescedRow({ idempotencyKey: `operator-decision-wake:${randomUUID()}:g1:a1` });

    const requeued = await requeueCoalescedWakeupsForFinishedRun(db, { companyId, runId: finishedRunId });

    expect(requeued).toBe(1);
    const otherRow = await fetchWakeupRow(otherId);
    expect(otherRow?.status).toBe("coalesced");
    expect(otherRow?.runId).toBe(finishedRunId);
  });

  it("is idempotent: a second sweep requeues nothing", async () => {
    await seedCoalescedRow({ idempotencyKey: `operator-decision-wake:${randomUUID()}:g1:a1` });
    await requeueCoalescedWakeupsForFinishedRun(db, { companyId, runId: finishedRunId });

    const second = await requeueCoalescedWakeupsForFinishedRun(db, { companyId, runId: finishedRunId });

    expect(second).toBe(0);
    const logs = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "agent_wakeup.coalesced_requeued"),
    ));
    expect(logs).toHaveLength(1);
  });

  it("scopes by run: coalesced rows on another run are not requeued", async () => {
    const otherRunId = randomUUID();
    await seedCoalescedRow({ idempotencyKey: `operator-decision-wake:${randomUUID()}:g1:a1`, runId: otherRunId });

    const requeued = await requeueCoalescedWakeupsForFinishedRun(db, { companyId, runId: finishedRunId });

    expect(requeued).toBe(0);
  });
});
