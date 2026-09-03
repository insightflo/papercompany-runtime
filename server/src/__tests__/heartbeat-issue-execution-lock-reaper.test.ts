import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip issue-execution-lock reaper tests: ${support.reason ?? "unsupported"}`);

type Seed = {
  companyId: string;
  agentId: string;
  issueId: string;
  parentRunId: string;
  retryRunId: string;
  workflowRunId: string;
  stepRunId: string;
};

async function seedStalledExecutionScenario(db: ReturnType<typeof createDb>, overrides?: {
  retryRunStatus?: string;
  executionRunIdOverride?: string | null;
  liveIssueRun?: boolean;
}): Promise<Seed> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const parentRunId = randomUUID();
  const retryRunId = randomUUID();
  const workflowDefId = randomUUID();
  const workflowRunId = randomUUID();
  const stepRunId = randomUUID();
  const now = new Date();

  await db.insert(companies).values({
    id: companyId,
    name: `LockReapCo-${companyId.slice(0, 8)}`,
    status: "active",
    issuePrefix: `LR${companyId.slice(0, 6).toUpperCase()}`,
  });
  await db.insert(agents).values({
    id: agentId, companyId, name: "lock-reap agent", status: "active",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(workflowDefinitions).values({
    id: workflowDefId, companyId, name: `lock-reap-wf-${workflowDefId.slice(0, 8)}`,
    stepsJson: [{ id: "tts", name: "tts", dependencies: [] }],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId, companyId, workflowId: workflowDefId, status: "running", triggeredBy: "test",
  });

  // Issue in_progress, assignee matches the executing agent, execution lock on the
  // process_lost parent run (terminal failure). Inserted after the runs (FK).
  const issueValues = {
    id: issueId, companyId, title: "TTS 음성 생성", status: "in_progress",
    assigneeAgentId: agentId,
    checkoutRunId: parentRunId,
    executionRunId: overrides?.executionRunIdOverride !== undefined ? overrides.executionRunIdOverride : parentRunId,
    startedAt: now, updatedAt: now,
  };

  // The workflow step run stays 'running' with the issue attached (incident state).
  const stepRunValues = {
    id: stepRunId, workflowRunId, stepId: "tts", status: "running", issueId, metadata: {},
  };

  // Parent run: terminal failure (process_lost).
  await db.insert(heartbeatRuns).values({
    id: parentRunId, companyId, agentId, issueId: null,
    invocationSource: "assignment", triggerDetail: "system", status: "failed",
    errorCode: "process_lost", error: "Process lost -- child pid gone",
    startedAt: new Date(now.getTime() - 45 * 60_000),
    finishedAt: new Date(now.getTime() - 25 * 60_000), updatedAt: now,
  });

  // Retry run: separate id, no issue linkage (the incident's linkage hole).
  await db.insert(heartbeatRuns).values({
    id: retryRunId, companyId, agentId, issueId: null,
    invocationSource: "automation", triggerDetail: "system",
    status: overrides?.retryRunStatus ?? "timed_out",
    errorCode: overrides?.retryRunStatus === "running" ? null : "execution_stale_timeout",
    error: overrides?.retryRunStatus === "running" ? null : "Heartbeat execution exceeded 900s",
    retryOfRunId: parentRunId, processLossRetryCount: 1,
    startedAt: new Date(now.getTime() - 24 * 60_000),
    finishedAt: overrides?.retryRunStatus === "running" ? null : new Date(now.getTime() - 60_000),
    updatedAt: now,
  });

  await db.insert(issues).values(issueValues as never);
  await db.insert(workflowStepRuns).values(stepRunValues as never);

  if (overrides?.liveIssueRun) {
    // A live queued/running run linked to the issue via issue_id (engine-aware adoption).
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId, issueId,
      invocationSource: "assignment", triggerDetail: "system", status: "running",
      startedAt: new Date(now.getTime() - 30_000), updatedAt: now,
    });
  }

  return { companyId, agentId, issueId, parentRunId, retryRunId, workflowRunId, stepRunId };
}

describeEP("reapStalledIssueExecutionLocks (terminal-run orphaned issue execution locks)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("lock-reaper-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("recovers the TTS incident shape: issue locked to terminal parent, terminal retry, step stuck running", async () => {
    const seed = await seedStalledExecutionScenario(db);
    const heartbeat = heartbeatService(db);

    const summary = await heartbeat.reapStalledIssueExecutionLocks();

    expect(summary.reaped).toBeGreaterThanOrEqual(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue?.status).toBe("blocked");
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();

    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(stepRun?.status).toBe("failed");

    const failureBlock = await db.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.entityId, seed.issueId), eq(activityLog.action, "issue.run_failure_auto_blocked")))
      .then((rows) => rows[0] ?? null);
    expect(failureBlock).not.toBeNull();

    // The stalled workflow run terminalizes instead of skipping forever.
    const [workflowRun] = await db.select({ status: workflowRuns.status }).from(workflowRuns)
      .where(eq(workflowRuns.id, seed.workflowRunId));
    expect(workflowRun?.status).toBe("failed");
  });

  it("does not touch the issue while the process-loss retry successor is still live", async () => {
    const seed = await seedStalledExecutionScenario(db, { retryRunStatus: "running" });
    const heartbeat = heartbeatService(db);

    const summary = await heartbeat.reapStalledIssueExecutionLocks();

    expect(summary.reaped).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue?.status).toBe("in_progress");
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(stepRun?.status).toBe("running");
  });

  it("does not touch the issue while a lock column still points at a live run", async () => {
    const seed = await seedStalledExecutionScenario(db, { retryRunStatus: "running", executionRunIdOverride: null });
    // Re-point execution lock at the live retry run (enqueueProcessLossRetry re-lock shape).
    await db.update(issues).set({ executionRunId: seed.retryRunId }).where(eq(issues.id, seed.issueId));
    const heartbeat = heartbeatService(db);

    const summary = await heartbeat.reapStalledIssueExecutionLocks();

    expect(summary.reaped).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("does not touch the issue while any live run is linked to it via heartbeat issue_id", async () => {
    const seed = await seedStalledExecutionScenario(db, { liveIssueRun: true });
    const heartbeat = heartbeatService(db);

    const summary = await heartbeat.reapStalledIssueExecutionLocks();

    expect(summary.reaped).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue?.status).toBe("in_progress");
  });
});
