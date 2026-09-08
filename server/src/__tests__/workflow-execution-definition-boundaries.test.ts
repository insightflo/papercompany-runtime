import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  captureHttpError,
  HASH_PATTERN,
  readSnapshotRow,
  richDefinitionStepsJson,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  UUID_PATTERN,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-execution-definition-fixture.js";
import { hashExecutionDefinitionPayload } from "../services/workflow/execution-definition-codec.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";

/**
 * [목적] Task5a1 capture/load 경계의 제품 경로 커버리지 보강 (실제 PostgreSQL, 격리 DB 에서만 row 조작).
 *   A id 없는 raw step 의 UUID 고정 + 반복 load 동일성 / B 마커 run 스냅샷 삭제 후 fail-closed 무기록
 *   / C 기존 스냅샷 provenance 위변조(hash 재계산하여 schema 자체 검증) / D provenance missionId scope.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow execution definition boundaries", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: import("@paperclipai/db").Db;
  let sql: import("./helpers/workflow-execution-definition-fixture.js").RawSql;
  let seeded: { companyId: string; agentId: string; missionId: string };
  let definitionId: string;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("execdef-boundaries-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
    seeded = await seedCompanyWithMission(sql, "EFB1");
    definitionId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "boundaries-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const createRunFor = (extra: Record<string, unknown> = {}) =>
    createWorkflowRun(db, {
      workflowId: definitionId,
      companyId: seeded.companyId,
      triggeredBy: "task5a1-boundaries",
      ...extra,
    } as Parameters<typeof createWorkflowRun>[1]);

  async function expectBothLoadersReject(runId: string, message: string) {
    for (const requireHistorical of [true, false]) {
      const error = await captureHttpError(loadExecutionDefinition(db, runId, { requireHistorical }));
      expect(error.status).toBe(422);
      expect(error.message).toBe(message);
    }
  }

  /** 기존 스냅샷의 provenance 만 raw SQL 로 치환하고 canonical hash 를 재계산한다(stale hash 가 아니라 schema 자체를 검증). */
  async function rewriteProvenance(runId: string, overrides: Record<string, unknown>) {
    const before = await readSnapshotRow(sql, runId);
    if (!before) throw new Error("missing snapshot before provenance rewrite");
    const provenance = { ...(before.provenance as Record<string, unknown>), ...overrides };
    const hash = hashExecutionDefinitionPayload({
      schemaVersion: 1,
      normalizerVersion: 1,
      companyId: seeded.companyId,
      workflowRunId: runId,
      executionMode: before.execution_mode as "static_dag" | "dynamic_owner_plan",
      steps: before.steps as unknown[],
      provenance,
    } as Parameters<typeof hashExecutionDefinitionPayload>[0]);
    await sql`UPDATE workflow_run_definitions
      SET provenance = ${JSON.stringify(provenance)}, definition_hash = ${hash}
      WHERE workflow_run_id = ${runId}`;
    const mutated = await readSnapshotRow(sql, runId);
    if (!mutated) throw new Error("missing snapshot after provenance rewrite");
    return mutated;
  }

  it("A: fixes a generated UUID for an id-less raw step; repeated loads return identical steps/hash", async () => {
    const rawId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "boundaries-raw-steps",
      stepsJson: [
        {
          name: "No id step",
          agentId: "agent-a",
          dependsOn: "",
          toolArgs: { nested: { deep: [1, { z: 1, a: 2 }] } },
        },
        { id: "keep-me", name: "Keep me", agentId: "agent-b", conditionGroup: { kind: "if" } },
      ],
    });
    const run = await createRunFor({ workflowId: rawId });
    const snapshot = await readSnapshotRow(sql, run.id);
    const steps = (snapshot?.steps ?? []) as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps.find((step) => step.name === "No id step")?.id).toMatch(UUID_PATTERN);
    expect(steps.find((step) => step.name === "Keep me")?.id).toBe("keep-me");
    expect(snapshot?.definition_hash).toMatch(HASH_PATTERN);

    await db.update(workflowDefinitions).set({
      name: "renamed-after-capture-boundaries",
      stepsJson: [{ id: "brand-new", name: "Brand new", agentId: "z" }],
      executionMode: "dynamic_owner_plan",
    }).where(eq(workflowDefinitions.id, rawId));

    for (const requireHistorical of [true, false, true, false]) {
      const loaded = await loadExecutionDefinition(db, run.id, { requireHistorical });
      expect(loaded.source).toBe("snapshot");
      expect(loaded.steps).toEqual(steps);
      expect(loaded.definitionHash).toBe(snapshot?.definition_hash);
      expect(loaded.steps).toHaveLength(steps.length);
    }
  });

  it("B: marker run with deleted snapshot fails closed in both modes with zero writes/recovery", async () => {
    const run = await createRunFor({ metadata: { executionDefinitionVersion: 999, other: "kept" } });
    expect(run.metadata).toEqual({ executionDefinitionVersion: 1, other: "kept" });

    const runRowBefore = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    const stepRowsBefore = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, run.id));
    await sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${run.id}`;
    expect(await readSnapshotRow(sql, run.id)).toBeNull();

    await expectBothLoadersReject(run.id, "historical_definition_unproven");

    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id))).toEqual(runRowBefore);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
      .toEqual(stepRowsBefore);
    expect(await readSnapshotRow(sql, run.id)).toBeNull();
  });

  it("C: internally-consistent provenance corruption (bad ISO / wrong version / extra key) fails closed", async () => {
    for (const overrides of [
      { definitionUpdatedAt: "not-a-date" },
      { schemaVersion: 2 },
      { extraProvenanceKey: "backfilled" },
    ]) {
      const run = await createRunFor();
      const mutated = await rewriteProvenance(run.id, overrides);
      await expectBothLoadersReject(run.id, "historical_definition_unproven");
      expect(await readSnapshotRow(sql, run.id)).toEqual(mutated);
    }
  });

  it("D: provenance missionId pointing at another same-company mission is a scope mismatch without repair", async () => {
    const run = await createRunFor({ missionId: seeded.missionId });
    const otherMissionId = randomUUID();
    await sql`INSERT INTO missions (id, company_id, owner_agent_id, title)
      VALUES (${otherMissionId}, ${seeded.companyId}, ${seeded.agentId}, 'boundaries other mission')`;
    const mutated = await rewriteProvenance(run.id, { missionId: otherMissionId });
    await expectBothLoadersReject(run.id, "scope_mismatch");
    expect(await readSnapshotRow(sql, run.id)).toEqual(mutated);
  });
});
