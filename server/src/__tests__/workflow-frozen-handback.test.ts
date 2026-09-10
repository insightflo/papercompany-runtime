import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  createDb,
  issueComments,
  workflowDefinitions,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { handleDelegatedArtifactHandback } from "../services/delegated-artifact-handback.js";
import {
  captureWakeups,
  clearDelegatedArtifactHandbackTestData,
  seedDelegatedArtifactCase,
  type DelegatedArtifactSeed,
} from "./helpers/delegated-artifact-handback-fixture.js";
import {
  corruptSnapshotSteps,
  editLiveDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

/** producer -> structural gate -> semantic parent (the handback parent is the semantic QA step). */
function frozenHandbackSteps(agentId: string) {
  return [
    { id: "producer", name: "Build delegated artifact", agentId, dependencies: [], graphWorkProductRequired: true },
    {
      id: "structural-gate", name: "Structural gate", agentId: "", type: "tool", qaType: "structural",
      toolNames: ["validate"], dependencies: ["producer"],
    },
    { id: "qa-semantic", name: "[QA] Semantic review", agentId, qaType: "semantic", dependencies: ["producer", "structural-gate"] },
  ];
}

describeEP("delegated artifact handback follows the frozen execution definition (Task5a2c)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-handback-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await clearDelegatedArtifactHandbackTestData(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function seedFrozenHandback(options: { seedVerdict?: boolean } = {}) {
    const producerCompletedAt = new Date(Date.now() - 5_000);
    const token = {
      producerStepId: "producer",
      iterationIndex: 0,
      completedAt: producerCompletedAt.toISOString(),
    };
    const seeded: DelegatedArtifactSeed = await seedDelegatedArtifactCase(db, {
      parentStepId: "qa-semantic",
      frozenSteps: frozenHandbackSteps(randomUUID()),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: seeded.workflowRunId, stepId: "producer", status: "completed",
        iterationIndex: 0, completedAt: producerCompletedAt,
      },
      {
        workflowRunId: seeded.workflowRunId, stepId: "structural-gate", status: "completed",
        iterationIndex: 0, completedAt: new Date(),
        lastDispatchRequestId: "handback-structural-request",
        metadata: { structuralGateProducerToken: token },
      },
    ]);
    if (options.seedVerdict) {
      const [gateRun] = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
        eq(workflowStepRuns.workflowRunId, seeded.workflowRunId),
        eq(workflowStepRuns.stepId, "structural-gate"),
      ));
      if (!gateRun) throw new Error("gate step run missing");
      await db.insert(workflowTransitionEvents).values({
        companyId: seeded.companyId,
        workflowRunId: seeded.workflowRunId,
        workflowStepRunId: gateRun.id,
        issueId: null,
        eventType: "workflow_validation_verdict",
        layer: "workflow_validation",
        verdict: "pass",
        decision: "pass",
        reasonCode: "workflow_tool_result",
        idempotencyKey: `structural-gate-verdict:${seeded.companyId}:${gateRun.id}:handback-structural-request`,
        payload: {
          kind: "structural_gate_verdict",
          requestId: "handback-structural-request",
          verdict: "pass",
          producerToken: token,
        },
      });
    }
    return { ...seeded, token };
  }

  async function countsFor(parentIssueId: string, companyId: string) {
    const comments = await db.select({ id: issueComments.id }).from(issueComments)
      .where(eq(issueComments.issueId, parentIssueId));
    const activity = await db.select({ id: activityLog.id }).from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    return { comments: comments.length, activity: activity.length };
  }

  it("dispatches once to the existing parent assignee on the frozen graph when the exact structural PASS exists", async () => {
    const seeded = await seedFrozenHandback({ seedVerdict: true });
    // Live edit: the definition now contains ONLY the producer — parent and gate are gone
    // from the live graph. The frozen snapshot alone must drive the exact-PASS dispatch.
    await editLiveDefinition(db, seeded.workflowDefinitionId, {
      stepsJson: [
        { id: "producer", name: "Build delegated artifact", agentId: seeded.assigneeAgentId, dependencies: [], graphWorkProductRequired: true },
      ],
    });
    const { heartbeat, wakeups } = captureWakeups();

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    expect(result).toMatchObject({
      status: "handled",
      parentIssueId: seeded.parentIssueId,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
      workflowRunId: seeded.workflowRunId,
      workflowStepRunId: seeded.parentStepRunId,
      wakeupRequested: true,
    });
    expect(wakeups).toHaveLength(1);
    const wakeup = wakeups[0];
    if (!wakeup) throw new Error("Expected a captured wakeup");
    expect(wakeup.agentId).toBe(seeded.assigneeAgentId);
    expect(wakeup.opts.payload).toEqual(expect.objectContaining({
      mutation: "workflow_resume",
      workflowRunId: seeded.workflowRunId,
      workflowStepRunId: seeded.parentStepRunId,
      stepId: "qa-semantic",
    }));

    const duplicate = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });
    expect(duplicate).toEqual({ status: "skipped", reason: "already_dispatched" });
    expect(wakeups).toHaveLength(1);
  });

  it("stays skipped parent_not_runnable when the stored gate has no official current-generation PASS", async () => {
    const seeded = await seedFrozenHandback();
    const { heartbeat, wakeups } = captureWakeups();

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });

    expect(result).toEqual({ status: "skipped", reason: "parent_not_runnable" });
    expect(wakeups).toHaveLength(0);
    expect(await countsFor(seeded.parentIssueId, seeded.companyId)).toEqual({ comments: 0, activity: 0 });
  });

  it("live removal of the structural dependency (and live parent qaType edits) cannot bypass the frozen gate", async () => {
    const seeded = await seedFrozenHandback();
    const { heartbeat, wakeups } = captureWakeups();
    // Live edit: remove the gate edge AND drop the live parent qaType — neither may bypass.
    await editLiveDefinition(db, seeded.workflowDefinitionId, {
      stepsJson: [
        { id: "producer", name: "Build delegated artifact", agentId: seeded.assigneeAgentId, dependencies: [], graphWorkProductRequired: true },
        { id: "qa-semantic", name: "[QA] Semantic review", agentId: seeded.assigneeAgentId, dependencies: ["producer"] },
      ],
    });
    // Prove the live edit actually landed on the live definition row.
    const [definition] = await db.select({ stepsJson: workflowDefinitions.stepsJson })
      .from(workflowDefinitions).where(eq(workflowDefinitions.id, seeded.workflowDefinitionId));
    const liveIds = JSON.stringify(definition?.stepsJson ?? []);
    expect(liveIds).not.toContain("structural-gate");

    const result = await handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: seeded.childIssueId,
      childWorkProductId: seeded.childWorkProductId,
    });
    // Frozen graph still owns readiness: gate without official PASS blocks the handback.
    expect(result).toEqual({ status: "skipped", reason: "parent_not_runnable" });
    expect(wakeups).toHaveLength(0);
    expect(await countsFor(seeded.parentIssueId, seeded.companyId)).toEqual({ comments: 0, activity: 0 });
  });

  it("rejects with 422 before any write when the frozen snapshot is corrupt even if the live graph would permit", async () => {
    const corrupted = await seedFrozenHandback({ seedVerdict: true });
    await corruptSnapshotSteps(fixture.sql, corrupted.workflowRunId);
    const { heartbeat, wakeups } = captureWakeups();
    await expect(handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: corrupted.childIssueId,
      childWorkProductId: corrupted.childWorkProductId,
    })).rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    expect(wakeups).toHaveLength(0);
    expect(await countsFor(corrupted.parentIssueId, corrupted.companyId)).toEqual({ comments: 0, activity: 0 });
  });

  it("rejects with 422 before any write when the frozen snapshot row is missing even if the live graph would permit", async () => {
    const missing = await seedFrozenHandback({ seedVerdict: true });
    await fixture.sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${missing.workflowRunId}`;
    const { heartbeat, wakeups } = captureWakeups();
    await expect(handleDelegatedArtifactHandback({
      db,
      heartbeat,
      childIssueId: missing.childIssueId,
      childWorkProductId: missing.childWorkProductId,
    })).rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    expect(wakeups).toHaveLength(0);
    expect(await countsFor(missing.parentIssueId, missing.companyId)).toEqual({ comments: 0, activity: 0 });
  });
});
