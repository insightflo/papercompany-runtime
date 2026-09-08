import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  captureHttpError,
  HASH_PATTERN,
  readSnapshotRow,
  richDefinitionStepsJson,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-execution-definition-fixture.js";
import { buildWorkflowExecutionSteps } from "../services/workflow/execution-steps.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { createWorkflowRunWithDefinition } from "../services/workflow/workflow-run-create.js";
import { captureExecutionDefinition, loadExecutionDefinition } from "../services/workflow/execution-definition.js";

/**
 * [목적] Task5a1 원자적 run 생성 + 불변 실행정의 캡처/로드 동작 검증 (실제 PostgreSQL).
 *   frozen snapshot 은 캡처 시점에 고정되고 이후 live definition 변경과 무관하다.
 *   snapshot 없는 unmarked legacy run 만 legacy current-definition fallback 을 유지한다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow execution definition lifecycle", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: import("@paperclipai/db").Db;
  let sql: import("./helpers/workflow-execution-definition-fixture.js").RawSql;
  let seeded: { companyId: string; missionId: string };
  let definitionId: string;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("execdef-lifecycle-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
    seeded = await seedCompanyWithMission(sql, "EFL1");
    definitionId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "lifecycle-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const createRunFor = (workflowId: string, extra: Record<string, unknown> = {}) =>
    createWorkflowRun(db, {
      workflowId,
      companyId: seeded.companyId,
      triggeredBy: "task5a1-test",
      ...extra,
    } as Parameters<typeof createWorkflowRun>[1]);

  it("creates run + snapshot atomically with marker, effective mode, gate synthesis, retained metadata", async () => {
    const run = await createRunFor(definitionId, {
      runLabel: "run-1",
      metadata: { sourceLabel: "lifecycle-test" },
    });

    const snapshot = await readSnapshotRow(sql, run.id);
    const expected = buildWorkflowExecutionSteps({
      name: "lifecycle-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
    const steps = snapshot?.steps as Array<Record<string, unknown>>;

    expect(snapshot).not.toBeNull();
    expect(run.status).toBe("pending");
    expect(run.metadata).toMatchObject({ executionDefinitionVersion: 1, sourceLabel: "lifecycle-test" });
    expect(snapshot).toMatchObject({
      schema_version: 1,
      normalizer_version: 1,
      execution_mode: "static_dag",
      company_id: seeded.companyId,
    });
    expect(HASH_PATTERN.test(String(snapshot?.definition_hash))).toBe(true);
    expect(steps).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(steps.filter((step) => step.id === "delivery-verification-gate")).toHaveLength(1);
    expect(steps[0]?.toolNames).toEqual(["web_search"]);
    expect(steps[1]?.dependencies).toEqual(["fetch-source"]);
    expect(steps[1]?.dependsOn).toBe("fetch-source");
  });

  it("load returns byte-equivalent frozen semantics after live definition edits (requireHistorical)", async () => {
    const run = await createRunFor(definitionId);
    const before = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
    expect(before.source).toBe("snapshot");
    expect(before.provenance?.origin).toBe("run_creation");
    expect(before.provenance?.workflowName).toBe("lifecycle-workflow");

    await db.update(workflowDefinitions).set({
      name: "renamed-after-capture",
      stepsJson: [{ id: "totally-new", name: "New", agentId: "x" }],
      executionMode: "dynamic_owner_plan",
      dynamicPlanBootstrapOnly: true,
    }).where(eq(workflowDefinitions.id, definitionId));

    const after = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
    expect(after.steps).toEqual(before.steps);
    expect(after.executionMode).toBe("static_dag");
    expect(after.definitionHash).toBe(before.definitionHash);
    expect(after.provenance?.workflowName).toBe("lifecycle-workflow");
    expect(after.steps.some((step) => (step as { id?: string }).id === "delivery-verification-gate")).toBe(true);
    expect(after.steps).toHaveLength(before.steps.length);
  });

  it("freezes effective dynamic mode against later live static edits and vice versa", async () => {
    const dynamicId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "dynamic-workflow",
      executionMode: "dynamic_owner_plan",
      stepsJson: [{ id: "boot", name: "Boot", agentId: "a", bootstrapOnly: true }],
    });
    const dynamicRun = await createRunFor(dynamicId);
    expect((await loadExecutionDefinition(db, dynamicRun.id, { requireHistorical: true })).executionMode)
      .toBe("dynamic_owner_plan");

    await db.update(workflowDefinitions)
      .set({ executionMode: "static_dag" })
      .where(eq(workflowDefinitions.id, dynamicId));
    expect((await loadExecutionDefinition(db, dynamicRun.id, { requireHistorical: true })).executionMode)
      .toBe("dynamic_owner_plan");

    const staticWithMarkersId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "static-with-dynamic-markers",
      executionMode: "static_dag",
      stepsJson: [{ id: "plan", name: "Plan", agentId: "a", bootstrapOnly: true }],
    });
    const staticRun = await createRunFor(staticWithMarkersId);
    expect((await loadExecutionDefinition(db, staticRun.id, { requireHistorical: true })).executionMode)
      .toBe("static_dag");
  });

  it("captures mission scope into provenance; scope-mismatched capture rolls back both rows", async () => {
    const missionRun = await createRunFor(definitionId, { missionId: seeded.missionId });
    expect(((await readSnapshotRow(sql, missionRun.id))?.provenance as Record<string, unknown>).missionId)
      .toBe(seeded.missionId);

    const other = await seedCompanyWithMission(sql, "EFL2");
    const foreignWorkflow = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId, name: "scope-probe", stepsJson: [],
    });
    await expect(createWorkflowRunWithDefinition(db, {
      workflowId: foreignWorkflow,
      companyId: seeded.companyId,
      missionId: other.missionId,
      triggeredBy: "task5a1-test",
    })).rejects.toMatchObject({ status: 422, message: "scope_mismatch" });

    const wrongCompanyWorkflow = await seedWorkflowDefinition(sql, {
      companyId: other.companyId, name: "foreign-workflow", stepsJson: [],
    });
    await expect(createWorkflowRunWithDefinition(db, {
      workflowId: wrongCompanyWorkflow,
      companyId: seeded.companyId,
      triggeredBy: "task5a1-test",
    })).rejects.toMatchObject({ status: 422, message: "scope_mismatch" });
    expect(await readSnapshotRow(sql, missionRun.id)).not.toBeNull();
  });

  it("falls back to legacy current-definition for unmarked runs without snapshot (read-only)", async () => {
    const legacyDefinition = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "legacy-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
    const legacyRunId = await seedWorkflowRun(sql, {
      workflowId: legacyDefinition,
      companyId: seeded.companyId,
      metadata: {},
    });

    const countBefore = await sql`SELECT count(*)::int AS c FROM workflow_run_definitions`;
    const loaded = await loadExecutionDefinition(db, legacyRunId, { requireHistorical: false });
    expect(loaded.source).toBe("legacy_current");
    expect(loaded.provenance).toBeNull();
    expect(loaded.steps).toEqual(buildWorkflowExecutionSteps({
      name: "legacy-workflow",
      stepsJson: richDefinitionStepsJson(),
    }));
    expect(HASH_PATTERN.test(loaded.definitionHash)).toBe(true);

    const runRow = await db.select().from(workflowRuns).where(eq(workflowRuns.id, legacyRunId));
    const countAfter = await sql`SELECT count(*)::int AS c FROM workflow_run_definitions`;
    expect(runRow).toHaveLength(1);
    expect(runRow[0]?.metadata).toEqual({});
    expect(runRow[0]?.startedAt).toBeNull();
    expect(countAfter[0]?.c).toBe(countBefore[0]?.c);
    expect((await loadExecutionDefinition(db, legacyRunId, { requireHistorical: false })).definitionHash)
      .toBe(loaded.definitionHash);
  });

  it("rejects historical loads for legacy runs (updatedAt<startedAt included) and strict marker keys", async () => {
    const legacyDefinition = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "legacy-historical",
      stepsJson: [],
    });
    const legacyRunId = await seedWorkflowRun(sql, {
      workflowId: legacyDefinition,
      companyId: seeded.companyId,
      metadata: {},
      startedAt: new Date(),
    });
    const historical = await captureHttpError(
      loadExecutionDefinition(db, legacyRunId, { requireHistorical: true }),
    );
    expect(historical.status).toBe(422);
    expect(historical.message).toBe("historical_definition_unproven");

    for (const metadata of [
      { executionDefinitionVersion: null },
      { executionDefinitionVersion: "yes" },
      { executionDefinitionVersion: 2 },
      { resumeRequestId: null },
    ]) {
      const markedRunId = await seedWorkflowRun(sql, {
        workflowId: legacyDefinition,
        companyId: seeded.companyId,
        metadata,
      });
      const error = await captureHttpError(
        loadExecutionDefinition(db, markedRunId, { requireHistorical: false }),
      );
      expect(error.status).toBe(422);
      expect(error.message).toBe("historical_definition_unproven");
      expect(await readSnapshotRow(sql, markedRunId)).toBeNull();
    }
  });

  it("404s unknown runs and reports scope mismatches on load", async () => {
    const missing = await captureHttpError(
      loadExecutionDefinition(db, "77777777-7777-4777-8777-777777777777", { requireHistorical: false }),
    );
    expect(missing.status).toBe(404);

    const other = await seedCompanyWithMission(sql, "EFL3");
    const foreignWorkflow = await seedWorkflowDefinition(sql, {
      companyId: other.companyId, name: "cross-company", stepsJson: [],
    });
    const mismatchedRunId = await seedWorkflowRun(sql, {
      workflowId: foreignWorkflow,
      companyId: seeded.companyId,
      metadata: {},
    });
    const error = await captureHttpError(
      loadExecutionDefinition(db, mismatchedRunId, { requireHistorical: false }),
    );
    expect(error.status).toBe(422);
    expect(error.message).toBe("scope_mismatch");
  });

  it("rejects duplicate capture with conflict and keeps the original snapshot frozen", async () => {
    const run = await createRunFor(definitionId);
    const original = await readSnapshotRow(sql, run.id);
    await db.update(workflowDefinitions)
      .set({ name: "changed-before-recapture", stepsJson: [] })
      .where(eq(workflowDefinitions.id, definitionId));

    const error = await captureHttpError(db.transaction(async (tx) => {
      await captureExecutionDefinition(tx, run.id);
    }));
    expect(error.status).toBe(409);
    expect(await readSnapshotRow(sql, run.id)).toEqual(original);
  });

  it("refuses capture for non-pending/unmarked runs and 404s unknown runs", async () => {
    const guardDefinition = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId, name: "guard-workflow", stepsJson: [],
    });
    const runningRunId = await seedWorkflowRun(sql, {
      workflowId: guardDefinition,
      companyId: seeded.companyId,
      status: "running",
      metadata: { executionDefinitionVersion: 1 },
    });
    const captureInTx = (runId: string) => captureHttpError(db.transaction(async (tx) => {
      await captureExecutionDefinition(tx, runId);
    }));
    expect((await captureInTx(runningRunId)).status).toBe(422);

    const unmarkedRunId = await seedWorkflowRun(sql, {
      workflowId: guardDefinition,
      companyId: seeded.companyId,
      metadata: {},
    });
    expect((await captureInTx(unmarkedRunId)).status).toBe(422);
    expect(await readSnapshotRow(sql, unmarkedRunId)).toBeNull();
    expect((await captureInTx("88888888-8888-4888-8888-888888888888")).status).toBe(404);
  });
});
