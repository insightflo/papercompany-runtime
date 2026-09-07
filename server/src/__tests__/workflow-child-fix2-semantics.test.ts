// @vitest-environment node
// [workflow-child fix round 2] P1-8/P2-7/P2-8/FK 정합 회귀: wait:false cap 면제, childInputs
// 미해결 토큰 fail-closed(실행기 0회), 스키마 FK 정합(cascade/set null).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  toolDefinitions,
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
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child fix round 2 — semantics", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix2-sem-");
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

  it("reg P2-8: an incoming wait:false child is admitted while five wait:true siblings hold the cap", async () => {
    const companyId = await createCompanyFixture("R2 Cap Fire Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        ...Array.from({ length: 5 }, (_, i) => ({
          ...childStep(childDefId),
          id: `wait-${i}`,
          name: `Wait ${i}`,
        })),
        { ...childStep(childDefId), id: "fire", name: "Fire", wait: false },
      ],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(stepRuns.filter((s) => s.status === "failed")).toHaveLength(0);
    expect(stepRuns.filter((s) => s.status === "pending")).toHaveLength(5);
    const fired = stepRuns.find((s) => s.stepId === "fire");
    expect(fired?.status).toBe("completed");
    const children = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(children).toHaveLength(6);
  });

  it("reg P2-7: unresolved childInputs token in child tool args fails closed with zero executor calls", async () => {
    const companyId = await createCompanyFixture("R2 Inputs Strict Co");
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true, ok: true });
    setWorkflowToolStepExecutor(toolExecutor);
    const childDefId = await insertDefinition({
      companyId,
      name: "input-child-wf",
      steps: [{
        id: "t",
        name: "T",
        type: "tool",
        agentId: "",
        dependencies: [],
        toolNames: ["echo-tool"],
        toolArgs: { q: "{$childInputs.nope}" },
      }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId, { inputs: {} })],
    });
    await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    const drained = await processQueuedWorkflowToolStepRuns(db);
    void drained;
    // 실행기는 절대 호출되지 않는다(fail-closed before enqueue/execution).
    expect(toolExecutor).not.toHaveBeenCalled();
    const childRun = (await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow"))))[0];
    const [childStepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, childRun?.id ?? ""));
    expect(childStepRun?.status).toBe("failed");
    expect(childStepRun?.lastDispatchErrorSummary ?? "").toContain("childInputs");
  });

  it("reg FK alignment: company FK cascades and child FK sets null (P2-9/P1-5 schema)", async () => {
    const companyId = await createCompanyFixture("R2 Fk Co");
    const constraints = await db.execute(sql`
      select rc.constraint_name, rc.delete_rule, kcu.column_name
      from information_schema.referential_constraints rc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = rc.constraint_name
       and kcu.table_schema = rc.constraint_schema
      where rc.constraint_schema = 'public'
        and kcu.table_name = 'workflow_step_invocations'
      order by rc.constraint_name
    `);
    const raw = constraints as unknown as
      | Array<{ constraint_name: string; delete_rule: string; column_name: string }>
      | { rows: Array<{ constraint_name: string; delete_rule: string; column_name: string }> };
    const rows = Array.isArray(raw) ? raw : raw.rows;
    const byColumn = new Map(rows.map((r) => [r.column_name, r.delete_rule]));
    expect(byColumn.get("company_id")).toBe("CASCADE");
    expect(byColumn.get("child_run_id")).toBe("SET NULL");
    expect(byColumn.get("parent_step_run_id")).toBe("CASCADE");
    void companyId;
  });
});
