// @vitest-environment node
// [workflow-child fix round 3] P2 회귀: durable admission(cap) + invalid-charset childInputs 토큰.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
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
import {
  dispatchWorkflowChildStep,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  normalizeWorkflowStepsForExecution,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child fix round 3 — P2 semantics", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix3-sem-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
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

  type Linked = {
    companyId: string;
    runId: string;
    stepRunId: string;
    childRunId: string;
    childDefId: string;
    invocationId: string;
  };

  async function linked(name: string, opts: { adopted?: boolean; childStatus?: string } = {}): Promise<Linked> {
    const companyId = await createCompanyFixture(name);
    const childDefId = await insertDefinition({
      companyId,
      name: "child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const childRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: childRunId,
      workflowId: childDefId,
      companyId,
      status: opts.childStatus ?? "pending",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
    });
    const [inv] = await db.insert(workflowStepInvocations).values({
      companyId,
      parentStepRunId: stepRunId,
      childRunId,
      generation: 1,
      state: "linked",
      wait: true,
    }).returning();
    if (opts.adopted ?? true) {
      await db.update(workflowStepRuns).set({
        metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1, wait: true } },
      }).where(eq(workflowStepRuns.id, stepRunId));
    }
    return { companyId, runId, stepRunId, childRunId, childDefId, invocationId: inv.id };
  }

  /** 프로브 capSetup 의 반대: 5개 커밋된 wait:true(입양 혼합) + 6번째 신규/널클레임 dispatch. */
  async function capSetup(withNullClaim: boolean): Promise<{ runId: string; companyId: string; childDefId: string; sixthStepRunId: string; steps: Array<Record<string, unknown>> }> {
    const x = await linked("R3Cap", { adopted: false });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const steps = Array.from({ length: 6 }, (_, i) => ({
      ...childStep(x.childDefId),
      id: i === 0 ? "run-child" : `s${i}`,
      name: `S${i}`,
    }));
    await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, run!.workflowId));
    for (let i = 1; i < 5; i++) {
      const id = randomUUID();
      const childRunId = randomUUID();
      await db.insert(workflowStepRuns).values({ id, workflowRunId: x.runId, stepId: `s${i}`, status: "pending", metadata: {} });
      await db.insert(workflowRuns).values({
        id: childRunId, workflowId: x.childDefId, companyId: x.companyId, status: "pending",
        triggeredBy: "workflow-step", triggerSource: "workflow", parentRunId: x.runId, parentStepRunId: id,
      });
      // 커밋된 클레임(부모 잠금 트랜잭션과 동일한 최종 상태): wait=true + linked.
      await db.insert(workflowStepInvocations).values({
        companyId: x.companyId, parentStepRunId: id, childRunId, generation: 1, state: "linked", wait: true,
      });
      // 입양 메타데이터는 일부만 존재(혼합 상태 — 커밋 기반 카운트가 이를 무시하지 않아야 한다).
      if (i < 3) {
        await db.update(workflowStepRuns).set({
          metadata: { workflowChild: { childRunId, invocationId: randomUUID(), generation: 1, wait: true } },
        }).where(eq(workflowStepRuns.id, id));
      }
    }
    const [stepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: x.runId, stepId: "s5", status: "pending" }).returning();
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    if (withNullClaim) {
      await db.insert(workflowStepInvocations).values({
        companyId: x.companyId, parentStepRunId: stepRun.id, childRunId: null, generation: 1, state: "claimed", wait: true,
      });
    }
    return { runId: x.runId, companyId: x.companyId, childDefId: x.childDefId, sixthStepRunId: stepRun.id, steps };
  }

  it("reg UnadoptedCap: five committed wait:true requests reject a sixth wait:true dispatch (P2-5)", async () => {
    const x = await capSetup(false);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    const dispatched = await dispatchWorkflowChildStep({
      db, run: run!, definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson).find((s) => s.id === "s5")!,
      stepRun: stepRun!, now: new Date(),
    });
    expect(dispatched).toBe(false);
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
    expect(children).toHaveLength(5);
    const [sixth] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    expect(sixth?.status).toBe("failed");
    expect((sixth?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_concurrency_exceeded" }));
  });

  it("reg NullClaimCap: claimed-null recovery applies the cap against five committed waits (P2-5)", async () => {
    const x = await capSetup(true);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    const dispatched = await dispatchWorkflowChildStep({
      db, run: run!, definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson).find((s) => s.id === "s5")!,
      stepRun: stepRun!, now: new Date(),
    });
    expect(dispatched).toBe(false);
    await reconcileWorkflowChildStepWaits(db);
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
    expect(children).toHaveLength(5);
    const [sixth] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    expect(sixth?.status).toBe("failed");
  });

  it("reg BadToken: invalid-charset childInputs token never reaches the executor (P2-6)", async () => {
    const companyId = await createCompanyFixture("R3BadToken");
    const executor = vi.fn().mockResolvedValue({ accepted: true, ok: true });
    setWorkflowToolStepExecutor(executor);
    const childDefId = await insertDefinition({
      companyId,
      name: "toolchild",
      steps: [{
        id: "t", name: "T", type: "tool", agentId: "", dependencies: [],
        toolNames: ["echo-tool"], toolArgs: { q: "{$childInputs.customer-id}" },
      }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent",
      steps: [childStep(childDefId, { inputs: {} })],
    });
    await workflowService.trigger(db, { workflowId: parentDefId, companyId, triggeredBy: "board", triggerSource: "api" });
    await processQueuedWorkflowToolStepRuns(db);
    expect(executor).not.toHaveBeenCalled();
    const childRun = (await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow"))))[0];
    const [childStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRun?.id ?? ""));
    expect(childStepRun?.status).toBe("failed");
  });
});
