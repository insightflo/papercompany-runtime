// P4 통합 test: heartbeatService.resumeQueuedRuns 가 queued oversight wakeup promote 시
// QA live ownerAction → request completed + queue_oversight_noop event + heartbeat run 0,
// non-QA ownerAction → heartbeat run 생성(즉시 assert, executeRun completion 대기 ❌). codex P4 재검토.
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip oversight promote integration: ${sup.reason ?? "unsupported"}`);

// originIsQaGate: true 면 unblock origin=QA gate(QA chain), false 면 origin=producer(non-QA, 정상 promote).
async function seed(db: ReturnType<typeof createDb>, originIsQaGate: boolean) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const wdId = randomUUID();
  const runId = randomUUID();
  const producerIssueId = randomUUID();
  const qaGateIssueId = randomUUID();
  const unblockIssueId = randomUUID();
  const originId = originIsQaGate ? qaGateIssueId : producerIssueId;
  const suffix = companyId.slice(0, 8);

  await db.insert(companies).values({ id: companyId, name: "PI Co", issuePrefix: `PI${suffix.toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "PI mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: wdId, companyId, name: "p+qa",
    stepsJson: [
      { id: "produce", name: "Produce", dependencies: [], type: "tool" },
      { id: "qa", name: "QA", dependencies: ["produce"], type: "qa" },
    ],
  });
  await db.insert(workflowRuns).values({ id: runId, workflowId: wdId, companyId, missionId, status: "running", triggeredBy: "system" });
  await db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, identifier: `PIP${suffix}`, title: "Producer", status: originIsQaGate ? "done" : "todo", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: qaGateIssueId, companyId, missionId, identifier: `PIQ${suffix}`, title: "QA gate", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: unblockIssueId, companyId, missionId, identifier: `PIU${suffix}`, title: "[Unblock]", status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: randomUUID(), workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-07-12T08:00:00.000Z") },
    { id: randomUUID(), workflowRunId: runId, stepId: "qa", issueId: qaGateIssueId, status: "pending", startedAt: new Date("2026-07-12T08:10:00.000Z") },
  ]);
  await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId, source: "test", reason: "mission_validation_request_changes", status: "claimed", claimedAt: new Date(), issueId: qaGateIssueId, missionId, payload: { issueId: qaGateIssueId } });
  // oversight retry wakeup(queued, runId null) — promote 대상.
  const oversightWakeupId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: oversightWakeupId, companyId, agentId, source: "oversight", reason: "mission_owner_retry_source_issue",
    status: "queued", issueId: originId, missionId, payload: { ownerActionIssueId: unblockIssueId, issueId: originId, sourceIssueId: originId },
  });
  return { companyId, agentId, missionId, oversightWakeupId, originId };
}

describeEP("P4 oversight wakeup promote integration", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oversight-promote-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("QA-gate ownerAction + live recovery → request completed + noop event + heartbeat run 0", async () => {
    const seed_ = await seed(db, true);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns(seed_.agentId);

    const wakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seed_.oversightWakeupId)).then((r) => r[0]);
    const noopEvent = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.wakeupRequestId, seed_.oversightWakeupId)).then((r) => r[0]);
    const runCount = await db.select({ c: count() }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, seed_.companyId), eq(heartbeatRuns.agentId, seed_.agentId))).then((r) => r[0]?.c ?? 0);

    expect(wakeup?.status).toBe("completed");
    expect(noopEvent?.eventType).toBe("queue_oversight_noop");
    expect(Number(runCount)).toBe(0);
  });

  it("non-QA origin ownerAction → heartbeat run created (regular promote)", async () => {
    const seed_ = await seed(db, false);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns(seed_.agentId);

    const wakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seed_.oversightWakeupId)).then((r) => r[0]);
    const runCount = await db.select({ c: count() }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, seed_.companyId), eq(heartbeatRuns.agentId, seed_.agentId))).then((r) => r[0]?.c ?? 0);

    // promote 진행(consumed 또는 claimed). heartbeat run 1 생성(executeRun completion 대기 ❌).
    expect(wakeup?.status).not.toBe("queued");
    expect(Number(runCount)).toBeGreaterThanOrEqual(1);
  });
});
