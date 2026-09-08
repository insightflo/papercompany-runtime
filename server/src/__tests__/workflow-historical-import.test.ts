import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import {
  captureHttpError,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-execution-definition-fixture.js";
import {
  auditFailingDb,
  countAuditRows,
  countDefinitionRows,
  historicalProvenanceFixture,
  recoveredStepsFixture,
  seedLegacyTerminalRun,
  sourceStepsHashOf,
  type LegacyRunSeed,
} from "./helpers/workflow-historical-import-fixture.js";
import { buildWorkflowExecutionSteps } from "../services/workflow/execution-steps.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { importReviewedHistoricalDefinition } from "../services/workflow/resume/historical-import.js";
import { parseReviewedHistoricalImportInput, REVIEWED_HISTORICAL_DEFINITION_FACTS } from "../services/workflow/resume/historical-import-core.js";
import type { HttpError } from "../errors.js";

/**
 * [목적] reviewed historical import 의 실제 PostgreSQL 통합 검증(임베디드 PG, mock 없음).
 *   legacy terminal run 에 reviewed provenance 로 스냅샷을 1회 캡처하고, replay/무쓰기/롤백/
   감사 1회/hash·스코프·스텝집합 불일치 거부를 전부 실제 DB 로 확인한다.
 *   production audited UUID 는 절대 다루지 않는다(관계 일관성은 임의 스코프로 검증).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reviewed historical import", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let company: { companyId: string; missionId: string };
  let workflowId: string;
  const NOW = new Date("2026-09-10T09:00:00.000Z");

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("historical-import-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    company = await seedCompanyWithMission(fixture.sql, "HI1");
    // live 정의는 recovered payload 와 다른 현재 steps 를 갖는다(변경 후 상태 재현).
    workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: company.companyId,
      name: "changed-live-workflow",
      stepsJson: [{ id: "current-step", name: "현재 정의 스텝", agentId: "x", dependencies: [] }],
      executionMode: "static_dag",
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  function makeInput(runId: string, overrides: Record<string, unknown> = {}) {
    const steps = (overrides.steps as unknown[] | undefined) ?? recoveredStepsFixture();
    const workflowIdOverride = overrides.workflowId as string | undefined;
    return {
      companyId: company.companyId,
      missionId: company.missionId,
      workflowId: workflowIdOverride ?? workflowId,
      workflowRunId: runId,
      steps,
      provenance: historicalProvenanceFixture({
        workflowId: workflowIdOverride ?? workflowId,
        missionId: company.missionId,
        sourceStepsHash: sourceStepsHashOf(steps),
      }),
      now: NOW,
      ...overrides,
    };
  }

  async function seedRecoveredRun(overrides: { stepIds?: string[]; status?: string; metadata?: Record<string, unknown> } = {}): Promise<LegacyRunSeed> {
    return await seedLegacyTerminalRun(fixture.sql, {
      workflowId,
      companyId: company.companyId,
      missionId: company.missionId,
      stepIds: overrides.stepIds ?? recoveredStepsFixture().map((step) => String(step.id)),
      status: overrides.status,
      metadata: overrides.metadata,
    });
  }

  async function expectWriteCounts(runId: string, definitions: number, audits: number) {
    expect(await countDefinitionRows(fixture.sql, runId)).toBe(definitions);
    expect(await countAuditRows(fixture.sql, runId)).toBe(audits);
  }

  it("imports a legacy terminal run and loadExecutionDefinition(requireHistorical) returns the exact old steps", async () => {
    const seed = await seedRecoveredRun();
    const input = makeInput(seed.runId);
    const result = await importReviewedHistoricalDefinition(fixture.db, input);
    expect(result.status).toBe("imported");
    expect(result.capturedAt).toBe(NOW.toISOString());
    expect(result.stepCount).toBe(3);

    const loaded = await loadExecutionDefinition(fixture.db, seed.runId, { requireHistorical: true });
    const expectedSteps = buildWorkflowExecutionSteps({
      name: REVIEWED_HISTORICAL_DEFINITION_FACTS.workflowName,
      stepsJson: recoveredStepsFixture(),
      executionMode: "static_dag",
      dynamicPlanBootstrapOnly: false,
    });
    expect(loaded.steps).toEqual(JSON.parse(JSON.stringify(expectedSteps)));
    expect(loaded.source).toBe("snapshot");
    expect(loaded.executionMode).toBe("static_dag");
    expect(loaded.definitionHash).toBe(result.definitionHash);
    expect(loaded.provenance?.origin).toBe("reviewed_historical_import");
    expect(loaded.provenance?.workflowName).toBe(REVIEWED_HISTORICAL_DEFINITION_FACTS.workflowName);
    expect(JSON.stringify(loaded.steps)).not.toContain("current-step");
    expect(Reflect.get(loaded.steps[1] as object, "toolArgs")).toEqual({ minutes: 3, options: { tone: "경제" } });
    await expectWriteCounts(seed.runId, 1, 1);
  });

  it("preserves run/step rows byte-for-byte and audits exactly once, then exact replay writes nothing", async () => {
    const seed = await seedRecoveredRun();
    const input = makeInput(seed.runId);
    const rowsBefore = await fixture.sql`SELECT * FROM workflow_runs WHERE id = ${seed.runId}`;
    const stepsBefore = await fixture.sql`SELECT * FROM workflow_step_runs WHERE workflow_run_id = ${seed.runId} ORDER BY step_id`;

    const result = await importReviewedHistoricalDefinition(fixture.db, input);
    const replay = await importReviewedHistoricalDefinition(fixture.db, input);
    expect(replay.status).toBe("replayed");
    expect(replay.definitionHash).toBe(result.definitionHash);

    const rowsAfter = await fixture.sql`SELECT * FROM workflow_runs WHERE id = ${seed.runId}`;
    const stepsAfter = await fixture.sql`SELECT * FROM workflow_step_runs WHERE workflow_run_id = ${seed.runId} ORDER BY step_id`;
    expect(JSON.stringify(rowsAfter)).toBe(JSON.stringify(rowsBefore));
    expect(JSON.stringify(stepsAfter)).toBe(JSON.stringify(stepsBefore));
    await expectWriteCounts(seed.runId, 1, 1);

    const audits = await fixture.sql`SELECT actor_type, actor_id, entity_type, details FROM activity_log WHERE entity_id = ${seed.runId} AND action = 'workflow.execution_definition_imported'`;
    expect(audits[0]?.actor_type).toBe("board");
    expect(audits[0]?.actor_id).toBe("operator-a");
    expect(audits[0]?.entity_type).toBe("workflow_run");
  });

  it("rejects hash/scope/step-set/duplicate/backedge/dynamic/cycle/non-terminal/marker with zero writes", async () => {
    const cases: Array<{ label: string; runId: string; run: () => Promise<unknown> }> = [];
    const register = (label: string, seed: LegacyRunSeed, run: () => Promise<unknown>) =>
      cases.push({ label, runId: seed.runId, run });

    {
      const seed = await seedRecoveredRun();
      const input = makeInput(seed.runId);
      (input.provenance.review as { sourceStepsHash: string }).sourceStepsHash = "b".repeat(64);
      register("hash_mismatch", seed, () => importReviewedHistoricalDefinition(fixture.db, input));
    }
    {
      const seed = await seedRecoveredRun();
      const otherWorkflow = await seedWorkflowDefinition(fixture.sql, { companyId: company.companyId, name: "other" });
      register("scope_mismatch", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId, { workflowId: otherWorkflow })));
    }
    {
      const seed = await seedRecoveredRun({ stepIds: ["recover-select", "recover-script", "recover-factcheck", "surplus-step"] });
      register("step_set_mismatch", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId)));
    }
    {
      const seed = await seedRecoveredRun();
      const steps = recoveredStepsFixture();
      steps.push({ ...steps[0], name: "복제 스텝" });
      register("duplicate_step", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId, { steps })));
    }
    {
      const seed = await seedRecoveredRun();
      const steps = recoveredStepsFixture();
      (steps[0] as Record<string, unknown>).conditionalDependencies = [{ stepId: "recover-factcheck", isBackEdge: true, maxIterations: 2 }];
      register("back_edge", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId, { steps })));
    }
    {
      const seed = await seedRecoveredRun();
      const steps = recoveredStepsFixture();
      (steps[1] as Record<string, unknown>).bootstrapOnly = true;
      register("dynamic_marker", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId, { steps })));
    }
    {
      const seed = await seedRecoveredRun();
      const steps = recoveredStepsFixture();
      (steps[0] as Record<string, unknown>).dependencies = ["recover-factcheck"];
      register("cycle", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId, { steps })));
    }
    {
      const seed = await seedRecoveredRun({ status: "running" });
      register("not_terminal", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId)));
    }
    {
      const seed = await seedRecoveredRun({ metadata: { executionDefinitionVersion: 1 } });
      register("marked_run", seed, () => importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId)));
    }

    for (const { label, runId, run } of cases) {
      const error = await captureHttpError(run()) as HttpError;
      expect([409, 422], label).toContain(error.status);
      // 거부 사례는 전부 무쓰기 — snapshot/audit 가 하나도 남지 않는다.
      await expectWriteCounts(runId, 0, 0);
    }
  });

  it("conflicts 409 when an existing snapshot has a different requested hash", async () => {
    const seed = await seedRecoveredRun();
    await importReviewedHistoricalDefinition(fixture.db, makeInput(seed.runId));
    const steps = recoveredStepsFixture();
    (steps[0] as Record<string, unknown>).description = "변경된 recovered payload";
    const error = await captureHttpError(importReviewedHistoricalDefinition(
      fixture.db,
      makeInput(seed.runId, { steps }),
    )) as HttpError;
    expect(error.status).toBe(409);
    await expectWriteCounts(seed.runId, 1, 1);
  });

  it("fails 400 when input proof is missing and rolls back fully when audit insert fails", async () => {
    const seed = await seedRecoveredRun();
    const { provenance: _drop, ...missing } = makeInput(seed.runId) as Record<string, unknown>;
    expect((await captureHttpError(Promise.resolve().then(() => parseReviewedHistoricalImportInput(missing))) as HttpError).status).toBe(400);

    const auditError = await captureHttpError(
      importReviewedHistoricalDefinition(auditFailingDb(fixture.db), makeInput(seed.runId)),
    ) as HttpError;
    expect(auditError.message).toContain("injected_audit_failure");
    await expectWriteCounts(seed.runId, 0, 0);
  });
});
