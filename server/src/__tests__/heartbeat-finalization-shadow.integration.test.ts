import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { transferHeartbeatAuthorityToChild } from "../services/heartbeat-finalization/authority-transfer.js";
import {
  acknowledgeHeartbeatOwnerCapability,
  claimHeartbeatRunWithOwnerCapability,
  decideHeartbeatTerminalOutcomeFirstWins,
} from "../services/heartbeat-finalization/owner-capability.js";
import { claimQueuedHeartbeatRun } from "../services/heartbeat-finalization/shadow-writes.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip heartbeat finalization shadow tests: ${support.reason ?? "unsupported"}`);

describeEP("heartbeat finalization v1 shadow writers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let workflowRunId: string;
  let stepRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-finalization-shadow-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    const workflowId = randomUUID();
    workflowRunId = randomUUID();
    stepRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ShadowCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Shadow agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "Shadow workflow", stepsJson: [{ id: "step" }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId, workflowRunId, stepId: "step", status: "pending", metadata: {},
    });
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.update(workflowStepRuns).set({
      status: "pending", retryCount: 0, executionGeneration: 0, completedAt: null,
      lastDispatchRequestId: null, metadata: {}, dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null, evidenceReadyAt: null, dispatchReadyAt: null,
    }).where(eq(workflowStepRuns.id, stepRunId));
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: true } });
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("binds and acknowledges a typed owner, advances retry generation, transfers both epochs, and preserves the first outcome", async () => {
    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId, companyId, agentId, source: "automation", status: "queued",
      workflowRunId, workflowStepRunId: stepRunId, workflowExecutionGeneration: 0,
    });
    const [queued] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "queued", invocationSource: "automation", wakeupRequestId: wakeupId,
    }).returning();

    const claimed = await claimHeartbeatRunWithOwnerCapability(db, queued, new Date());
    expect(claimed).toMatchObject({
      status: "running", executionScopeKind: "workflow_step", executionEpoch: 0,
      workflowStepRunId: stepRunId, workflowExecutionGeneration: 0,
    });
    expect(claimed?.executionToken).toBeTruthy();
    expect(claimed?.executorOwnerLeaseToken).toBeTruthy();
    const acknowledged = await acknowledgeHeartbeatOwnerCapability(db, claimed!, new Date());
    expect(acknowledged?.executorOwnerAcknowledgedAt).toBeInstanceOf(Date);

    const first = await decideHeartbeatTerminalOutcomeFirstWins(db, {
      run: acknowledged!, outcome: "succeeded", source: "adapter_success", now: new Date(),
    });
    const second = await decideHeartbeatTerminalOutcomeFirstWins(db, {
      run: acknowledged!, outcome: "failed", source: "adapter_failure", now: new Date(),
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const childWakeupId = randomUUID();
    const childRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: childWakeupId, companyId, agentId, source: "automation", status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: childRunId, companyId, agentId, status: "queued", invocationSource: "automation", wakeupRequestId: childWakeupId,
    });
    await db.transaction((tx) => transferHeartbeatAuthorityToChild(tx, {
      parent: acknowledged!, childRunId, childWakeupRequestId: childWakeupId, now: new Date(), reason: "adapter_fallback",
    }));
    const [transferredParent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(transferredParent.executionEpoch).toBe(1);
    expect(transferredParent.executorOwnerLeaseEpoch).toBe((acknowledged?.executorOwnerLeaseEpoch ?? 0) + 1);
    expect(transferredParent.executorOwnerLeaseToken).not.toBe(acknowledged?.executorOwnerLeaseToken);
    const [child] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, childRunId));
    expect(child).toMatchObject({ executionEpoch: 0, workflowStepRunId: stepRunId, workflowExecutionGeneration: 0 });
    expect(child.executionToken).toBeTruthy();

    const completedAt = new Date();
    const retryRequestId = `retry-${randomUUID()}`;
    const retryStepRunId = randomUUID();
    await db.insert(workflowStepRuns).values({
      id: retryStepRunId, workflowRunId, stepId: "retry", status: "failed", completedAt,
      lastDispatchRequestId: retryRequestId, metadata: {},
    });
    const scheduled = await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId, stepRunId: retryStepRunId, retryNumber: 1, maxRetries: 1, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0, observedCompletedAt: completedAt,
      observedLastDispatchRequestId: retryRequestId, observedMetadataSnapshot: {}, observedExecutionGeneration: 0, errorSummary: null,
    });
    expect(scheduled.result).toBe("scheduled");
    const [retried] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, retryStepRunId));
    expect(retried.executionGeneration).toBe(1);
    const events = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowStepRunId, retryStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_authority_transition"),
    ));
    expect(events).toHaveLength(1);
  });

  it("leaves workflow generation untouched while the feature flag is off", async () => {
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: false } });
    const completedAt = new Date();
    const requestId = `legacy-${randomUUID()}`;
    await db.update(workflowStepRuns).set({
      status: "failed", completedAt, lastDispatchRequestId: requestId, metadata: {}, executionGeneration: 0,
    }).where(eq(workflowStepRuns.id, stepRunId));
    const legacyWakeupId = randomUUID();
    const legacyRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: legacyWakeupId, companyId, agentId, source: "on_demand", status: "queued",
    });
    const [legacyQueued] = await db.insert(heartbeatRuns).values({
      id: legacyRunId, companyId, agentId, status: "queued", invocationSource: "on_demand", wakeupRequestId: legacyWakeupId,
    }).returning();
    const legacyClaimed = await claimQueuedHeartbeatRun(db, legacyQueued, new Date());
    expect(legacyClaimed).toMatchObject({ finalizationVersion: 0, executionEpoch: null, executionToken: null });
    expect(legacyClaimed?.executorOwnerLeaseToken).toBeNull();
    await scheduleWorkflowStepRetry(db, {
      companyId, workflowRunId, stepRunId, retryNumber: 1, maxRetries: 1, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0, observedCompletedAt: completedAt,
      observedLastDispatchRequestId: requestId, observedMetadataSnapshot: {}, observedExecutionGeneration: 0, errorSummary: null,
    });
    const [legacy] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(legacy.executionGeneration).toBe(0);
    expect(legacy.dispatchOwnerHeartbeatRunId).toBeNull();
  });
});
