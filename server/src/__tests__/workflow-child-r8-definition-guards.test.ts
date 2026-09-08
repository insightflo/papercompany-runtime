// @vitest-environment node
// [workflow-child r8 finding 1] canonical definition guard matrix — /tmp/wfw-fix-design-r8.md §1.
//   캐논컬 함수 workflow_definition_has_active_child_invocations() 하나가 앱(app-archive)과
//   양쪽 트리거(raw-archive / raw-delete)를 모두 방어한다. 미정산 연관 행이 하나라도 있으면
//   부모/대상 정의의 보관·삭제를 전부 거부하고 모든 행(P/S/I/C/정의)을 보존해야 한다.
//   0101: target_workflow_id NOT NULL(23502) + 대상 신원 불변 트리거(23514) 경계도 여기서.
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
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
  insertChildStartLease,
  insertLinkedInvocation,
  insertMaterializedChildRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow-child r8 — canonical definition guards", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-defguard-");
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

  /** 미정산 상태 — S.pending 이므로 어떤 조합도 보관/삭제되면 안 된다. */
  type UnsettledState =
    | "pending-c"
    | "running-initializing-c"
    | "running-materialized-c"
    | "completed-unsettled-c"
    | "failed-unsettled-c"
    | "receipted-terminal-c"
    | "pending-tombstone";
  const UNSETTLED_STATES: UnsettledState[] = [
    "pending-c",
    "running-initializing-c",
    "running-materialized-c",
    "completed-unsettled-c",
    "failed-unsettled-c",
    "receipted-terminal-c",
    "pending-tombstone",
  ];

  type Scenario = {
    companyId: string;
    parentDefId: string;
    childDefId: string;
    runId: string;
    stepRunId: string;
    childRunId: string | null;
    invocationId: string;
    childStatus: string | null;
  };

  async function unsettledScenario(name: string, state: UnsettledState): Promise<Scenario> {
    const companyId = await createCompanyFixture(name);
    const childDefId = await insertDefinition({
      companyId,
      name: "r8-child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({ companyId, name: "r8-parent", steps: [childStep(childDefId)] });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    if (state === "pending-tombstone") {
      const tomb = await insertTombstoneInvocation(db, { companyId, parentStepRunId: stepRunId, targetWorkflowId: childDefId });
      return { companyId, parentDefId, childDefId, runId, stepRunId, childRunId: null, invocationId: tomb.invocationId, childStatus: null };
    }
    let childStatus: string | null = "pending";
    let childRunId: string;
    let invocationId: string;
    if (state === "running-initializing-c") {
      const identity = await insertLinkedInvocation(db, { companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId });
      await insertChildStartLease(db, { childRunId: identity.childRunId, mode: "active" });
      ({ childRunId, invocationId } = identity);
      childStatus = "running";
    } else if (state === "running-materialized-c") {
      const identity = await insertMaterializedChildRun(db, { companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId });
      ({ childRunId, invocationId } = identity);
      childStatus = "running";
    } else {
      const identity = await insertLinkedInvocation(db, { companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId });
      ({ childRunId, invocationId } = identity);
      if (state === "completed-unsettled-c") {
        childStatus = "completed";
        await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, childRunId));
      } else if (state === "failed-unsettled-c") {
        childStatus = "failed";
        await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, childRunId));
      } else if (state === "receipted-terminal-c") {
        // BUG#1 재현 상태 — 영수증 있는 종말 C, 단 S.pending(원래 프로브는 이 상태에서 통과했었다).
        childStatus = "completed";
        await db.update(workflowRuns).set({ status: "completed", childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, childRunId));
      }
    }
    return { companyId, parentDefId, childDefId, runId, stepRunId, childRunId, invocationId, childStatus };
  }

  type RemovalOp = "app-archive" | "raw-archive" | "raw-delete";

  async function attemptRemoval(op: RemovalOp, defId: string): Promise<unknown> {
    try {
      if (op === "app-archive") await archiveWorkflowDefinitionWithGuard(db, defId);
      else if (op === "raw-archive") {
        await db.update(workflowDefinitions).set({ status: "archived", updatedAt: new Date() }).where(eq(workflowDefinitions.id, defId));
      } else await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, defId));
    } catch (error) {
      return error;
    }
    return null;
  }

  const OPS: RemovalOp[] = ["app-archive", "raw-archive", "raw-delete"];
  const MATRIX = UNSETTLED_STATES.flatMap((state) =>
    (["parent", "target"] as const).flatMap((side) => OPS.map((op) => ({ state, side, op }))),
  );

  it.each(MATRIX)("$state: $side $op refuses and preserves every row", async ({ state, side, op }) => {
    const x = await unsettledScenario(`${state}-${side}-${op}`.replace(/\W+/g, ""), state);
    const error = await attemptRemoval(op, side === "parent" ? x.parentDefId : x.childDefId);
    expect(error).toBeInstanceOf(Error);
    if (op === "app-archive") {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
    } else {
      expect((error as { code?: string }).code).toBe("23514");
    }
    expect((error as Error).message).toContain("workflow_definition_has_active_child_invocations");
    const defs = await db.select().from(workflowDefinitions).where(inArray(workflowDefinitions.id, [x.parentDefId, x.childDefId]));
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.status)).toEqual(["active", "active"]);
    const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    expect(parent?.status).toBe("running");
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(s?.status).toBe("pending");
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, x.invocationId));
    expect(invocation?.state).toBe("linked");
    expect(invocation?.childRunId).toBe(x.childRunId);
    if (x.childRunId) {
      const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
      expect(child?.status).toBe(x.childStatus);
    }
  });

  it("rejects invocation insert without target_workflow_id with 23502 (NOT NULL)", async () => {
    const companyId = await createCompanyFixture("NotNull Co");
    const parentDefId = await insertDefinition({ companyId, name: "p", steps: [childStep(randomUUID())] });
    const { runId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const stepRunId = await insertStepRunForRun({ runId, stepId: "other-step" });
    let thrown: unknown = null;
    try {
      await db.execute(sql`
        insert into workflow_step_invocations (id, company_id, parent_step_run_id, state, generation)
        values (${randomUUID()}, ${companyId}, ${stepRunId}, 'linked', 1)`);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("23502");
    expect((thrown as Error).message).toContain("target_workflow_id");
  });

  it("rejects retargeting an invocation with 23514 workflow_child_target_identity_immutable", async () => {
    const x = await unsettledScenario("ImmutableTarget", "pending-c");
    let thrown: unknown = null;
    try {
      await db.execute(sql`update workflow_step_invocations set target_workflow_id = ${randomUUID()} where id = ${x.invocationId}`);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("23514");
    expect((thrown as Error).message).toContain("workflow_child_target_identity_immutable");
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, x.invocationId));
    expect(invocation?.targetWorkflowId).toBe(x.childDefId);
  });

  it("archives an unrelated definition with no child associations (control)", async () => {
    const companyId = await createCompanyFixture("Unrelated Co");
    const defId = await insertDefinition({ companyId, name: "unrelated", steps: [] });
    expect(await archiveWorkflowDefinitionWithGuard(db, defId)).toBe(true);
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, defId));
    expect(definition?.status).toBe("archived");
  });
});
