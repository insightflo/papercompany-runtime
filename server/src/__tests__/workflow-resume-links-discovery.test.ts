import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeMissionHistory } from "../services/workflow/resume/read-model-mission.js";
import {
  canonicalMissionDomain,
  cleanupResourceTables,
  readModelScope,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedMissionSiblingRun,
  seedReadModelHeartbeat,
  seedReadModelStepRun,
  seedReadModelWakeup,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";
import { expectDomainUnchanged, readMissionLinksReadonly, seedLinkedWakeup, seedRetryHeartbeat, seedSelectedGraph } from "./helpers/workflow-resume-links-fixture.js";
/**
 * [purpose] Task5c3d typed link discovery via public readResumeMissionLinkedHistory (항상 실제
 *   repeatable-read read-only 트랜잭션): typed directions, coalescing, retry branches, self/cycle
 *   termination, raw full-row preservation — 시딩은 baseline 전, 매 certified 호출 후 전체 도메인 비교. Real embedded Postgres, no mocks, no skipped suites.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);
describe("readResumeMissionLinkedHistory — typed link discovery", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-links-discovery-");
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

  it("returns empty heartbeat/wakeup lists on empty seeds despite unrelated same- and foreign-company rows", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const unlinkedHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const unlinkedWake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const otherMissionWake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: otherMission });
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHb = await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId });
    const foreignWake = await seedReadModelWakeup(db, { companyId: foreign.companyId, agentId: foreign.agentId });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats).toEqual([]);
    expect(result.history.wakeups).toEqual([]);
    expect(result.missionRuns.map((row) => row.id)).toEqual([graph.runId]);
    for (const stray of [unlinkedHb, unlinkedWake, otherMissionWake, foreignHb, foreignWake]) {
      expect(result.history.heartbeats.map((row) => row.id)).not.toContain(stray);
      expect(result.history.wakeups.map((row) => row.id)).not.toContain(stray);
    }
  }, 30_000);

  it("discovers a linkless heartbeat solely via wake.runId that the accepted base reader omits", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: heartbeat });
    const scope = readModelScope(graph);

    const before = await canonicalMissionDomain(db); // 두 certified 호출이 공유하는 최초 호출 전 baseline
    const base = await expectDomainUnchanged(db, before, () =>
      db.transaction((tx) => readResumeMissionHistory(tx, scope),
        { isolationLevel: "repeatable read", accessMode: "read only" }));
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, scope));

    // [행동 증명] accepted base reader 는 wake.runId 역방향 heartbeat 를 수집하지 못한다.
    expect(base.history.wakeups.map((row) => row.id)).toEqual([result.history.wakeups[0]!.id]);
    expect(base.history.heartbeats).toEqual([]);
    expect(result.history.wakeups).toHaveLength(1);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    const hbRow = result.history.heartbeats[0]!;
    expect(hbRow.wakeupRequestId).toBeNull();
    expect(hbRow.workflowStepRunId).toBeNull();
    expect(hbRow.retryOfRunId).toBeNull();
    expect(hbRow.contextSnapshot).toBeNull();
  }, 30_000);

  it("discovers an otherwise-unlinked wake via its heartbeat's wakeupRequestId pointer", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const wake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId,
      workflowStepRunId: selectedStepRowIds[0]!, wakeupRequestId: wake,
    });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wake]);
  }, 30_000);

  it("discovers a coalesced wake via the reverse runId edge while heartbeat.wakeupRequestId stays null", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const coalesced = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: heartbeat });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([coalesced]);
    const wakeRow = result.history.wakeups[0]!;
    expect(wakeRow.runId).toBe(heartbeat);
    expect(wakeRow.missionId).toBeNull();
    expect(wakeRow.workflowRunId).toBeNull();
  }, 30_000);

  it("preserves two coalesced wakes plus the original wake on one heartbeat without demanding reciprocity", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const original = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId,
      workflowStepRunId: selectedStepRowIds[0]!, wakeupRequestId: original,
    });
    const coalescedA = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: heartbeat });
    const coalescedB = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: heartbeat });
    // original wake 도 같은 heartbeat 지정 — 세 wake 모두 runId 로 같은 heartbeat(baseline 전 seed 단계).
    await db.update(agentWakeupRequests).set({ runId: heartbeat }).where(eq(agentWakeupRequests.id, original));

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([coalescedA, coalescedB, original].sort());
    expect(new Set(result.history.wakeups.map((row) => row.id)).size).toBe(3);
    for (const wakeRow of result.history.wakeups) expect(wakeRow.runId).toBe(heartbeat);
    expect(result.history.heartbeats[0]!.wakeupRequestId).toBe(original);
  }, 30_000);

  it("discovers an otherwise-unlinked heartbeat via its pointer to an already-known wakeup", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const knownWake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId });
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, wakeupRequestId: knownWake });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([knownWake]);
  }, 30_000);

  it("discovers a retryOfRunId-only parent behind a step-linked retry child", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const parent = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const child = await seedRetryHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId,
      retryOfRunId: parent, workflowStepRunId: selectedStepRowIds[0]!,
    });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([child, parent].sort());
    const parentRow = result.history.heartbeats.find((row) => row.id === parent)!;
    expect(parentRow.workflowStepRunId).toBeNull();
    expect(parentRow.wakeupRequestId).toBeNull();
    expect(parentRow.retryOfRunId).toBeNull();
  }, 30_000);

  it("discovers a retryOfRunId-only child of a step-linked parent with no alternate links", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const parent = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const child = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: parent });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([child, parent].sort());
    const childRow = result.history.heartbeats.find((row) => row.id === child)!;
    expect(childRow.retryOfRunId).toBe(parent);
    expect(childRow.workflowStepRunId).toBeNull();
    expect(childRow.wakeupRequestId).toBeNull();
    expect(childRow.issueId).toBeNull();
    expect(childRow.contextSnapshot).toBeNull();
  }, 30_000);

  it("closes a multi-hop retry family and a mixed wake/heartbeat chain needing more than one round; exact sorted ids, unrelated excluded", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const stepRow = selectedStepRowIds[0]!;
    const grandparent = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const middle = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: grandparent, workflowStepRunId: stepRow });
    const child = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: middle });
    const sibling = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: middle });
    const grandchild = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: child });
    const hb2 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const wake2 = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: hb2 });
    const hb1 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, wakeupRequestId: wake2 });
    const wake1 = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: hb1 });
    const decoyHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const decoyWake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHb = await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId });

    const expectedHeartbeats = [grandparent, middle, child, sibling, grandchild, hb1, hb2].sort();
    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual(expectedHeartbeats);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([...result.history.heartbeats.map((row) => row.id)].sort());
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wake1, wake2].sort());
    for (const stray of [decoyHb, decoyWake, foreignHb]) {
      expect(result.history.heartbeats.map((row) => row.id)).not.toContain(stray);
      expect(result.history.wakeups.map((row) => row.id)).not.toContain(stray);
    }
  }, 30_000);

  it("terminates on a retry self-loop, a two-node retry cycle, and a linked wake cycle while retaining all rows", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const stepRow = selectedStepRowIds[0]!;
    const selfLoopId = randomUUID();
    const selfLoop = await seedRetryHeartbeat(db, {
      id: selfLoopId, companyId: graph.companyId, agentId: graph.agentId,
      retryOfRunId: selfLoopId, workflowStepRunId: stepRow,
    });
    const cycleA = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: null, workflowStepRunId: stepRow });
    const cycleB = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: cycleA });
    await db.update(heartbeatRuns).set({ retryOfRunId: cycleB }).where(eq(heartbeatRuns.id, cycleA));
    const wakeCycleHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepRow });
    const wakeCycleWake = await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, runId: wakeCycleHb });
    await db.update(heartbeatRuns).set({ wakeupRequestId: wakeCycleWake }).where(eq(heartbeatRuns.id, wakeCycleHb));

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([selfLoop, cycleA, cycleB, wakeCycleHb].sort());
    expect(new Set(result.history.heartbeats.map((row) => row.id)).size).toBe(4);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wakeCycleWake]);
    const selfRow = result.history.heartbeats.find((row) => row.id === selfLoop)!;
    expect(selfRow.retryOfRunId).toBe(selfLoop);
  }, 30_000);

  it("preserves full closure rows raw: unknown status, old generation, pending/failed/succeeded, nonnull lease fields, contradictory same-company fields", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const otherRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: otherMission });
    const otherStep = await seedReadModelStepRun(db, { runId: otherRun, stepId: "other-step" });
    const parent = await seedRetryHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: null,
      workflowStepRunId: selectedStepRowIds[0]!, status: "succeeded", workflowExecutionGeneration: 0,
    });
    const failedChild = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: parent, status: "failed" });
    const pendingChild = await seedRetryHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: parent, status: "pending" });
    const leasedAt = new Date("2026-01-01T00:00:00.000Z");
    const leasedChild = await seedRetryHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, retryOfRunId: parent,
      status: "company-unknown-status", workflowExecutionGeneration: 99,
      executionScopeKind: "legacy-scope", executionEpoch: 7, executionToken: randomUUID(),
      workflowStepRunId: otherStep,
      executorOwnerId: "executor-owner-x", executorOwnerLeaseEpoch: 3,
      executorOwnerLeaseToken: randomUUID(), executorOwnerLeaseExpiresAt: leasedAt,
      executorOwnerAcknowledgedAt: leasedAt, executorOwnerReleasedAt: leasedAt,
    });
    const wake = await seedLinkedWakeup(db, {
      companyId: graph.companyId, agentId: graph.agentId, runId: leasedChild,
      missionId: graph.missionId, workflowRunId: otherRun, status: "coalesced",
    });

    const before = await canonicalMissionDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionLinksReadonly(db, readModelScope(graph)));
    const closureIds = [parent, failedChild, pendingChild, leasedChild];

    expect(result.history.heartbeats.map((row) => row.id)).toEqual(closureIds.slice().sort());
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wake]);
    // [전체 행 비교] id 만이 아니라 Date/lease/raw jsonb 포함 전체 행이 DB canonical 과 정확히 같다.
    expect(result.history.heartbeats).toEqual(before.heartbeats.filter((row) => closureIds.includes(row.id)));
    expect(result.history.wakeups).toEqual(before.wakeups.filter((row) => row.id === wake));
    const leasedRow = result.history.heartbeats.find((row) => row.id === leasedChild)!;
    expect(leasedRow.status).toBe("company-unknown-status");
    expect(leasedRow.workflowExecutionGeneration).toBe(99);
    expect(leasedRow.executorOwnerLeaseToken).not.toBeNull();
    expect(leasedRow.executorOwnerReleasedAt).toEqual(leasedAt);
    expect(leasedRow.workflowStepRunId).toBe(otherStep);
    const wakeRow = result.history.wakeups.find((row) => row.id === wake)!;
    expect(wakeRow.status).toBe("coalesced");
    expect(wakeRow.workflowRunId).toBe(otherRun);
    expect(wakeRow.missionId).toBe(graph.missionId);
    expect(wakeRow.runId).toBe(leasedChild);
  }, 30_000);
});
