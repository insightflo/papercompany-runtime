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
  isWorkflowChildStep,
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

describeEmbeddedPostgres("workflow-child-execution (dispatch)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-dispatch-");
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

  it("isWorkflowChildStep detects workflow-type steps only", () => {
    const steps = normalizeWorkflowStepsForExecution([
      { id: "w", name: "W", type: "workflow", targetWorkflowId: randomUUID() },
      { id: "a", name: "A", type: "agent", agentId: "" },
      { id: "t", name: "T", type: "tool", toolNames: ["some-tool"] },
    ]);
    expect(steps.map(isWorkflowChildStep)).toEqual([true, false, false]);
  });

  it("dispatches wait:false child immediately and completes the step with childRunId", async () => {
    const companyId = await createCompanyFixture("Fire Forget Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId, { wait: false })],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      metadata: {},
    });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));

    const dispatched = await dispatchWorkflowChildStep({
      db,
      run,
      definition,
      step: normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!,
      stepRun,
      now: new Date(),
    });
    expect(dispatched).toBe(true);

    const [storedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(storedStepRun?.status).toBe("completed");
    expect((storedStepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: true }),
    );

    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRun).toBeTruthy();
    expect(childRun?.parentRunId).toBe(runId);
    expect(childRun?.rootRunId).toBe(runId);
    expect(childRun?.parentStepRunId).toBe(stepRunId);

    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.childRunId).toBe(childRun?.id);
    expect(invocation?.generation).toBe(1);
  });

  it("keeps wait:true step pending with waiting metadata and idempotently reuses the same child on re-dispatch", async () => {
    const companyId = await createCompanyFixture("Waiter Co");
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
    const loadStepRun = async () =>
      (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];

    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: await loadStepRun(), now: new Date() })).toBe(true);

    const [childRun1] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));

    // Re-dispatch (same attempt): must reuse the existing child, not create another.
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: await loadStepRun(), now: new Date() })).toBe(true);

    const childRuns = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(1);

    const storedStepRun = await loadStepRun();
    expect(storedStepRun?.status).toBe("pending");
    const workflowChild = (storedStepRun?.metadata as Record<string, unknown>).workflowChild as Record<string, unknown>;
    expect(workflowChild.childRunId).toBe(childRun1?.id);
    expect(workflowChild.generation).toBe(1);
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.childRunId).toBe(childRun1?.id);
  });

  it("fails closed with child_inputs_unresolved when a token cannot render", async () => {
    const companyId = await createCompanyFixture("Strict Token Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId, { inputs: { q: "{$runMetadata.missing_key}" } })],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;

    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);

    const [storedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(storedStepRun?.status).toBe("failed");
    expect((storedStepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_inputs_unresolved" }),
    );
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
  });

  it("fails with child_workflow_not_found when the target is missing or cross-company", async () => {
    const companyId = await createCompanyFixture("Missing Target Co");
    const otherCompanyId = await createCompanyFixture("Other Co");
    const foreignDefId = await insertDefinition({
      companyId: otherCompanyId,
      name: "foreign-wf",
      steps: [],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(randomUUID())],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed1] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed1?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_workflow_not_found" }),
    );

    // reset step run, target a foreign-company definition
    await db.update(workflowStepRuns).set({ status: "pending", metadata: {} }).where(eq(workflowStepRuns.id, stepRunId));
    const parentDefId2 = await insertDefinition({
      companyId,
      name: "parent-wf-2",
      steps: [childStep(foreignDefId)],
    });
    const [definition2] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId2));
    const step2 = normalizeWorkflowStepsForExecution(definition2.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition: definition2, step: step2, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed2] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed2?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_workflow_not_found" }),
    );
  });

  it("fails with child_depth_exceeded beyond depth 3", async () => {
    const companyId = await createCompanyFixture("Deep Co");
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
    // 실제 3단계 부모 체인(root → mid → parent run)을 구성한다.
    const rootRunId = randomUUID();
    const midRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: rootRunId,
      workflowId: parentDefId,
      companyId,
      status: "completed",
      triggeredBy: "board",
    });
    await db.insert(workflowRuns).values({
      id: midRunId,
      workflowId: parentDefId,
      companyId,
      status: "completed",
      triggeredBy: "board",
      parentRunId: rootRunId,
      rootRunId,
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      parentRunId: midRunId,
      rootRunId,
    });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_depth_exceeded" }),
    );
  });

});
