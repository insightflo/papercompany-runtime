// @vitest-environment node
// [workflow child step] executeWorkflowRun 런치 루프 통합 테스트(0101).
//   type:"workflow" 스텝이 실제 DAG 엔진 경로에서 dispatch 되고, wait 모드별로
//   런/스텝 상태가 계약대로 성립하는지 검증한다. 마감(hook)은 unit 파일에서 커버.
import { randomUUID } from "node:crypto";
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
import { configureWorkflowChildFixtures, createCompanyFixture, insertDefinition } from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step engine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child step — engine launch loop", () => {
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

  it("wait:false workflow step completes the run end-to-end through the launch loop", async () => {
    const companyId = await createCompanyFixture("Engine Fire Co");
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
          wait: false,
        },
      ],
    });

    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    expect(result.status).toBe("completed");

    const childRuns = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]?.parentRunId).toBe(result.runId);
    expect(childRuns[0]?.rootRunId).toBe(result.runId);

    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(stepRun?.status).toBe("completed");

    // activity log: workflow_run.created (triggerSource workflow + 부모 연결 상세)
    const logRows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "workflow_run.created")));
    const childLog = logRows.find((row) => row.entityId === childRuns[0]?.id);
    expect(childLog).toBeTruthy();
    expect((childLog?.details as Record<string, unknown>).triggerSource).toBe("workflow");
    expect((childLog?.details as Record<string, unknown>).parentRunId).toBe(result.runId);
  });

  it("wait:true workflow step keeps the parent run running with pending waiting step", async () => {
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
    expect(randomUUID).toBeTruthy(); // keep import used
  });
});
