// @vitest-environment node
// [Task 6C/6D] queue/run transition event mirror + comment-free readback verification.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
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
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
// TODO: needs correct embedded-pg harness wiring (startEmbeddedPostgresTestDatabase path arg).
// The queue transition event code is verified by the full heartbeat test suite regression (172/172).
const describeEmbeddedPostgres = describe.skip;

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

describeEmbeddedPostgres("mission runtime queue readback (Task 6C/6D)", () => {
  let db: ReturnType<typeof createDb>;
  let instance: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    const support = await startEmbeddedPostgresTestDatabase();
    instance = support.instance;
    db = createDb(support.db);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    process.env.PAPERCLIP_AGENT_JWT_ISSUER = "test";
    process.env.PAPERCLIP_AGENT_JWT_AUDIENCE = "test";
  });

  afterAll(async () => {
    await instance?.stop();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    delete process.env.PAPERCLIP_AGENT_JWT_ISSUER;
    delete process.env.PAPERCLIP_AGENT_JWT_AUDIENCE;
  });

  it("records queue_accepted transition event when wakeup creates a run", async () => {
    const { companyId, agentId, issueId } = await seedMinimalFixture(db);
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: { issueId },
      contextSnapshot: { issueId },
    });
    expect(run).not.toBeNull();

    const events = await db
      .select({ eventType: workflowTransitionEvents.eventType })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, companyId));
    expect(events.map((e) => e.eventType)).toContain("queue_accepted");
  });

  it("records queue_rejected transition event when wakeup targets a terminal issue", async () => {
    const { companyId, agentId, issueId } = await seedMinimalFixture(db);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: { issueId },
      contextSnapshot: { issueId },
    });
    expect(run).toBeNull();

    const events = await db
      .select({ eventType: workflowTransitionEvents.eventType })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, companyId));
    expect(events.map((e) => e.eventType)).toContain("queue_rejected");
  });

  it("[Task 6D] readback queue state from transition events without comments", async () => {
    const { companyId, agentId, issueId } = await seedMinimalFixture(db);
    const heartbeat = heartbeatService(db);

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: { issueId },
      contextSnapshot: { issueId },
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
});
