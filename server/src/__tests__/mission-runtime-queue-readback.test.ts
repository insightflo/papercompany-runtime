// @vitest-environment node
// [Task 6C/6D] queue/run transition event mirror + comment-free readback verification.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  recordHeartbeatQueueTransitionEvent,
  recordHeartbeatRunTerminalTransitionEvent,
} from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn("Skipping queue readback tests: unsupported environment");
}

async function seedMinimalFixture(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const issueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Queue Readback Company",
    issuePrefix: `QR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Queue Test Agent",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: { promptTemplate: "Test." },
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: agentId,
    title: "Queue readback mission",
    status: "active",
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    missionId,
    title: "Queue test issue",
    originKind: "workflow_execution",
    status: "todo",
    assigneeAgentId: agentId,
  });
  return { companyId, agentId, missionId, issueId };
}

async function insertQueuedRunFixture(
  db: ReturnType<typeof createDb>,
  input: { companyId: string; agentId: string; missionId: string; issueId: string },
) {
  const wakeupRequestId = randomUUID();
  const heartbeatRunId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId: input.companyId,
    agentId: input.agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "workflow_step_runnable",
    payload: { issueId: input.issueId, missionId: input.missionId },
    status: "accepted",
    runId: heartbeatRunId,
    issueId: input.issueId,
    missionId: input.missionId,
  });
  await db.insert(heartbeatRuns).values({
    id: heartbeatRunId,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    wakeupRequestId,
    invocationSource: "assignment",
    triggerDetail: "system",
    status: "queued",
    contextSnapshot: { issueId: input.issueId, missionId: input.missionId },
  });
  return { wakeupRequestId, heartbeatRunId };
}

describeEmbeddedPostgres("mission runtime queue readback (Task 6C/6D)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queue-readback-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    process.env.PAPERCLIP_AGENT_JWT_ISSUER = "test";
    process.env.PAPERCLIP_AGENT_JWT_AUDIENCE = "test";
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    delete process.env.PAPERCLIP_AGENT_JWT_ISSUER;
    delete process.env.PAPERCLIP_AGENT_JWT_AUDIENCE;
  });

  it("records queue_accepted transition event when wakeup creates a run", async () => {
    const { companyId, agentId, missionId, issueId } = await seedMinimalFixture(db);
    const { wakeupRequestId, heartbeatRunId } = await insertQueuedRunFixture(db, {
      companyId,
      agentId,
      missionId,
      issueId,
    });
    await recordHeartbeatQueueTransitionEvent(db, {
      companyId,
      missionId,
      issueId,
      wakeupRequestId,
      heartbeatRunId,
      eventType: "queue_accepted",
      layer: "queue",
      decision: "accepted",
      reason: "heartbeat_run_created",
      reasonCode: "heartbeat_run_created",
      idempotencyKey: `queue-accepted:${wakeupRequestId}:${heartbeatRunId}`,
    });

    const events = await db
      .select({ eventType: workflowTransitionEvents.eventType })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, companyId));
    expect(events.map((e) => e.eventType)).toContain("queue_accepted");
  });

  // queue_rejected emission fires through writeSkippedRequest skip paths (e.g. budget.blocked,
  // heartbeat.disabled); terminal-mission rejection throws `conflict` upstream of the event emitter,
  // so it is not asserted here. The accepted-path + comment-free readback below cover Task 6C/6D.

  it("[Task 6D] readback queue state from transition events without comments", async () => {
    const { companyId, agentId, missionId, issueId } = await seedMinimalFixture(db);
    const { wakeupRequestId, heartbeatRunId } = await insertQueuedRunFixture(db, {
      companyId,
      agentId,
      missionId,
      issueId,
    });
    await recordHeartbeatQueueTransitionEvent(db, {
      companyId,
      missionId,
      issueId,
      wakeupRequestId,
      heartbeatRunId,
      eventType: "queue_accepted",
      layer: "queue",
      decision: "accepted",
      reason: "heartbeat_run_created",
      reasonCode: "heartbeat_run_created",
      idempotencyKey: `queue-accepted:${wakeupRequestId}:${heartbeatRunId}`,
    });

    // structured readback: transition_events typed columns only (no issueComments query)
    const events = await db
      .select({
        eventType: workflowTransitionEvents.eventType,
        decision: workflowTransitionEvents.decision,
        reasonCode: workflowTransitionEvents.reasonCode,
        heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, companyId));

    const accepted = events.filter((e) => e.eventType === "queue_accepted");
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted[0]?.decision).toBe("accepted");
    expect(accepted[0]?.heartbeatRunId).toBeTruthy();
  });

  it("records queue_run_completed when a heartbeat run succeeds", async () => {
    const { companyId, agentId, issueId } = await seedMinimalFixture(db);
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: { issueId },
      status: "completed",
      issueId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      issueId,
      wakeupRequestId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      exitCode: 0,
      contextSnapshot: { issueId },
    }).returning();
    expect(run).toBeTruthy();
    await recordHeartbeatRunTerminalTransitionEvent(db, run!);

    const [completed] = await db
      .select({
        eventType: workflowTransitionEvents.eventType,
        decision: workflowTransitionEvents.decision,
        reasonCode: workflowTransitionEvents.reasonCode,
        heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
        idempotencyKey: workflowTransitionEvents.idempotencyKey,
      })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.eventType, "queue_run_completed"),
        eq(workflowTransitionEvents.heartbeatRunId, run!.id),
      ));

    expect(completed).toMatchObject({
      eventType: "queue_run_completed",
      decision: "succeeded",
      reasonCode: "run_terminal",
      heartbeatRunId: run!.id,
      idempotencyKey: `queue-run-completed:${run!.id}:succeeded`,
    });

    const [storedRun] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id));
    expect(storedRun?.status).toBe("succeeded");
  });
});
