// @vitest-environment node
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

import { agents } from "@paperclipai/db";
import {
  dispatchWorkflowChildStep,
  reconcileWorkflowChildStepWaits,
  runWorkflowChildCompletionHook,
  isWorkflowChildStep,
  assertNoWorkflowChildDefinitionCycles,
} from "../services/workflow/workflow-child-execution.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

let db: Awaited<ReturnType<typeof createDb>>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow-child-execution (completion/recovery/cycles)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-recovery-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("propagates child terminal state to the waiting parent step via the completion hook", async () => {
    const companyId = await createCompanyFixture("Hook Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    const stepRun = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
    await dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() });

    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));

    // child failed → parent step failed child_run_failed
    await db
      .update(workflowRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun!.id));
    await runWorkflowChildCompletionHook(db, {
      id: childRun!.id,
      companyId: childRun!.companyId,
      status: "failed",
    });
    const [failedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(failedStepRun?.status).toBe("failed");
    expect((failedStepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_run_failed" }),
    );
  });

  it("cancelled child completes the waiting parent step with child_run_cancelled", async () => {
    const companyId = await createCompanyFixture("Cancel Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() });
    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    // fix round 계약: 훅은 호출자 status 를 신뢰하지 않고 자식 run 의 영속 종말 상태를 재조회한다 —
    // 먼저 자식 run 행을 cancelled 로 영속화한다(미영속 합성 status 는 무시된다).
    await db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(workflowRuns.id, childRun!.id));
    await runWorkflowChildCompletionHook(db, {
      id: childRun!.id,
      companyId: childRun!.companyId,
      status: "cancelled",
    });
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("failed");
    expect((stepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_run_cancelled" }),
    );
  });

  it("ignores a stale hook from a superseded generation (per-generation CAS)", async () => {
    const companyId = await createCompanyFixture("Stale Hook Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    const stepRun = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
    await dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() });
    const [childRun1] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));

    // Retry: policy retry bumps generation and creates a new child (simulated by a CAS'd re-dispatch with retryCount=1)
    await db
      .update(workflowStepRuns)
      .set({ status: "pending", retryCount: 1, metadata: {} })
      .where(eq(workflowStepRuns.id, stepRunId));
    const childRunsBefore = (await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")))).length;
    expect(childRunsBefore).toBe(1);
    await dispatchWorkflowChildStep({
      db,
      run,
      definition,
      step,
      stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0],
      now: new Date(),
    });
    const childRunsAfter = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRunsAfter).toHaveLength(2);
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.generation).toBe(2);

    // stale hook for generation-1 child must NOT complete the step
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun1!.id));
    await runWorkflowChildCompletionHook(db, {
      id: childRun1!.id,
      companyId: childRun1!.companyId,
      status: "completed",
    });
    const [pendingStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(pendingStepRun?.status).toBe("pending");
  });

  it("reconciler heals an orphaned wait: child terminal while parent step pending", async () => {
    const companyId = await createCompanyFixture("Reconcile Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    const stepRun = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
    await dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() });
    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    // simulate age for the reconciler cutoff
    await db
      .update(workflowStepRuns)
      .set({ lastDispatchAttemptAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(workflowStepRuns.id, stepRunId));
    // child completed out-of-band
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun!.id));

    const results = await reconcileWorkflowChildStepWaits(db, { now: new Date() });
    expect(results.length).toBeGreaterThan(0);
    const [healedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(healedStepRun?.status).toBe("completed");
  });

});
