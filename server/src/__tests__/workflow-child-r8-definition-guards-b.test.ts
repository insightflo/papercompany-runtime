// @vitest-environment node
// [workflow-child r8 finding 1] canonical definition guard — 완전 정산 통제 + 불량 연관
//   fail-closed. /tmp/wfw-fix-design-r8.md §1: 완전 정산+법정 pair 는 실제 보관/삭제가
//   허용되고, 불량 참조(깨진 포인터/회사 불일치/retry 표식/커밋된 claimed/invocation 없는
//   marked 자식/잘못된 부모 방향)는 하나라도 있으면 보수적으로 거부한다. 각 불량 케이스는
//   정산 pair 를 하나씩만 훼손해 그 불량 자체가 거부 원인임을 분리 증명한다.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { HttpError } from "../errors.js";
import { archiveWorkflowDefinitionWithGuard } from "../services/workflow/workflow-definition-delete-guard.js";
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
  insertOrphanChildMarkedRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Scenario = {
  companyId: string;
  parentDefId: string;
  childDefId: string;
  runId: string;
  stepRunId: string;
  childRunId: string;
  invocationId: string;
};

describeEmbeddedPostgres("workflow-child r8 — settled controls & malformed fail-closed", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-defguard-b-");
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

  /** 완전 정산+법정 pair — 영수증 있는 completed C + 종말 S. 이 상태 단독이면 삭제가 허용된다. */
  async function settledLinked(name: string): Promise<Scenario> {
    const companyId = await createCompanyFixture(name);
    const childDefId = await insertDefinition({
      companyId,
      name: "r8-child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({ companyId, name: "r8-parent", steps: [childStep(childDefId)] });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const identity = await insertMaterializedChildRun(db, { companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId });
    await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, identity.childRunId));
    await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, stepRunId));
    return { companyId, parentDefId, childDefId, runId, stepRunId, childRunId: identity.childRunId, invocationId: identity.invocationId };
  }

  async function attemptRemoval(defId: string, mode: "app" | "raw-archive" | "raw-delete"): Promise<unknown> {
    try {
      if (mode === "app") await archiveWorkflowDefinitionWithGuard(db, defId);
      else if (mode === "raw-archive") {
        await db.update(workflowDefinitions).set({ status: "archived", updatedAt: new Date() }).where(eq(workflowDefinitions.id, defId));
      } else await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, defId));
    } catch (error) {
      return error;
    }
    return null;
  }

  async function expectRefusal(defId: string, mode: "app" | "raw-archive" | "raw-delete"): Promise<void> {
    const error = await attemptRemoval(defId, mode);
    expect(error).toBeInstanceOf(Error);
    if (mode === "app") {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
    } else {
      expect((error as { code?: string }).code).toBe("23514");
    }
    expect((error as Error).message).toContain("workflow_definition_has_active_child_invocations");
  }

  async function expectBothDefsRefuse(x: Scenario): Promise<void> {
    for (const defId of [x.parentDefId, x.childDefId]) {
      await expectRefusal(defId, "app");
      await expectRefusal(defId, "raw-archive");
    }
  }

  it("fully settled linked pair allows parent archival and physical target deletion", async () => {
    const x = await settledLinked("SettledLinked");
    expect(await archiveWorkflowDefinitionWithGuard(db, x.parentDefId)).toBe(true);
    const deleted = await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, x.childDefId)).returning({ id: workflowDefinitions.id });
    expect(deleted).toHaveLength(1);
    // 자식 run 은 정의 삭제로 사라지지만 invocation 은 보존 신원(FK SET NULL)과 이력을 유지한다.
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId))).toHaveLength(0);
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, x.invocationId));
    expect(invocation?.state).toBe("linked");
    expect(invocation?.childRunId).toBeNull();
    expect(invocation?.targetWorkflowId).toBe(x.childDefId);
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(s?.status).toBe("completed");
  });

  it("fully settled tombstone allows target deletion and parent archival", async () => {
    const x = await settledLinked("SettledTombstone");
    await db.delete(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    await db.update(workflowStepInvocations).set({ childRunId: null }).where(eq(workflowStepInvocations.id, x.invocationId));
    const deleted = await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, x.childDefId)).returning({ id: workflowDefinitions.id });
    expect(deleted).toHaveLength(1);
    expect(await archiveWorkflowDefinitionWithGuard(db, x.parentDefId)).toBe(true);
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, x.invocationId));
    expect(invocation?.childRunId).toBeNull();
    expect(invocation?.targetWorkflowId).toBe(x.childDefId);
  });

  it("broken child parent pointer fails closed on a settled pair", async () => {
    const x = await settledLinked("BrokenPointer");
    await db.update(workflowRuns).set({ parentRunId: null }).where(eq(workflowRuns.id, x.childRunId));
    await expectBothDefsRefuse(x);
  });

  it("foreign-company invocation targeting this definition blocks the target definition", async () => {
    const x = await settledLinked("ForeignTarget");
    const foreignCompany = await createCompanyFixture("Foreign Co");
    const foreignParentDefId = await insertDefinition({ companyId: foreignCompany, name: "foreign-parent", steps: [childStep(x.childDefId)] });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId: foreignCompany, workflowId: foreignParentDefId });
    await insertLinkedInvocation(db, { companyId: foreignCompany, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: x.childDefId });
    await expectRefusal(x.childDefId, "app");
    await expectRefusal(x.childDefId, "raw-delete");
  });

  it("retry marker on S fails closed on a settled pair", async () => {
    const x = await settledLinked("RetryMarker");
    await db.update(workflowStepRuns).set({ metadata: { workflowRetry: { attempt: 1 } } }).where(eq(workflowStepRuns.id, x.stepRunId));
    await expectBothDefsRefuse(x);
  });

  it("committed claimed corruption row fails closed (replica-role isolated setup)", async () => {
    const x = await settledLinked("CommittedClaimed");
    const claimedStepRunId = await insertStepRunForRun({ runId: x.runId, stepId: "claimed-step" });
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.insert(workflowStepInvocations).values({
        companyId: x.companyId,
        parentStepRunId: claimedStepRunId,
        childRunId: null,
        state: "claimed",
        generation: 1,
        targetWorkflowId: x.childDefId,
      });
    });
    await expectBothDefsRefuse(x);
  });

  it("marked terminal child run with missing invocation fails closed on both sides", async () => {
    const x = await settledLinked("OrphanMarked");
    const orphanRunId = await insertOrphanChildMarkedRun(db, {
      companyId: x.companyId,
      parentRunId: x.runId,
      parentStepRunId: x.stepRunId,
      childWorkflowId: x.childDefId,
    });
    await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, orphanRunId));
    await expectBothDefsRefuse(x);
  });

  it("child parent_run_id pointing at a foreign run fails closed (wrong-parent A)", async () => {
    const x = await settledLinked("WrongParentRun");
    const stranger = await insertRunWithWorkflowStepRun({ companyId: x.companyId, workflowId: x.childDefId, stepId: "stray" });
    await db.update(workflowRuns).set({ parentRunId: stranger.runId }).where(eq(workflowRuns.id, x.childRunId));
    await expectBothDefsRefuse(x);
  });

  it("child parent_step_run_id pointing at a foreign step fails closed (wrong-parent B)", async () => {
    const x = await settledLinked("WrongParentStep");
    const strayStepRunId = await insertStepRunForRun({ runId: x.runId, stepId: "stray-step" });
    await db.update(workflowRuns).set({ parentStepRunId: strayStepRunId }).where(eq(workflowRuns.id, x.childRunId));
    await expectBothDefsRefuse(x);
  });
});
