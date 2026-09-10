import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  createDb,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  editLiveDefinition,
  seedFrozenHeartbeat,
  seedFrozenIssueStep,
  seedFrozenMissionGraph,
  seedFrozenStepRun,
  seedFrozenValidationVerdict,
  seedFrozenWorkProduct,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import { captureFrozenRecoveryState } from "./helpers/workflow-frozen-recovery-state.js";
import { reconcileRecoveredWorkflowStep } from "../services/missions/recovery-closeout.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const FROZEN_STEPS = [
  { id: "producer-a", name: "Produce A", agentId: "", dependencies: [] },
  { id: "producer-b", name: "Produce B", agentId: "", dependencies: [] },
  { id: "qa-gate", name: "QA gate", agentId: "", type: "qa", dependencies: ["producer-a"] },
];

describeEP("workflow frozen recovery closeout (frozen DAG resolves the reconciled producer)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-closeout-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** producerA→QA 캡처 + unrelated producerB, 둘 다 failed step 행, active A 산출물 + 공식 PASS. */
  async function seedCloseoutMission(input: { artifactAt: Date; passAt: Date; passRunId?: string; withArtifact?: boolean }) {
    const seed = await seedFrozenMissionGraph(fixture.sql, db, {
      issuePrefix: "FC" + randomUUID().slice(0, 4),
      name: "frozen-closeout-workflow",
      stepsJson: FROZEN_STEPS,
    });
    const producerA = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "producer-a",
      title: "Producer A",
      issueStatus: "in_review",
      status: "failed",
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const producerB = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "producer-b",
      title: "Producer B",
      issueStatus: "in_review",
      status: "failed",
      startedAt: new Date("2026-08-01T10:01:00.000Z"),
    });
    const qaGate = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "qa-gate",
      title: "QA gate issue",
      issueStatus: "in_review",
      status: "completed",
      startedAt: new Date("2026-08-01T10:02:00.000Z"),
      completedAt: input.passAt,
    });
    if (input.withArtifact !== false) {
      await seedFrozenWorkProduct(db, { companyId: seed.companyId, issueId: producerA.issueId, updatedAt: input.artifactAt });
    }
    const passRunId = input.passRunId ?? seed.runId;
    if (passRunId === seed.runId) {
      const heartbeatRunId = await seedFrozenHeartbeat(db, {
        companyId: seed.companyId,
        agentId: seed.agentId,
        issueId: qaGate.issueId,
        status: "succeeded",
        finishedAt: input.passAt,
      });
      await seedFrozenValidationVerdict(db, {
        companyId: seed.companyId,
        missionId: seed.missionId,
        issueId: qaGate.issueId,
        workflowRunId: seed.runId,
        workflowStepRunId: qaGate.stepRunId,
        heartbeatRunId,
        verdict: "pass",
        createdAt: input.passAt,
      });
    } else {
      await seedFrozenValidationVerdict(db, {
        companyId: seed.companyId,
        missionId: seed.missionId,
        issueId: qaGate.issueId,
        workflowRunId: passRunId,
        workflowStepRunId: qaGate.stepRunId,
        verdict: "pass",
        createdAt: input.passAt,
      });
    }
    return { ...seed, producerAStepRunId: producerA.stepRunId, producerBIssueId: producerB.issueId, producerBStepRunId: producerB.stepRunId, qaIssueId: qaGate.issueId, producerAIssueId: producerA.issueId };
  }

  /** live graph: QA dependency 를 B 로 이동(캡처는 A 의존 유지). */
  async function editQaDependencyToProducerB(workflowId: string): Promise<void> {
    await editLiveDefinition(db, workflowId, {
      stepsJson: [
        { id: "producer-a", name: "Produce A", agentId: "", dependencies: [] },
        { id: "producer-b", name: "Produce B", agentId: "", dependencies: [] },
        { id: "qa-gate", name: "QA gate", agentId: "", type: "qa", dependencies: ["producer-b"] },
      ],
    });
  }

  it("completes only the captured producer A and leaves producer B, issues and run untouched", async () => {
    const artifactAt = new Date("2026-08-01T12:00:00.000Z");
    const f = await seedCloseoutMission({ artifactAt, passAt: new Date(artifactAt.getTime() + 60_000) });
    await editQaDependencyToProducerB(f.workflowId);
    const before = await captureFrozenRecoveryState(db, f.runId);

    const result = await reconcileRecoveredWorkflowStep(db, {
      companyId: f.companyId,
      missionId: f.missionId,
      qaGateIssueId: f.qaIssueId,
    });

    expect(result).toMatchObject({
      reconciled: true,
      workflowStepRunId: f.producerAStepRunId,
      workflowRunId: f.runId,
      stepPriorStatus: "failed",
    });
    const stepA = (await stepRunsOf(db, f.runId)).find((row) => row.id === f.producerAStepRunId)!;
    expect(stepA.status).toBe("completed");
    expect(stepA.metadata).toHaveProperty("recoveryCloseout");
    const stepB = (await stepRunsOf(db, f.runId)).find((row) => row.id === f.producerBStepRunId)!;
    expect(stepB.status).toBe("failed");
    expect(stepB.metadata).not.toHaveProperty("recoveryCloseout");
    const transitions = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, f.runId),
      eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
    ));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      workflowStepRunId: f.producerAStepRunId,
      fromStatus: "failed",
      toStatus: "completed",
    });
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "mission.recovery_closeout_reconciled_step"),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(f.producerAStepRunId);
    // issues 와 run 은 closeout 이 건드리지 않는다(기존 구현 계약 유지).
    expect((await db.select().from(issues).where(eq(issues.companyId, f.companyId))).map((row) => row.status))
      .toEqual(before.linkedIssues.map((row) => row.status));
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0]!.status)
      .toBe(before.run!.status);
  });

  it("skips when the QA pass predates the artifact generation (stale pass)", async () => {
    const artifactAt = new Date("2026-08-01T12:00:00.000Z");
    const f = await seedCloseoutMission({ artifactAt, passAt: new Date(artifactAt.getTime() - 60_000) });
    await editQaDependencyToProducerB(f.workflowId);
    const result = await reconcileRecoveredWorkflowStep(db, {
      companyId: f.companyId, missionId: f.missionId, qaGateIssueId: f.qaIssueId,
    });
    expect(result).toEqual({ skipped: true, reason: "no_fresh_qa_pass" });
    const producerA = (await stepRunsOf(db, f.runId)).find((row) => row.id === f.producerAStepRunId)!;
    expect(producerA.status).toBe("failed");
  });

  it("skips without an active producer workproduct", async () => {
    const artifactAt = new Date("2026-08-01T12:00:00.000Z");
    const f = await seedCloseoutMission({ artifactAt, passAt: new Date(artifactAt.getTime() + 60_000), withArtifact: false });
    await editQaDependencyToProducerB(f.workflowId);
    const result = await reconcileRecoveredWorkflowStep(db, {
      companyId: f.companyId, missionId: f.missionId, qaGateIssueId: f.qaIssueId,
    });
    expect(result).toEqual({ skipped: true, reason: "no_active_workproduct" });
  });

  it("skips when the only PASS belongs to another run (wrong-run pass)", async () => {
    const artifactAt = new Date("2026-08-01T12:00:00.000Z");
    const f = await seedCloseoutMission({ artifactAt, passAt: new Date(artifactAt.getTime() + 60_000) });
    const otherRunId = await seedWorkflowRun(fixture.sql, {
      workflowId: f.workflowId, companyId: f.companyId, missionId: f.missionId, status: "running",
    });
    // run1 의 PASS 를 제거하고 다른 run PASS 만 남긴다(전환 이벤트 직접 재스코프).
    await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, f.runId));
    await seedFrozenValidationVerdict(db, {
      companyId: f.companyId,
      missionId: f.missionId,
      issueId: f.qaIssueId,
      workflowRunId: otherRunId,
      workflowStepRunId: (await stepRunsOf(db, f.runId)).find((row) => row.stepId === "qa-gate")!.id,
      verdict: "pass",
      createdAt: new Date(artifactAt.getTime() + 60_000),
    });
    const result = await reconcileRecoveredWorkflowStep(db, {
      companyId: f.companyId, missionId: f.missionId, qaGateIssueId: f.qaIssueId,
    });
    expect(result).toEqual({ skipped: true, reason: "no_fresh_qa_pass" });
  });

  it.each(["missing", "corrupt"] as const)(
    "%s expected snapshot throws 422 before any write even with sufficient evidence and a live editable graph",
    async (state) => {
      const artifactAt = new Date("2026-08-01T12:00:00.000Z");
      const f = await seedCloseoutMission({ artifactAt, passAt: new Date(artifactAt.getTime() + 60_000) });
      await editQaDependencyToProducerB(f.workflowId);
      const before = await captureFrozenRecoveryState(db, f.runId);
      const auditsBefore = await db.select().from(activityLog);
      if (state === "missing") {
        await (fixture.sql as RawSql)`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${f.runId}`;
      } else {
        await corruptSnapshotSteps(fixture.sql, f.runId);
      }

      const error = await captureHttpError(reconcileRecoveredWorkflowStep(db, {
        companyId: f.companyId,
        missionId: f.missionId,
        qaGateIssueId: f.qaIssueId,
      }));

      expect(error.status).toBe(422);
      expect(error.message).toBe("historical_definition_unproven");
      const after = await captureFrozenRecoveryState(db, f.runId);
      expect(after.steps).toEqual(before.steps);
      expect(after.transitionEvents).toEqual(before.transitionEvents);
      expect(await db.select().from(activityLog)).toEqual(auditsBefore);
      expect((await stepRunsOf(db, f.runId)).find((row) => row.id === f.producerBStepRunId)!.status).toBe("failed");
      expect((await stepRunsOf(db, f.runId)).find((row) => row.id === f.producerAStepRunId)!.status).toBe("failed");
    },
  );
});
