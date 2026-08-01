import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { detectQaReworkCapExhaustion } from "../services/missions/qa-rework-cap-oversight.js";
import {
  cleanQaCapFixture,
  loadQaCapStepRows,
  seedQaCapBase,
  seedQaCapWorkflow,
  seedStepHeartbeat,
  seedWorkflowVerdict,
  type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap detection: ${support.reason ?? "unsupported"}`);

async function detect(db: QaCapTestDb, base: Awaited<ReturnType<typeof seedQaCapBase>>) {
  return detectQaReworkCapExhaustion({
    db,
    companyId: base.companyId,
    stepRows: await loadQaCapStepRows(db, base),
  });
}

async function seedOfficialCurrent(
  db: QaCapTestDb,
  base: Awaited<ReturnType<typeof seedQaCapBase>>,
  seed: Awaited<ReturnType<typeof seedQaCapWorkflow>>,
  qaIndex = 0,
): Promise<string> {
  const qa = seed.qas[qaIndex]!;
  const heartbeatRunId = await seedStepHeartbeat(db, base, {
    workflowRunId: seed.runId,
    workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId,
    createdAt: new Date(Date.now() - 10_000),
  });
  await seedWorkflowVerdict(db, base, {
    workflowRunId: seed.runId,
    workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId,
    heartbeatRunId,
    createdAt: new Date(Date.now() - 9_000),
  });
  return heartbeatRunId;
}

describeEP("QA rework cap oversight detection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-detection-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("requires current official workflow_api request_changes bound to the exact QA step run", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    await seedOfficialCurrent(db, base, seed);

    const result = await detect(db, base);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      workflowRunId: seed.runId,
      producerStepId: seed.producerStepId,
      producerIteration: 2,
      producerCompletedAt: seed.producerCompletedAt!.toISOString(),
      qaStepId: seed.qas[0]!.stepId,
      qaStepRunId: seed.qas[0]!.stepRunId,
      maxIterations: 2,
    });
  });

  it("rejects missing verdict even when QA step status is failed", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId,
      workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId,
    });
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("rejects non-workflow_api or heartbeat-less verdicts", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, {
      iteration: 2,
      edges: [{ maxIterations: 2 }, { maxIterations: 2 }],
    });
    const hb0 = await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId,
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, heartbeatRunId: hb0,
      reason: "heartbeat_result",
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[1]!.stepRunId,
      issueId: seed.qas[1]!.issueId, heartbeatRunId: null,
      reason: "workflow_api",
    });
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("rejects stale request_changes observed before producer completion", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    const createdAt = new Date(seed.producerCompletedAt!.getTime() - 30_000);
    const heartbeatRunId = await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, createdAt,
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, heartbeatRunId, createdAt,
    });
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("fails closed when producerCompletedAt is null", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2, producerCompletedAt: null });
    await seedOfficialCurrent(db, base, seed);
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("rejects an official verdict superseded by a newer exact-step heartbeat", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    await seedOfficialCurrent(db, base, seed);
    await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, createdAt: new Date(),
    });
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("ignores a newer heartbeat for another step run that reused the QA issue", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    await seedOfficialCurrent(db, base, seed);
    await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: randomUUID(),
      issueId: seed.qas[0]!.issueId, createdAt: new Date(),
    });
    expect(await detect(db, base)).toHaveLength(1);
  });

  it("uses producer-level cap = max(all sibling back-edges), not per-edge", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, {
      iteration: 2,
      edges: [{ stepId: "qa-short", maxIterations: 2 }, { stepId: "qa-long", maxIterations: 4 }],
    });
    await seedOfficialCurrent(db, base, seed, 0);
    await seedOfficialCurrent(db, base, seed, 1);
    // Producer max = max(2,4) = 4; iteration 2 < 4 → NOT exhausted → no handoff.
    expect(await detect(db, base)).toHaveLength(0);

    // With both edges at max=2, iteration=2 → exhausted → handoff for each failed QA.
    await cleanQaCapFixture(db);
    const base2 = await seedQaCapBase(db);
    const seed2 = await seedQaCapWorkflow(db, base2, {
      iteration: 2,
      edges: [{ stepId: "qa-a", maxIterations: 2 }, { stepId: "qa-b", maxIterations: 2 }],
    });
    await seedOfficialCurrent(db, base2, seed2, 0);
    await seedOfficialCurrent(db, base2, seed2, 1);
    const result2 = await detect(db, base2);
    expect(result2.map((item) => [item.qaStepId, item.maxIterations]))
      .toEqual([["qa-a", 2], ["qa-b", 2]]);
  });

  it("blocks handoff while a sibling QA is still running (barrier)", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, {
      iteration: 2,
      edges: [
        { stepId: "qa-done", maxIterations: 2 },
        { stepId: "qa-running", maxIterations: 2, qaStatus: "running" },
      ],
    });
    await seedOfficialCurrent(db, base, seed, 0);
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("rejects a delayed old heartbeat that started before producer completion", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, { iteration: 2 });
    // Heartbeat started BEFORE producer completion, verdict observed AFTER.
    const beforeCompletion = new Date(seed.producerCompletedAt!.getTime() - 30_000);
    const afterCompletion = new Date(seed.producerCompletedAt!.getTime() + 10_000);
    const heartbeatRunId = await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, createdAt: beforeCompletion,
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: seed.qas[0]!.stepRunId,
      issueId: seed.qas[0]!.issueId, heartbeatRunId, createdAt: afterCompletion,
    });
    expect(await detect(db, base)).toHaveLength(0);
  });

  it("keeps structural QA excluded and cancelled runs inert", async () => {
    const structuralBase = await seedQaCapBase(db);
    const structural = await seedQaCapWorkflow(db, structuralBase, {
      iteration: 2, edges: [{ maxIterations: 2, structural: true }],
    });
    await seedOfficialCurrent(db, structuralBase, structural);
    expect(await detect(db, structuralBase)).toHaveLength(0);
    await cleanQaCapFixture(db);

    const cancelledBase = await seedQaCapBase(db);
    const cancelled = await seedQaCapWorkflow(db, cancelledBase, { iteration: 2, runStatus: "cancelled" });
    await seedOfficialCurrent(db, cancelledBase, cancelled);
    expect(await detect(db, cancelledBase)).toHaveLength(0);
  });
});
