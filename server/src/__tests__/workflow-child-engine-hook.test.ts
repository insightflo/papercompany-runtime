// @vitest-environment node
// [workflow child step] executeWorkflowRun 런치 루프 + 공개 resume 거부 통합 테스트(descope v1).
//   type:"workflow" 스텝이 실제 DAG 엔진 경로에서 dispatch 되고 부모가 대기하는지 검증한다.
//   [D3] 공개 resume 는 linked 자식/비정합 child-marked run 을 어떤 부수효과 이전에 typed 거부하고,
//   plain run 은 pre-feature 경로를 유지한다.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { workflowService } from "../services/workflow/engine.js";
import { HttpError } from "../errors.js";
import { configureWorkflowChildFixtures, createCompanyFixture, insertDefinition } from "./helpers/workflow-child-fixtures.js";
import { insertOrphanChildMarkedRun } from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step engine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child step — engine launch loop + resume refusal", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-engine-");
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

  // [descope D1] wait:false fire 엔드투엔드 시나리오는 삭제됐다 — workflow 스텝은 항상 대기한다.
  it("workflow step keeps the parent run running with pending waiting step and a linked child", async () => {
    const companyId = await createCompanyFixture("Engine Wait Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "child-a", name: "Child A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        {
          id: "run-child",
          name: "Run child",
          type: "workflow",
          dependencies: [],
          targetWorkflowId: childDefId,
          wait: true,
        },
      ],
    });

    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    expect(result.status).toBe("running");

    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(stepRun?.status).toBe("pending");
    const workflowChild = (stepRun?.metadata as Record<string, unknown>).workflowChild as Record<string, unknown>;
    expect(typeof workflowChild.childRunId).toBe("string");
    expect(workflowChild.generation).toBe(1);

    const childRuns = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.id).toBe(workflowChild.childRunId);
    expect(childRuns[0]?.parentStepRunId).toBe(stepRun?.id);
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.childRunId).toBe(childRuns[0]?.id);
    expect(invocation?.state).toBe("linked");
  });

  it("public resumeRun refuses a linked child with workflow_child_resume_not_supported before any mutation", async () => {
    const companyId = await createCompanyFixture("Resume Refusal Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "child-a", name: "Child A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        { id: "run-child", name: "Run child", type: "workflow", dependencies: [], targetWorkflowId: childDefId },
      ],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRun).toBeTruthy();

    const snapshotBefore = JSON.stringify({
      run: { ...childRun, createdAt: null, startedAt: null, childStartLeaseExpiresAt: null, childStartDeadlineAt: null, childStartMaterializedAt: null },
      stepRows: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRun.id)),
    });

    let thrown: unknown = null;
    try {
      await workflowService.resumeRun(db, { runId: childRun.id, companyId });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as Error).message).toContain("workflow_child_resume_not_supported");

    // 거부는 어떤 부수효과(정의 검증/리셋/임대/실행)보다 먼저다 — 실행 행 무변경.
    const [childAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, childRun.id));
    const snapshotAfter = JSON.stringify({
      run: { ...childAfter, createdAt: null, startedAt: null, childStartLeaseExpiresAt: null, childStartDeadlineAt: null, childStartMaterializedAt: null },
      stepRows: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRun.id)),
    });
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(result.status).toBe("running");
  });

  it("public resumeRun refuses an incoherent child-marked run with workflow_child_invalid_state", async () => {
    const companyId = await createCompanyFixture("Invalid Child Co");
    const childDefId = await insertDefinition({ companyId, name: "child-wf", steps: [] });
    const parentDefId = await insertDefinition({ companyId, name: "parent-wf", steps: [] });
    const { runId, stepRunId } = await insertParentAndStep(companyId, parentDefId);
    // 부모 표지는 있지만 invocation 링크가 없는 비정합 child-marked run(§2 표 밖 — fail-closed 입력).
    const orphanChildRunId = await insertOrphanChildMarkedRun(db, {
      companyId,
      parentRunId: runId,
      parentStepRunId: stepRunId,
      childWorkflowId: childDefId,
    });

    let thrown: unknown = null;
    try {
      await workflowService.resumeRun(db, { runId: orphanChildRunId, companyId });
    } catch (error) {
      thrown = error;
    }
    // plain fallback 없음 — 표지가 있으면 invalid-child 로 typed 거부된다.
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as Error).message).toContain("workflow_child_invalid_state");
    const [orphanAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, orphanChildRunId));
    expect(orphanAfter?.status).toBe("pending");
    const orphanSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, orphanChildRunId));
    expect(orphanSteps).toHaveLength(0);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
  });

  it("plain (non-child) run resume follows the pre-feature path without child refusal", async () => {
    const companyId = await createCompanyFixture("Plain Resume Co");
    const plainDefId = await insertDefinition({
      companyId,
      name: "plain-wf",
      steps: [{ id: "only-agent", name: "Only Agent", type: "agent", agentId: "", dependencies: [] }],
    });
    const result = await workflowService.trigger(db, {
      workflowId: plainDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    const resumed = await workflowService.resumeRun(db, { runId: result.runId, companyId });
    expect(resumed.runId).toBe(result.runId);
    // plain resume 은 자식 관련 어떤 행도 만들지 않는다.
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    const childRuns = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(0);
  });

  async function insertParentAndStep(companyId: string, parentDefId: string): Promise<{ runId: string; stepRunId: string }> {
    const runId = crypto.randomUUID();
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId: parentDefId,
      companyId,
      status: "running",
      triggeredBy: "board",
      startedAt: new Date(),
    });
    const stepRunId = crypto.randomUUID();
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId: "run-child",
      status: "pending",
    });
    return { runId, stepRunId };
  }
});
