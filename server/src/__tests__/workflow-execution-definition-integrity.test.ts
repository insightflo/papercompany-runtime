import { eq, sql as dsql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createDb,
  workflowDefinitions,
  workflowRunDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  captureHttpError,
  HASH_PATTERN,
  readSnapshotRow,
  richDefinitionStepsJson,
  seedCompanyOnly,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  sleep,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-execution-definition-fixture.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  buildExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
} from "../services/workflow/execution-definition-codec.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";

/**
 * [목적] Task5a1 실행정의 스냅샷의 DB 강제(CHECK/FK/PK/cascade), 통제된 raw SQL corrupt 입력,
 *   트랜잭션 롤백, 캡처/소스 갱신 동시성을 실제 PostgreSQL 로 검증한다.
 *   row 조작 테스트는 격리된 임베디드 DB 에서만 수행한다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow execution definition integrity", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: import("@paperclipai/db").Db;
  let sql: import("./helpers/workflow-execution-definition-fixture.js").RawSql;
  let seeded: { companyId: string; missionId: string };
  let definitionId: string;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("execdef-integrity-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    sql = fixture.sql;
    seeded = await seedCompanyWithMission(sql, "EFI1");
    definitionId = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "integrity-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function createFrozenRun(input: Record<string, unknown> = {}) {
    return await createWorkflowRun(db, {
      workflowId: definitionId,
      companyId: seeded.companyId,
      triggeredBy: "task5a1-integrity",
      ...input,
    } as Parameters<typeof createWorkflowRun>[1]);
  }

  function consistentSnapshotValues(runId: string, overrides: Record<string, unknown> = {}) {
    const payload = buildExecutionDefinitionPayload({
      companyId: seeded.companyId,
      workflowRunId: runId,
      executionMode: "static_dag",
      steps: [{ id: "s1", name: "S1", agentId: "", dependencies: [], graphWorkProductRequired: false }],
      provenance: {
        schemaVersion: 1,
        origin: "run_creation",
        workflowId: definitionId,
        missionId: null,
        workflowName: "integrity-workflow",
        source: "native",
        sourceKind: "workflow",
        definitionUpdatedAt: new Date().toISOString(),
      },
      ...overrides,
    });
    return {
      hash: hashExecutionDefinitionPayload(payload),
      steps: payload.steps,
      provenance: payload.provenance,
      executionMode: payload.executionMode,
    };
  }

  it("enforces CHECK constraints on version/mode/hash/jsonb shape", async () => {
    const runId = await seedCompanyRunId();
    const good = consistentSnapshotValues(runId);
    const rejects = async (query: Promise<unknown>) => {
      await expect(query).rejects.toMatchObject({ code: "23514" });
    };
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 2, ${good.hash}, 'static_dag', ${JSON.stringify(good.steps)}, 1, ${JSON.stringify(good.provenance)})`);
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 1, ${good.hash}, 'static_dag', ${JSON.stringify(good.steps)}, 0, ${JSON.stringify(good.provenance)})`);
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 1, ${good.hash}, 'owner_plan', ${JSON.stringify(good.steps)}, 1, ${JSON.stringify(good.provenance)})`);
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 1, ${good.hash.toUpperCase()}, 'static_dag', ${JSON.stringify(good.steps)}, 1, ${JSON.stringify(good.provenance)})`);
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 1, ${good.hash}, 'static_dag', ${JSON.stringify({ nope: [] })}, 1, ${JSON.stringify(good.provenance)})`);
    await rejects(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${runId}, ${seeded.companyId}, 1, ${good.hash}, 'static_dag', ${JSON.stringify(good.steps)}, 1, ${JSON.stringify([good.provenance])})`);
  });

  async function seedCompanyRunId(): Promise<string> {
    return await seedWorkflowRun(sql, {
      workflowId: definitionId,
      companyId: seeded.companyId,
      metadata: { executionDefinitionVersion: 1 },
    });
  }

  it("enforces FK and PK constraints and cascades delete from the run", async () => {
    await expect(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${"99999999-9999-4999-8999-999999999999"}, ${seeded.companyId}, 1, ${"ab".repeat(32)}, 'static_dag', ${JSON.stringify([])}, 1, ${JSON.stringify({})})`)
      .rejects.toMatchObject({ code: "23503" });

    // the product path already captured a snapshot for this run
    const run = await createFrozenRun();
    const original = await readSnapshotRow(sql, run.id);
    expect(original).not.toBeNull();
    const collision = consistentSnapshotValues(run.id);
    await expect(sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${run.id}, ${seeded.companyId}, 1, ${collision.hash}, 'static_dag', ${JSON.stringify(collision.steps)}, 1, ${JSON.stringify(collision.provenance)})`)
      .rejects.toMatchObject({ code: "23505" });
    expect(await readSnapshotRow(sql, run.id)).toEqual(original);

    await sql`DELETE FROM workflow_runs WHERE id = ${run.id}`;
    expect(await readSnapshotRow(sql, run.id)).toBeNull();
  });

  it("fails closed on corrupted snapshots: hash mismatch, malformed core, wrong scope", async () => {
    const hashMismatchRun = await createFrozenRun();
    await sql`UPDATE workflow_run_definitions SET steps = ${JSON.stringify([{ id: "tampered", name: "T", agentId: "", dependencies: [], graphWorkProductRequired: false }])} WHERE workflow_run_id = ${hashMismatchRun.id}`;
    const hashError = await captureHttpError(
      loadExecutionDefinition(db, hashMismatchRun.id, { requireHistorical: false }),
    );
    expect(hashError.status).toBe(422);
    expect(hashError.message).toBe("historical_definition_unproven");

    const malformedRunId = await seedCompanyRunId();
    const malformed = consistentSnapshotValues(malformedRunId, { steps: [{ id: 123 }] });
    await sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${malformedRunId}, ${seeded.companyId}, 1, ${malformed.hash}, 'static_dag', ${JSON.stringify(malformed.steps)}, 1, ${JSON.stringify(malformed.provenance)})`;
    const malformedError = await captureHttpError(
      loadExecutionDefinition(db, malformedRunId, { requireHistorical: true }),
    );
    expect(malformedError.status).toBe(422);
    expect(malformedError.message).toBe("historical_definition_unproven");

    const scopeRunId = await seedCompanyRunId();
    const otherWorkflow = await seedWorkflowDefinition(sql, {
      companyId: seeded.companyId,
      name: "other-workflow",
      stepsJson: [],
    });
    const wrongScope = consistentSnapshotValues(scopeRunId);
    const wrongScopePayload = buildExecutionDefinitionPayload({
      companyId: seeded.companyId,
      workflowRunId: scopeRunId,
      executionMode: "static_dag",
      steps: wrongScope.steps,
      provenance: { ...wrongScope.provenance, workflowId: otherWorkflow },
    });
    await sql`INSERT INTO workflow_run_definitions (workflow_run_id, company_id, schema_version, definition_hash, execution_mode, steps, normalizer_version, provenance)
      VALUES (${scopeRunId}, ${seeded.companyId}, 1, ${hashExecutionDefinitionPayload(wrongScopePayload)}, 'static_dag', ${JSON.stringify(wrongScopePayload.steps)}, 1, ${JSON.stringify(wrongScopePayload.provenance)})`;
    const scopeError = await captureHttpError(
      loadExecutionDefinition(db, scopeRunId, { requireHistorical: false }),
    );
    expect(scopeError.status).toBe(422);
    expect(scopeError.message).toBe("scope_mismatch");
  });

  it("rolls back run + snapshot together when snapshot insert fails (test-only trigger)", async () => {
    const target = await seedCompanyOnly(sql, "EFI9");
    const targetDefinition = await seedWorkflowDefinition(sql, {
      companyId: target.companyId,
      name: "rollback-workflow",
      stepsJson: richDefinitionStepsJson(),
    });
    await sql.unsafe(
      `CREATE OR REPLACE FUNCTION task5a1_reject_snapshot() RETURNS trigger AS $fn$
       BEGIN RAISE EXCEPTION 'task5a1 test snapshot rejection'; END;
       $fn$ LANGUAGE plpgsql`,
    );
    await sql.unsafe(
      `CREATE TRIGGER task5a1_reject_snapshot_trigger BEFORE INSERT ON workflow_run_definitions
       FOR EACH ROW WHEN (NEW.company_id = '${target.companyId}') EXECUTE FUNCTION task5a1_reject_snapshot()`,
    );
    try {
      const runsBefore = await countCompanyRuns(target.companyId);
      await expect(createWorkflowRun(db, {
        workflowId: targetDefinition,
        companyId: target.companyId,
        triggeredBy: "task5a1-rollback",
      })).rejects.toThrow("task5a1 test snapshot rejection");
      expect(await countCompanyRuns(target.companyId)).toBe(runsBefore);
      const snapshots = await db
        .select({ c: dsql<number>`count(*)::int` })
        .from(workflowRunDefinitions)
        .where(eq(workflowRunDefinitions.companyId, target.companyId));
      expect(snapshots[0]?.c).toBe(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS task5a1_reject_snapshot_trigger ON workflow_run_definitions`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS task5a1_reject_snapshot()`);
    }
  });

  async function countCompanyRuns(companyId: string): Promise<number> {
    const rows = await db
      .select({ c: dsql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(eq(workflowRuns.companyId, companyId));
    return rows[0]?.c ?? 0;
  }

  it("capture blocks on the locked source row and captures the committed definition", async () => {
    const concurrencyCompany = await seedCompanyOnly(sql, "EFIC");
    const targetDefinition = await seedWorkflowDefinition(sql, {
      companyId: concurrencyCompany.companyId,
      name: "concurrency-workflow",
      stepsJson: [{ id: "publish", name: "Publish", agentId: "agent-1" }],
    });
    const dbA = createDb(fixture.connectionString);
    const dbB = createDb(fixture.connectionString);
    const observer = fixture.openRawConnection();
    try {
      let createPromise: Promise<string> | null = null;
      await dbA.transaction(async (tx) => {
        await tx.select().from(workflowDefinitions)
          .where(eq(workflowDefinitions.id, targetDefinition))
          .for("update");
        createPromise = createWorkflowRun(dbB, {
          workflowId: targetDefinition,
          companyId: concurrencyCompany.companyId,
          triggeredBy: "task5a1-concurrency",
        }).then((run) => run.id);
        createPromise.catch(() => {});
        const deadline = Date.now() + 10_000;
        let blockedRows: Array<Record<string, unknown>> = [];
        while (Date.now() < deadline) {
          blockedRows = await observer`
            SELECT a.pid, a.wait_event_type, a.state
            FROM pg_stat_activity a
            WHERE a.datname = current_database()
              AND a.state = 'active'
              AND a.wait_event_type = 'Lock'
              AND a.query ILIKE '%insert into "workflow_runs"%'
              AND a.pid <> pg_backend_pid()`;
          if (blockedRows.length > 0) break;
          await sleep(100);
        }
        expect(blockedRows.length).toBeGreaterThan(0);
        await tx.update(workflowDefinitions)
          .set({ name: "committed-during-flight" })
          .where(eq(workflowDefinitions.id, targetDefinition));
      });
      const runId = await createPromise!;
      const loaded = await loadExecutionDefinition(db, runId, { requireHistorical: true });
      expect(loaded.source).toBe("snapshot");
      expect(loaded.provenance?.workflowName).toBe("committed-during-flight");
      expect(HASH_PATTERN.test(loaded.definitionHash)).toBe(true);
    } finally {
      await dbA.$client.end({ timeout: 5 }).catch(() => {});
      await dbB.$client.end({ timeout: 5 }).catch(() => {});
      await observer.end().catch(() => {});
    }
  }, 40_000);
});
