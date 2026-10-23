import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, missions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { promoteStrandedDeferredWakes } from "../services/deferred-wake-promotion.js";

// [성긴 deferred 깨움 승격 2026-10-23] 이슈를 아무도 붙잡지 않는 오래된 deferred 깨움만 queued 로
//   승격한다 — 실행/체크아웃 중이거나 대상 에이전트가 실행 중이면 계약대로 남긴다.

const describeEP = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("deferred-wake-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await temp?.cleanup(); });

const OLD = new Date(Date.now() - 30 * 60 * 1000);
const FRESH = new Date(Date.now() - 60 * 1000);

async function world() {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "W", issuePrefix: randomUUID().slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "M" });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "I", assigneeAgentId: agentId });
  return { companyId, agentId, missionId, issueId };
}

async function deferredWake(w: Awaited<ReturnType<typeof world>>, requestedAt: Date) {
  const id = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id, companyId: w.companyId, agentId: w.agentId, source: "automation", reason: "operator_decision_resolved",
    requestKind: "assignment", status: "deferred_issue_execution", requestedAt, updatedAt: requestedAt,
    payload: { kind: "operator_decision_resolution", issueId: w.issueId },
  });
  return id;
}

describeEP("promoteStrandedDeferredWakes", () => {
  it("promotes an old deferred wake when nothing holds the issue", async () => {
    const w = await world();
    const id = await deferredWake(w, OLD);
    expect(await promoteStrandedDeferredWakes(db)).toBeGreaterThanOrEqual(1);
    const [row] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    expect(row?.status).toBe("queued");
  });

  it("keeps the wake deferred while the issue is held by an execution or checkout run", async () => {
    const w = await world();
    const id = await deferredWake(w, OLD);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: w.companyId, agentId: w.agentId, issueId: w.issueId, status: "succeeded" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, w.issueId));
    await promoteStrandedDeferredWakes(db);
    let [row] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    expect(row?.status).toBe("deferred_issue_execution");
    await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, w.issueId));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    await promoteStrandedDeferredWakes(db);
    [row] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    expect(row?.status).toBe("deferred_issue_execution");
  });

  it("keeps fresh deferred wakes untouched", async () => {
    const w = await world();
    const id = await deferredWake(w, FRESH);
    await promoteStrandedDeferredWakes(db);
    const [row] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    expect(row?.status).toBe("deferred_issue_execution");
  });
});
