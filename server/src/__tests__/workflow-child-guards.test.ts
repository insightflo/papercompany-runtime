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
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation, insertMaterializedChildRun, insertTombstoneInvocation } from "./helpers/workflow-child-invocation-fixtures.js";

let db: Awaited<ReturnType<typeof createDb>>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow-child-guards (cycles/caps/v1 refusals)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-guards-");
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

  it("per-parent cap counts 5 committed invocations on pending steps and atomically rejects the 6th", async () => {
    const companyId = await createCompanyFixture("Cap Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const siblingIds = Array.from({ length: 5 }, (_, i) => `child-sibling-${i}`);
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId), ...siblingIds.map((id) => ({
        id,
        name: id,
        type: "workflow",
        dependencies: [],
        targetWorkflowId: childDefId,
      }))],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    // 5 pending sibling steps with committed invocations in MIXED projection states (r3 UnadoptedCap):
    // adopted+materialized / unadopted+materialized / unadopted+linked-pending / tombstone 등.
    for (let i = 0; i < 5; i += 1) {
      const siblingStepRunId = await insertStepRunForRun({ runId, stepId: siblingIds[i]! });
      if (i === 0) {
        // adopted + materialized child
        await insertMaterializedChildRun(db, {
          companyId,
          parentRunId: runId,
          parentStepRunId: siblingStepRunId,
          childWorkflowId: childDefId,
          stepId: siblingIds[i]!,
        });
        const [sibling] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, siblingStepRunId));
        const [invocation] = await db.select().from(workflowStepInvocations)
          .where(eq(workflowStepInvocations.parentStepRunId, siblingStepRunId));
        await db.update(workflowStepRuns).set({ metadata: {
          ...(sibling?.metadata ?? {}),
          workflowChild: { childRunId: invocation?.childRunId, invocationId: invocation?.id, generation: 1 },
        } }).where(eq(workflowStepRuns.id, siblingStepRunId));
      } else if (i === 1) {
        // unadopted + materialized child
        await insertMaterializedChildRun(db, {
          companyId,
          parentRunId: runId,
          parentStepRunId: siblingStepRunId,
          childWorkflowId: childDefId,
          stepId: siblingIds[i]!,
        });
      } else if (i < 4) {
        // unadopted + linked pending children
        await insertLinkedInvocation(db, {
          companyId,
          parentRunId: runId,
          parentStepRunId: siblingStepRunId,
          childWorkflowId: childDefId,
          stepId: siblingIds[i]!,
        });
      } else {
        // settled 되지 않은 tombstone — pending 부모 스텝의 invocation 도 cap 에 섞인다.
        await insertTombstoneInvocation(db, { companyId, parentStepRunId: siblingStepRunId, targetWorkflowId: childDefId });
      }
    }

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_concurrency_exceeded" }),
    );
    // 원자 거부 — 6번째 invocation/자식 run 은 존재하지 않는다(커밋된 5개만).
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
    const childRuns = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(4);
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

  // [descope v1 D1/D2] wait:false / retry 정책은 dispatch 사전검사에서 클레임 이전에 기계 거부된다.
  it.each([
    ["wait:false", { wait: false }],
    ["onFailure:retry", { onFailure: "retry" }],
    ["maxRetries:0", { maxRetries: 0 }],
    ["graphRetryDelaySeconds:0", { graphRetryDelaySeconds: 0 }],
    ["graphRetryBackoff", { graphRetryBackoff: "fixed" }],
    ["graphRetryJitter:false", { graphRetryJitter: false }],
  ])("refuses workflow step with unsupported option %s before any claim", async (_label, option) => {
    const companyId = await createCompanyFixture(`Refusal ${_label.replace(/\W+/g, "")}`);
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [{ id: "run-child", name: "Run child", type: "workflow", dependencies: [], targetWorkflowId: randomUUID(), ...option }],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0], now: new Date() })).toBe(false);
    const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((failed?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "workflow_child_unsupported_option" }),
    );
    // R-클래스 증거 — 클레임 이전 거부: invocation/자식 run 행 0개.
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    const childRuns = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(0);
  });
});
