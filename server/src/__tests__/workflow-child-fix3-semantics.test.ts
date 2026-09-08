// @vitest-environment node
// [workflow-child fix round 3 / descope v1] P2 회귀: durable admission(cap) + invalid-charset
//   childInputs 토큰 + 커밋된 claimed 행의 기계적 불가능성. cap 은 커밋된 invocation 기준으로
//   자식 상태/입양/톰스톤을 구분하지 않고, 부모 잠금 하 원자적으로 집계된다(경쟁에서도 <=5).
//   /tmp/task-spec-wfw-fix3.txt + 설계 §5/§6 S/R 처분.
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
  dispatchWorkflowChildStepWithOutcome,
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
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation,
  insertMaterializedChildRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";

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

  /**
   * 5개의 커밋된 invocation(혼합 자식 상태: linked 3 + materialized 1 + tombstone 1 — 톰스톤도
   * pending S 정산 전까지 cap 을 점유한다, 설계 §3) + 6번째 미클레임 pending 스텝.
   */
  async function capSetup(): Promise<{ runId: string; companyId: string; childDefId: string; sixthStepRunId: string }> {
    const companyId = await createCompanyFixture("R3Cap");
    const childDefId = await insertDefinition({
      companyId,
      name: "child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent",
      // 정의 stepsJson 도 전체 스텝 집합을 포함해야 한다 — dispatch 스텝 lookup 은 정의 기준.
      steps: Array.from({ length: 6 }, (_, i) => ({
        ...childStep(childDefId),
        id: i === 0 ? "run-child" : i === 5 ? "s5" : `s${i}`,
        name: `S${i}`,
      })),
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    });
    for (let i = 1; i <= 2; i += 1) {
      const siblingStepRunId = await insertStepRunForRun({ runId, stepId: `s${i}` });
      await insertLinkedInvocation(db, {
        companyId, parentRunId: runId, parentStepRunId: siblingStepRunId, childWorkflowId: childDefId,
      });
    }
    const materializedStepRunId = await insertStepRunForRun({ runId, stepId: "s3" });
    await insertMaterializedChildRun(db, {
      companyId, parentRunId: runId, parentStepRunId: materializedStepRunId, childWorkflowId: childDefId,
    });
    const tombstoneStepRunId = await insertStepRunForRun({ runId, stepId: "tomb" });
    await insertTombstoneInvocation(db, { companyId, parentStepRunId: tombstoneStepRunId, targetWorkflowId: childDefId });
    const sixthStepRunId = await insertStepRunForRun({ runId, stepId: "s5" });
    return { runId, companyId, childDefId, sixthStepRunId };
  }

  async function dispatchStep(input: { runId: string; stepRunId: string; stepId: string }) {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, input.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, input.stepRunId));
    return await dispatchWorkflowChildStepWithOutcome(db, {
      run: run!,
      definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson).find((s) => s.id === input.stepId)!,
      stepRun: stepRun!,
      now: new Date(),
    });
  }

  it("reg UnadoptedCap: five committed invocations in mixed child states reject a sixth dispatch (P2-5)", async () => {
    const x = await capSetup();
    const dispatched = await dispatchStep({ runId: x.runId, stepRunId: x.sixthStepRunId, stepId: "s5" });
    expect(dispatched.outcome).toBe("failed");
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
    // 자식 run 은 4개(tombstone 은 run 이 없다) — invocation 5개가 cap 을 채운다.
    expect(children).toHaveLength(4);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
    const [sixth] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    expect(sixth?.status).toBe("failed");
    expect((sixth?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_concurrency_exceeded" }));
  });

  it("reg NullClaimCap: committed claimed rows are mechanically impossible; the cap race stays <=5 (P2-5)", async () => {
    // (a) [R — 명시적으로 검증하는 경계가 바로 이 제약이다] 커밋 시점 deferred 트리거가
    //     claimed+NULL 의 커밋을 거부한다(워크플로 오류 23514).
    const companyId = await createCompanyFixture("R3NullClaim");
    const childDefId = await insertDefinition({ companyId, name: "child", steps: [] });
    const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    await expect(db.transaction(async (tx) => {
      await tx.insert(workflowStepInvocations).values({
        companyId,
        parentStepRunId: stepRunId,
        childRunId: null,
        state: "claimed",
        generation: 1,
        targetWorkflowId: childDefId,
      });
    })).rejects.toThrow(/workflow_step_invocation_committed_non_linked/);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);

    // (b) legal cap 경쟁 — 가득 찬 cap 에서 두 병렬 dispatch 도 <=5 를 유지한다.
    const x = await capSetup();
    const outcomes = await Promise.allSettled([
      dispatchStep({ runId: x.runId, stepRunId: x.sixthStepRunId, stepId: "s5" }),
      dispatchStep({ runId: x.runId, stepRunId: x.sixthStepRunId, stepId: "s5" }),
    ]);
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
    expect(children).toHaveLength(4);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
    const [sixth] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.sixthStepRunId));
    expect(sixth?.status).toBe("failed");
    expect((sixth?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_concurrency_exceeded" }));
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
