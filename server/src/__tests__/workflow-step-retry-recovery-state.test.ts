import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry recovery-state tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step retry recovery-state suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-recovery-state-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryRecoveryCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedFailedIssueBackedStep() {
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `agent-${randomUUID().slice(0, 6)}`;

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${stepId}`,
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: `WF-${stepId}`,
      stepsJson: [{ id: stepId, name: "Worker", agentId, onFailure: "retry", maxRetries: 2 }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
    });

    await syncWorkflowRunState(db, workflowRunId);
    const [stepRun] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      eq(workflowStepRuns.stepId, stepId),
    ));
    if (!stepRun?.issueId) throw new Error("Expected issue-backed step run");
    const [issue] = await db.select().from(issues).where(eq(issues.id, stepRun.issueId));
    if (!issue?.assigneeAgentId) throw new Error("Expected assigned issue");
    const now = new Date();
    await db.update(agentWakeupRequests).set({
      status: "completed",
      finishedAt: now,
      updatedAt: now,
    }).where(eq(agentWakeupRequests.issueId, stepRun.issueId));
    await db.update(heartbeatRuns).set({
      status: "failed",
      finishedAt: now,
      error: "simulated failure",
    }).where(eq(heartbeatRuns.issueId, stepRun.issueId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: issue.assigneeAgentId,
      issueId: stepRun.issueId,
      invocationSource: "test",
      status: "failed",
      startedAt: now,
      finishedAt: now,
      error: "simulated failure",
    });
    await db.update(issues)
      .set({ status: "blocked", updatedAt: now })
      .where(eq(issues.id, stepRun.issueId));

    return { agentId, workflowRunId, stepRunId: stepRun.id, issueId: stepRun.issueId };
  }

  async function loadStep(stepRunId: string) {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    return row;
  }

  async function retryEventCount(workflowRunId: string) {
    const rows = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled"),
    ));
    return rows.length;
  }

  it("suppresses generic retry while an active heartbeat recovery is running", async () => {
    const seeded = await seedFailedIssueBackedStep();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: seeded.agentId,
      issueId: seeded.issueId,
      invocationSource: "test",
      status: "running",
      startedAt: new Date(),
    });

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await loadStep(seeded.stepRunId);
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    expect(await retryEventCount(seeded.workflowRunId)).toBe(0);
  });

  it("suppresses generic retry while a live wake recovery exists", async () => {
    const seeded = await seedFailedIssueBackedStep();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: seeded.agentId,
      issueId: seeded.issueId,
      source: "test",
      status: "claimed",
      reason: "workflow_step_runnable",
      requestedAt: new Date(),
    });

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await loadStep(seeded.stepRunId);
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    expect(await retryEventCount(seeded.workflowRunId)).toBe(0);
  });

  it("schedules exactly one generic retry after active heartbeat recovery turns terminal", async () => {
    const seeded = await seedFailedIssueBackedStep();
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId: seeded.agentId,
      issueId: seeded.issueId,
      invocationSource: "test",
      status: "queued",
    });

    await syncWorkflowRunState(db, seeded.workflowRunId);
    let after = await loadStep(seeded.stepRunId);
    expect(after.retryCount).toBe(0);
    expect(after.status).toBe("failed");

    await db.update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date(), error: "recovery failed" })
      .where(eq(heartbeatRuns.id, heartbeatRunId));

    await syncWorkflowRunState(db, seeded.workflowRunId);

    after = await loadStep(seeded.stepRunId);
    expect(after.retryCount).toBe(1);
    expect(after.status).toBe("pending");
    expect(await retryEventCount(seeded.workflowRunId)).toBe(1);
  });
  it("allows generic retry when a coalesced wake links only to a terminal run", async () => {
    const seeded = await seedFailedIssueBackedStep();
    const terminalRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: terminalRunId,
      companyId,
      agentId: seeded.agentId,
      issueId: seeded.issueId,
      invocationSource: "test",
      status: "failed",
      finishedAt: new Date(),
      error: "coalesced terminal run",
    });
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: seeded.agentId,
      issueId: seeded.issueId,
      source: "test",
      status: "coalesced",
      runId: terminalRunId,
      requestedAt: new Date(),
    });

    await syncWorkflowRunState(db, seeded.workflowRunId);

    const after = await loadStep(seeded.stepRunId);
    expect(after.retryCount).toBe(1);
    expect(after.status).toBe("pending");
    expect(await retryEventCount(seeded.workflowRunId)).toBe(1);
  });
});
