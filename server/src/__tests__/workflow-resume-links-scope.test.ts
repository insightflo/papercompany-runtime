import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import type { ResumeExecutionHistoryScope } from "../services/workflow/resume/read-model.js";
import {
  canonicalMissionDomain,
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  seedForeignReadModelGraph,
  seedMissionSiblingRun,
  seedReadModelHeartbeat,
  seedReadModelWakeup,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";
import {
  expectDomainUnchanged,
  expectReason,
  readMissionLinksReadonly,
  seedLinkedWakeup,
  seedRetryHeartbeat,
  seedSelectedGraph,
} from "./helpers/workflow-resume-links-fixture.js";

/**
 * [purpose] Task5c3d scope/missing rejections via public readResumeMissionLinkedHistory — 모든
 *   호출(파싱 오류 포함)은 readMissionLinksReadonly 안의 실제 repeatable-read read-only
 *   트랜잭션에서 실행된다(mocked read surface 없음). 타회사 오염 heartbeat/wakeup 은 여섯 독립
 *   typed 경로(wake.runId, retry 부모/자식, wakeupRequestId 양방향, runId 역참조)마다 각각
 *   정확한 scope_mismatch 이유로 거부되고, FK 로 보호되는 깨진 포인터는 mission-scope 테스트의
 *   session_replication_role=replica 시딩 패턴으로 만든 뒤 정상 readonly 공개 호출로 검증한다.
 *   selected 전처리 오류는 closure 보다 먼저 그대로 전파된다. Real embedded Postgres, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionLinkedHistory — scope and missing-reference rejections", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-links-scope-");
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

  /** [오염 독립 경로] seed → baseline → 공개 호출 거부 단언 → 무변화. 다른 원인 없이 단일 경로만 시딩. */
  async function rejectReason(
    seed: () => Promise<ResumeExecutionHistoryScope>,
    call: (scope: ResumeExecutionHistoryScope) => Promise<unknown>,
    message: string,
    reason: string,
  ) {
    const scope = await seed();
    const before = await canonicalMissionDomain(db);
    const error = await captureHttpError(expectDomainUnchanged(db, before, () => call(scope)));
    expectReason(error, message, reason);
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }

  it("rejects a foreign heartbeat reached solely via a known wake.runId", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const foreignHeartbeat = await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId });
      await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: foreignHeartbeat });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "heartbeat_company_mismatch");
  }, 30_000);

  it("rejects a foreign heartbeat reached solely as the retryOfRunId parent of a step-linked child", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const foreignParent = await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId });
      await seedRetryHeartbeat(db, {
        companyId: graph.companyId, agentId: graph.agentId,
        retryOfRunId: foreignParent, workflowStepRunId: selectedStepRowIds[0]!,
      });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "heartbeat_company_mismatch");
  }, 30_000);

  it("rejects a foreign heartbeat reached solely as a retry child of a step-linked parent", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const parent = await seedReadModelHeartbeat(db, {
        companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
      });
      await seedRetryHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId, retryOfRunId: parent });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "heartbeat_company_mismatch");
  }, 30_000);

  it("rejects a foreign heartbeat reached solely via its wakeupRequestId pointer to a known wakeup", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const knownWake = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId });
      await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId, wakeupRequestId: knownWake });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "heartbeat_company_mismatch");
  }, 30_000);

  it("rejects a foreign wake reached solely via a step-linked heartbeat's wakeupRequestId", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const foreignWake = await seedReadModelWakeup(db, { companyId: foreign.companyId, agentId: foreign.agentId });
      await seedReadModelHeartbeat(db, {
        companyId: graph.companyId, agentId: graph.agentId,
        workflowStepRunId: selectedStepRowIds[0]!, wakeupRequestId: foreignWake,
      });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "wakeup_company_mismatch");
  }, 30_000);

  it("rejects a foreign wake reached solely via its runId pointer to a step-linked heartbeat", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const heartbeat = await seedReadModelHeartbeat(db, {
        companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
      });
      await seedLinkedWakeup(db, { companyId: foreign.companyId, agentId: foreign.agentId, runId: heartbeat });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "scope_mismatch", "wakeup_company_mismatch");
  }, 30_000);

  it("rejects a nonexistent wake.runId with missing_wakeup_run", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: randomUUID() });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "resume_history_unproven", "missing_wakeup_run");
  }, 30_000);

  it("rejects a nonexistent heartbeat.wakeupRequestId with missing_heartbeat_wakeup (replica-mode corruption seeding)", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      await fixture.sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO heartbeat_runs (company_id, agent_id, status, wakeup_request_id, workflow_step_run_id)
          VALUES (${graph.companyId}, ${graph.agentId}, 'succeeded', ${randomUUID()}, ${selectedStepRowIds[0]!})`;
      });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "resume_history_unproven", "missing_heartbeat_wakeup");
  }, 30_000);

  it("rejects a nonexistent heartbeat.retryOfRunId with missing_retry_parent (replica-mode corruption seeding)", async () => {
    await rejectReason(async () => {
      const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
      await fixture.sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`INSERT INTO heartbeat_runs (company_id, agent_id, status, retry_of_run_id, workflow_step_run_id)
          VALUES (${graph.companyId}, ${graph.agentId}, 'succeeded', ${randomUUID()}, ${selectedStepRowIds[0]!})`;
      });
      return readModelScope(graph);
    }, (scope) => readMissionLinksReadonly(db, scope), "resume_history_unproven", "missing_retry_parent");
  }, 30_000);


  it("propagates accepted selected errors before closure: malformed scope, missing frozen snapshot, unknown start step", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    // closure 이 먼저 돌았다면 missing_wakeup_run 이 났을 corruption 을 baseline 전에 시딩 — 전파 순서 증명.
    await seedLinkedWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: randomUUID() });
    const rawSibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "pending" });
    const scope = readModelScope(graph);
    const before = await canonicalMissionDomain(db);

    await expect(expectDomainUnchanged(db, before, () =>
      readMissionLinksReadonly(db, { ...scope, companyId: "not-a-uuid" } as never),
    )).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalMissionDomain(db)).toEqual(before);
    await expect(expectDomainUnchanged(db, before, () =>
      readMissionLinksReadonly(db, { ...scope, extra: "key" } as never),
    )).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalMissionDomain(db)).toEqual(before);
    const missingSnapshot = await captureHttpError(expectDomainUnchanged(db, before, () =>
      readMissionLinksReadonly(db, { ...scope, workflowRunId: rawSibling })));
    expect(missingSnapshot.status).toBe(422);
    expect(missingSnapshot.message).toBe("historical_definition_unproven");
    expect(await canonicalMissionDomain(db)).toEqual(before);
    const ghostStep = await captureHttpError(expectDomainUnchanged(db, before, () =>
      readMissionLinksReadonly(db, { ...scope, startStepId: "ghost-step" })));
    expect(ghostStep.status).toBe(404);
    expect(ghostStep.message).toBe("Workflow step not found");
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }, 30_000);
});
