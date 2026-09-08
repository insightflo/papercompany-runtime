// @vitest-environment node
// [workflow-child fix round / descope v1] P1-4 크래시 회복 검증(stuck 경계는 fix-round-stuck 분할).
//   클레임은 단일 트랜잭션으로 원자 커밋되므로 "claimed+NULL 크래시" 상태는 기계적으로 불가능하다
//   (설계 §2) — 지원되는 크래시 회복은 커밋된 linked 자식의 1회 초기화/입양이고, 비정합 상태는
//   typed invalid-state 진단으로 거부된다(행 무변경). /tmp/task-spec-wfw-fix.txt + 설계 §5/§6.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  toolDefinitions,
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
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { WORKFLOW_CHILD_MAX_DEPTH, runDepthOfParentRun } from "../services/workflow/workflow-child-guards.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation,
  insertOrphanChildMarkedRun,
  type WorkflowChildIdentityFixture,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child fix round — recovery", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-recovery-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await db.delete(toolDefinitions);
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

  /** 법정 linked 자식 — 클레임 트랜잭션의 원자 커밋 결과(유일한 legal 생성 경로). */
  async function linkedChild(name: string): Promise<{
    companyId: string; runId: string; stepRunId: string; childDefId: string; identity: WorkflowChildIdentityFixture;
  }> {
    const companyId = await createCompanyFixture(name);
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
    const identity = await insertLinkedInvocation(db, {
      companyId,
      parentRunId: runId,
      parentStepRunId: stepRunId,
      childWorkflowId: childDefId,
    });
    return { companyId, runId, stepRunId, childDefId, identity };
  }

  async function executionSnapshot(stepRunId: string): Promise<string> {
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const [invocation] = await db.select().from(workflowStepInvocations);
    return JSON.stringify({ stepRun: stepRun ?? null, invocation: invocation ?? null });
  }

  it("recovers a committed linked claim that never started — mid-claim crash adaptation (P1-4)", async () => {
    // 클레임은 원자 커밋이다: 크래시 창에서 생존하는 것은 "커밋된 linked 자식, 미시작/미입양".
    const x = await linkedChild("Fix Crash Co");
    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results[0]?.action).toBe("recovered");

    const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(childRun?.status).toBe("running");
    expect(childRun?.childStartMaterializedAt).not.toBeNull();
    expect(childRun?.parentRunId).toBe(x.runId);
    expect(childRun?.missionId).toBeNull();
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect((stepRun?.metadata as Record<string, unknown>).workflowChild).toEqual(
      expect.objectContaining({ childRunId: x.identity.childRunId, generation: 1 }),
    );
    // 두 번째 패스는 수렴 — healthy 상태에서 추가 소유 진행 없다.
    const second = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(second.filter((r) => r.action === "recovered")).toHaveLength(0);
  });

  it("converts illegal retry-state waits to invalid-state diagnostics with rows unchanged", async () => {
    // [구 claimed+NULL 크래시 픽스처의 R 전환] 커밋된 비정합은 존재할 수 없으므로, 패브릭 가능한
    //   비정합(S retry 상태)로 fail-closed 경계를 검증한다 — 수리/실행 없이 구조화 진단만.
    const x = await linkedChild("Fix Illegal Co");
    await db.update(workflowStepRuns).set({
      metadata: {
        workflowRetry: {
          state: "waiting", retryNumber: 1, maxRetries: 2,
          nextEligibleAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    const before = await executionSnapshot(x.stepRunId);

    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    const diagnostic = results.find((r) => r.stepRunId === x.stepRunId);
    expect(diagnostic).toEqual(expect.objectContaining({
      action: "skipped",
      code: "parent_step_retry_state_present",
    }));
    expect(results.some((r) => r.action === "recovered")).toBe(false);
    expect(await executionSnapshot(x.stepRunId)).toBe(before);
  });

  it("executes and adopts a committed-but-never-started child after a trigger crash (P1-4)", async () => {
    const x = await linkedChild("Fix Orphan Co");
    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results[0]?.action).toBe("recovered");

    const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(childRun?.status).toBe("running");
    const childSteps = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, x.identity.childRunId));
    expect(childSteps.length).toBeGreaterThan(0);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect((stepRun?.metadata as Record<string, unknown>).workflowChild).toBeTruthy();
  });

  it("fails closed on cross-company ancestry in the depth walker (verifier edge)", async () => {
    const companyIdA = await createCompanyFixture("Fix Depth A");
    const companyIdB = await createCompanyFixture("Fix Depth B");
    const foreignDefId = await insertDefinition({ companyId: companyIdB, name: "foreign-wf", steps: [] });
    const foreignRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: foreignRunId,
      workflowId: foreignDefId,
      companyId: companyIdB,
      status: "running",
      triggeredBy: "board",
    });
    const depth = await runDepthOfParentRun(db, {
      parentRunId: foreignRunId,
      rootRunId: null,
      companyId: companyIdA,
    });
    expect(depth).toBeGreaterThan(WORKFLOW_CHILD_MAX_DEPTH);
    void companyIdA;
    void normalizeWorkflowStepsForExecution;
    void insertOrphanChildMarkedRun;
  });
});
