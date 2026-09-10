import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  workflowRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  seedFrozenHeartbeat,
  seedFrozenIssueStep,
  seedFrozenMissionGraph,
  seedFrozenValidationVerdict,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import { getMissionRecoveryAdvice } from "../services/missions/mission-recovery-advice.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

/** 캡처 그래프: producer-a 가 qa-gate 로의 qa_request_changes edge 를 보유. */
const FROZEN_STEPS = [
  { id: "producer-a", name: "Produce A", agentId: "", dependencies: [], conditionalDependencies: [{ stepId: "qa-gate", when: "qa_request_changes" }] },
  { id: "qa-gate", name: "QA gate", agentId: "", type: "qa", dependencies: [] },
];

/** live 편집: edge 를 무관한 producer-b 로 이동. */
const LIVE_MOVED_EDGE_STEPS = [
  { id: "producer-a", name: "Produce A", agentId: "", dependencies: [] },
  { id: "producer-b", name: "Produce B", agentId: "", dependencies: [], conditionalDependencies: [{ stepId: "qa-gate", when: "qa_request_changes" }] },
  { id: "qa-gate", name: "QA gate", agentId: "", type: "qa", dependencies: [] },
];

describeEP("workflow frozen recovery advice (frozen graph binds the QA producer)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-advice-");
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

  /** 새 mission/run 에 producer/QA issue + current stepRun + heartbeat-bound 공식 RC verdict 를 시딩한다. */
  async function seedAdviceRun(input: {
    producerStepId: string;
    stepsJson: unknown[];
    observedAt: Date;
  }) {
    const seed = await seedFrozenMissionGraph(fixture.sql, db, {
      issuePrefix: "FD" + randomUUID().slice(0, 4),
      name: "frozen-advice-workflow",
      stepsJson: input.stepsJson,
    });
    const producer = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: input.producerStepId,
      title: `Producer ${input.producerStepId}`,
      issueStatus: "in_progress",
      status: "completed",
      startedAt: new Date(input.observedAt.getTime() - 3_600_000),
    });
    const qa = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "qa-gate",
      title: "QA gate issue",
      issueStatus: "in_review",
      status: "failed",
      startedAt: new Date(input.observedAt.getTime() - 60_000),
    });
    const heartbeatRunId = await seedFrozenHeartbeat(db, {
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId: qa.issueId,
      status: "succeeded",
      startedAt: new Date(input.observedAt.getTime() - 30_000),
      finishedAt: new Date(input.observedAt.getTime() - 1_000),
    });
    await seedFrozenValidationVerdict(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      issueId: qa.issueId,
      workflowRunId: seed.runId,
      workflowStepRunId: qa.stepRunId,
      heartbeatRunId,
      verdict: "request_changes",
      payloadReason: "layout broken",
      createdAt: input.observedAt,
    });
    return { ...seed, producerIssueId: producer.issueId, producerStepRunId: producer.stepRunId, qaIssueId: qa.issueId };
  }

  it("returns the frozen producer binding even after the live QA edge moves to an unrelated producer", async () => {
    const observedAt = new Date("2026-08-01T12:00:00.000Z");
    const f = await seedAdviceRun({ producerStepId: "producer-a", stepsJson: FROZEN_STEPS, observedAt });
    // 무관한 producer B 를 같은 run 에 준비(이슈+step 행) — live 편집 후 old graph 가 B 를 고르게 만든다.
    const producerB = await seedFrozenIssueStep(db, {
      companyId: f.companyId,
      missionId: f.missionId,
      runId: f.runId,
      stepId: "producer-b",
      title: "Producer B",
      issueStatus: "in_progress",
      status: "pending",
    });

    const first = await getMissionRecoveryAdvice(db, { companyId: f.companyId, missionId: f.missionId });
    expect(first.decision).toBe("producer_rework");
    expect(first.targetIssue?.id).toBe(f.producerIssueId);

    await editLiveDefinition(db, f.workflowId, { stepsJson: LIVE_MOVED_EDGE_STEPS });
    const second = await getMissionRecoveryAdvice(db, { companyId: f.companyId, missionId: f.missionId });
    expect(second.decision).toBe("producer_rework");
    expect(second.targetIssue?.id).toBe(f.producerIssueId);
    expect(second.targetIssue?.id).not.toBe(producerB.issueId);
  });

  it("a second run captured after the edit carries its own distinct captured graph", async () => {
    const t1 = new Date("2026-08-01T12:00:00.000Z");
    const f1 = await seedAdviceRun({ producerStepId: "producer-a", stepsJson: FROZEN_STEPS, observedAt: t1 });
    await editLiveDefinition(db, f1.workflowId, { stepsJson: LIVE_MOVED_EDGE_STEPS });
    const run2 = await createFrozenRun(db, { workflowId: f1.workflowId, companyId: f1.companyId, missionId: f1.missionId });

    // run2: B→QA 캡처 그래프에 맞는 이슈/step/heartbeat-bound RC.
    const producerB2 = await seedFrozenIssueStep(db, {
      companyId: f1.companyId, missionId: f1.missionId, runId: run2.id,
      stepId: "producer-b", title: "Producer B2", issueStatus: "in_progress", status: "completed",
      startedAt: new Date(t1.getTime() + 60_000),
    });
    const qa2 = await seedFrozenIssueStep(db, {
      companyId: f1.companyId, missionId: f1.missionId, runId: run2.id,
      stepId: "qa-gate", title: "QA gate issue 2", issueStatus: "in_review", status: "failed",
      startedAt: new Date(t1.getTime() + 120_000),
    });
    const t2 = new Date(t1.getTime() + 180_000);
    const heartbeatRunId = await seedFrozenHeartbeat(db, {
      companyId: f1.companyId, agentId: f1.agentId, issueId: qa2.issueId,
      status: "succeeded", finishedAt: new Date(t2.getTime() - 1_000),
    });
    await seedFrozenValidationVerdict(db, {
      companyId: f1.companyId, missionId: f1.missionId, issueId: qa2.issueId,
      workflowRunId: run2.id, workflowStepRunId: qa2.stepRunId, heartbeatRunId,
      verdict: "request_changes", payloadReason: "color broken", createdAt: t2,
    });

    const advice = await getMissionRecoveryAdvice(db, { companyId: f1.companyId, missionId: f1.missionId });
    // 최신 RC(run2)가 이기고, run2 의 캡처 그래프는 producer-b 를 가리킨다.
    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.id).toBe(producerB2.issueId);
    expect(advice.targetIssue?.id).not.toBe(f1.producerIssueId);
  });

  it.each(["missing", "corrupt"] as const)(
    "%s expected snapshot on the consulted current run rejects with 422 leaving all domain rows unchanged",
    async (state) => {
      const observedAt = new Date("2026-08-01T12:00:00.000Z");
      const f = await seedAdviceRun({ producerStepId: "producer-a", stepsJson: FROZEN_STEPS, observedAt });
      const before = {
        issues: await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
        heartbeats: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
        workProducts: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, f.companyId)),
        events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, f.companyId)),
        stepRuns: await stepRunsOf(db, f.runId),
        runs: await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)),
      };
      if (state === "missing") {
        await (fixture.sql as RawSql)`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${f.runId}`;
      } else {
        await corruptSnapshotSteps(fixture.sql, f.runId);
      }

      const error = await captureHttpError(getMissionRecoveryAdvice(db, { companyId: f.companyId, missionId: f.missionId }));

      expect(error.status).toBe(422);
      expect(error.message).toBe("historical_definition_unproven");
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before.issues);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual(before.heartbeats);
      expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, f.companyId))).toEqual(before.workProducts);
      expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, f.companyId))).toEqual(before.events);
      expect(await stepRunsOf(db, f.runId)).toEqual(before.stepRuns);
      expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId))).toEqual(before.runs);
    },
  );
});
