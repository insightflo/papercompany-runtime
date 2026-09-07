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
  assertNoWorkflowChildDefinitionCycles,
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

describeEmbeddedPostgres("workflow-child-execution (guards/caps/cycles)", () => {
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

  it("per-parent concurrent waiting children cap rejects the 6th child", async () => {
    const companyId = await createCompanyFixture("Cap Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        childStep(childDefId),
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `child-sibling-${i}`,
          name: `Sibling ${i}`,
          type: "workflow",
          dependencies: [],
          targetWorkflowId: childDefId,
        })),
      ],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    for (let i = 0; i < 5; i += 1) {
      const siblingChildRunId = randomUUID();
      await db.insert(workflowRuns).values({
        id: siblingChildRunId,
        workflowId: childDefId,
        companyId,
        status: "running",
        triggeredBy: "workflow-step",
        triggerSource: "workflow",
        parentRunId: runId,
        rootRunId: runId,
      });
      const siblingStepRunId = randomUUID();
      await db.insert(workflowStepRuns).values({
        id: siblingStepRunId,
        workflowRunId: runId,
        stepId: `child-sibling-${i}`,
        status: "pending",
        metadata: { workflowChild: { childRunId: siblingChildRunId, generation: 1 } },
      });
      await db.insert(workflowStepInvocations).values({
        companyId,
        parentStepRunId: siblingStepRunId,
        childRunId: siblingChildRunId,
        generation: 1,
      });
    }

    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_concurrency_exceeded" }),
    );
  });

  it("cycle DFS rejects self-reference and true cycles but allows diamonds", () => {
    const defA = randomUUID();
    const defB = randomUUID();
    const defC = randomUUID();

    // self-reference rejected
    const selfSteps = [{ id: "s", name: "S", type: "workflow", dependencies: [], targetWorkflowId: defA }];
    expect(
      assertNoWorkflowChildDefinitionCycles(defA, selfSteps, new Map([[defA, selfSteps]])),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/cycle|self/i)]));

    // A -> B -> A rejected
    const aSteps = [{ id: "w", name: "W", type: "workflow", dependencies: [], targetWorkflowId: defB }];
    const bSteps = [{ id: "w", name: "W", type: "workflow", dependencies: [], targetWorkflowId: defA }];
    expect(
      assertNoWorkflowChildDefinitionCycles(defA, aSteps, new Map([
        [defA, aSteps],
        [defB, bSteps],
      ])),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/cycle/i)]));

    // diamond A -> B -> D, A -> C -> D allowed
    const diamondTarget = randomUUID();
    const aD = [{ id: "w", name: "W", type: "workflow", dependencies: [], targetWorkflowId: defB }, { id: "w2", name: "W2", type: "workflow", dependencies: [], targetWorkflowId: defC }];
    const bD = [{ id: "w", name: "W", type: "workflow", dependencies: [], targetWorkflowId: diamondTarget }];
    const cD = [{ id: "w", name: "W", type: "workflow", dependencies: [], targetWorkflowId: diamondTarget }];
    const dD: unknown[] = [];
    expect(
      assertNoWorkflowChildDefinitionCycles(defA, aD, new Map([
        [defA, aD],
        [defB, bD],
        [defC, cD],
        [diamondTarget, dD],
      ])),
    ).toEqual([]);
  });

  it("cycle DFS at dispatch rejects a two-definition cycle before creating the child", async () => {
    const companyId = await createCompanyFixture("Cycle Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "back", name: "Back", type: "workflow", dependencies: [], targetWorkflowId: null }],
    });
    // make the child target the parent definition — but we don't know parent id before insert; update after
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    await db
      .update(workflowDefinitions)
      .set({ stepsJson: [{ id: "back", name: "Back", type: "workflow", dependencies: [], targetWorkflowId: parentDefId }] })
      .where(eq(workflowDefinitions.id, childDefId));

    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_cycle_detected" }),
    );
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
  });
});
