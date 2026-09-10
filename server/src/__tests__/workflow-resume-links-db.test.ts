import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeMissionHistory } from "../services/workflow/resume/read-model-mission.js";
import { readResumeMissionLinkedHistory } from "../services/workflow/resume/read-model-links.js";
import {
  canonicalMissionDomain,
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedResourceFinalization,
  seedResourceFinalizationStep,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  seedReadModelHeartbeat,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";
import {
  expectDomainUnchanged,
  expectReason,
  readMissionLinksReadonly,
  seedLinkedWakeup,
  seedSelectedGraph,
} from "./helpers/workflow-resume-links-fixture.js";

/**
 * [purpose] Task5c3d enlarged-history resources and whole-domain DB proof via public
 *   readResumeMissionLinkedHistory (항상 실제 repeatable-read read-only 트랜잭션): finalization/
 *   stages/workspace operation on a heartbeat reachable only after >=2 closure hops,
 *   startedByRunId-only service and lastRunId-only other-mission runtime preserved raw, accepted
 *   resource company-mismatch propagation, session settings + read-twice equality + per-call
 *   canonical invariance, 25006 write protection, and base-reader field equality without
 *   widening/mutating the selected heartbeat subset. Real embedded Postgres, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionLinkedHistory — enlarged resources and DB proof", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-links-db-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupResourceTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  it("collects finalization, stages, and workspace operation on a heartbeat reachable only after two closure hops", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const hb2 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const wake2 = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: hb2 });
    const hb1 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, wakeupRequestId: wake2 });
    const wake1 = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: hb1 });
    const finalization = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: hb2 });
    const stageA = await seedResourceFinalizationStep(db, { companyId: graph.companyId, heartbeatRunId: hb2, heartbeatRunFinalizationId: finalization, stageKind: "stage-a", idempotencyKey: "links-stage-a" });
    const stageB = await seedResourceFinalizationStep(db, { companyId: graph.companyId, heartbeatRunId: hb2, heartbeatRunFinalizationId: finalization, stageKind: "stage-b", idempotencyKey: "links-stage-b" });
    const operation = await seedResourceWorkspaceOperation(db, { companyId: graph.companyId, heartbeatRunId: hb2, phase: "cleanup", command: "rm -rf tmp", status: "succeeded", exitCode: 0 });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    // hb2 는 wake1.runId → hb1.wakeupRequestId → wake2.runId 두 hop 뒤에만 닿는다(직접 링크 없음).
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([hb1, hb2].sort());
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wake1, wake2].sort());
    expect(result.resources.finalizations.map((row) => row.id)).toEqual([finalization]);
    expect(result.resources.finalizationSteps.map((row) => row.id)).toEqual([stageA, stageB].sort());
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([operation]);
    expect(result.resources.finalizations).toEqual(before.finalizations.filter((row) => row.id === finalization));
    expect(result.resources.finalizationSteps).toEqual(before.finalizationSteps.filter((row) => [stageA, stageB].includes(row.id)));
    expect(result.resources.workspaceOperations).toEqual(before.workspaceOperations.filter((row) => row.id === operation));
  }, 30_000);

  it("collects a startedByRunId-only service and a lastRunId-only other-mission runtime on a closure-added heartbeat as raw rows", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: heartbeat });
    // startedByRunId 만: scopeType 이 run 이 아니고 scopeId/issueId 도 링크 없음 — 단일 경로.
    const service = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, startedByRunId: heartbeat, scopeType: "issue", serviceName: "links-service", status: "exited",
    });
    // lastRunId 만: missionId 는 다른 같은회사 mission — missionId shortcut 회피.
    const runtime = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: otherMission, agentId: graph.agentId, lastRunId: heartbeat, lastRunStatus: "failed",
    });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([service]);
    expect(result.resources.missionAgentRuntimes.map((row) => row.id)).toEqual([runtime]);
    // raw 보존 — 다른 mission 소속 runtime 이 해석/거부 없이 그대로 나온다(eligibility 주장 아님).
    const runtimeRow = result.resources.missionAgentRuntimes[0]!;
    expect(runtimeRow.missionId).toBe(otherMission);
    expect(runtimeRow.lastRunId).toBe(heartbeat);
    expect(runtimeRow.lastRunStatus).toBe("failed");
  }, 30_000);

  it("propagates the accepted resource company mismatch for a foreign finalization on a closure-added heartbeat", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: heartbeat });
    await seedResourceFinalization(db, { companyId: foreign.companyId, heartbeatRunId: heartbeat, terminalOutcome: "completed" });

    const before = await canonicalMissionDomain(db);
    const error = await captureHttpError(expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph))));
    expectReason(error, "scope_mismatch", "finalization_company_mismatch");
  }, 30_000);

  it("proves readonly repeatable-read session settings, read-twice equality, and per-call canonical invariance", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: heartbeat });
    const scope = readModelScope(graph);
    const before = await canonicalMissionDomain(db);

    await db.transaction(async (tx) => {
      const settings = await tx.execute<{ read_only: string; isolation: string }>(
        sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );
      expect(settings[0]?.read_only).toBe("on");
      expect(settings[0]?.isolation).toBe("repeatable read");
      const first = await readResumeMissionLinkedHistory(tx, scope);
      expect(await canonicalMissionDomain(db)).toEqual(before); // 1회째 호출 후 무변화
      const second = await readResumeMissionLinkedHistory(tx, scope);
      expect(second).toEqual(first);
      expect(await canonicalMissionDomain(db)).toEqual(before); // 2회째 호출 후 무변화
      expect(first.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }, 30_000);

  it("proves actual write protection: a fixture UPDATE inside the readonly transaction fails with 25006", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const before = await canonicalMissionDomain(db);
    let errorCode: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.update(heartbeatRuns).set({ status: "mutated-by-fixture-probe" }).where(eq(heartbeatRuns.id, heartbeat));
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    } catch (error) {
      errorCode = (error as { code?: unknown }).code;
    }
    expect(errorCode).toBe("25006");
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }, 30_000);

  it("keeps selected, missionRuns, and missionSteps deep-equal to the base reader and never widens the selected heartbeat subset", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const selectedHb = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const closureOnlyHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: closureOnlyHb });
    const scope = readModelScope(graph);
    const before = await canonicalMissionDomain(db); // base reader 호출 전 baseline

    await db.transaction(async (tx) => {
      const base = await readResumeMissionHistory(tx, scope);
      expect(await canonicalMissionDomain(db)).toEqual(before); // base 호출 후 무변화
      const linked = await readResumeMissionLinkedHistory(tx, scope);
      expect(await canonicalMissionDomain(db)).toEqual(before); // linked 호출 후 무변화
      expect(linked.selected).toEqual(base.selected);
      expect(linked.missionRuns).toEqual(base.missionRuns);
      expect(linked.missionSteps).toEqual(base.missionSteps);
      expect(linked.selected.heartbeats).toEqual(base.selected.heartbeats);
      expect(linked.selected.heartbeats.map((row) => row.id)).toEqual([selectedHb]);
      expect(linked.history.heartbeats.map((row) => row.id)).toEqual([selectedHb, closureOnlyHb].sort());
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }, 30_000);
});
