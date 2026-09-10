import {
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  missionAgentRuntimes,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import {
  readResumeExecutionHistory,
  type ResumeExecutionHistoryScope,
} from "../../services/workflow/resume/read-model.js";
import {
  captureHttpError,
  canonicalHistoryRows,
  cleanupReadModelTables,
  readModelScope,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type ForeignReadModelGraph,
  type ReadModelGraph,
} from "./workflow-resume-read-model-fixture.js";

/**
 * [목적] Task5c2c raw resource/finalization 테스트 픽스처. 기존 승인 fixture(read-model-fixture,
 *   그 아래 frozen/5a1 helper)를 import 로만 재사용(수정 금지)하고, 다섯 resource 테이블
 *   (heartbeat_run_finalizations, heartbeat_run_finalization_steps, workspace_operations,
 *   workspace_runtime_services, mission_agent_runtimes)의 실제 DB 시딩/정리만 추가한다.
 *   mock DB/loader/engine/hash 없음. 모든 uuid 는 randomUUID 또는 DB defaultRandom.
 * [정리 순서] 새 테이블을 FK 역순으로 먼저 지운 뒤 기존 cleanupReadModelTables(heartbeat_runs
 *   포함)를 호출한다 — mission_agent_runtimes.last_run_id / workspace_* 의 run FK 가 먼저 풀려야 한다.
 */

export {
  captureHttpError,
  canonicalHistoryRows,
  cleanupReadModelTables,
  readModelScope,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  startExecutionDefinitionFixture,
};
export type { ExecutionDefinitionFixture, ForeignReadModelGraph, ReadModelGraph };

/**
 * [계약] 새 테스트의 모든 public read 성공/오류 경로는 실제 repeatable-read + read-only
 *   트랜잭션 안에서 reader 를 호출해야 한다(원 brief 요구). reader 자체는 transaction/SET 을
 *   시작하지 않으므로, 이 헬퍼가 트랜잭션 설정을 책임진다.
 */
export function readResourceHistoryReadonly(db: Db, scope: ResumeExecutionHistoryScope) {
  return db.transaction((tx) => readResumeExecutionHistory(tx, scope), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** frozen 정의의 모든 step id 에 1:1 step run 행을 시딩한다(step_set 통과 최소 그래프). */
export async function seedCompleteStepRuns(db: Db, graph: ReadModelGraph): Promise<string[]> {
  const rowIds: string[] = [];
  for (const stepId of graph.definitionStepIds) {
    rowIds.push(await seedReadModelStepRun(db, { runId: graph.runId, stepId }));
  }
  return rowIds;
}

/** [reader 소유 테이블 전체] canonical before/after 비교용 — 오름차순 전체 행. 키는 reader 반환
 *   배열 이름과 동일(five resource arrays 전체 비교 계약용). */
export async function canonicalResourceRows(db: Db) {
  const finalizations = await db.select().from(heartbeatRunFinalizations).orderBy(heartbeatRunFinalizations.id);
  const finalizationSteps = await db.select().from(heartbeatRunFinalizationSteps)
    .orderBy(heartbeatRunFinalizationSteps.id);
  const operationRows = await db.select().from(workspaceOperations).orderBy(workspaceOperations.id);
  const serviceRows = await db.select().from(workspaceRuntimeServices).orderBy(workspaceRuntimeServices.id);
  const runtimeRows = await db.select().from(missionAgentRuntimes).orderBy(missionAgentRuntimes.id);
  return {
    finalizations,
    finalizationSteps,
    workspaceOperations: operationRows,
    workspaceRuntimeServices: serviceRows,
    missionAgentRuntimes: runtimeRows,
  };
}

/** 새 resource 테이블 5개를 FK 역순으로 삭제한 뒤 기존 이력 cleanup 을 실행한다. */
export async function cleanupResourceTables(db: Db): Promise<void> {
  await db.delete(heartbeatRunFinalizationSteps);
  await db.delete(heartbeatRunFinalizations);
  await db.delete(workspaceOperations);
  await db.delete(workspaceRuntimeServices);
  await db.delete(missionAgentRuntimes);
  await cleanupReadModelTables(db);
}

export async function seedResourceFinalization(
  db: Db,
  input: {
    companyId: string;
    heartbeatRunId: string;
    terminalOutcome?: string;
    terminalDecisionSource?: string;
    finalizationVersion?: number;
    state?: string;
    leaseEpoch?: number;
    leaseToken?: string | null;
    owner?: string | null;
    leaseExpiresAt?: Date | null;
    attempts?: number;
    maxAttempts?: number;
    lastError?: string | null;
  },
): Promise<string> {
  const [row] = await db.insert(heartbeatRunFinalizations).values({
    companyId: input.companyId,
    heartbeatRunId: input.heartbeatRunId,
    executionEpoch: 0,
    executionToken: randomUUID(),
    terminalOutcome: input.terminalOutcome ?? "completed",
    terminalDecisionSource: input.terminalDecisionSource ?? "test",
    finalizationVersion: input.finalizationVersion ?? 0,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.leaseEpoch !== undefined ? { finalizerLeaseEpoch: input.leaseEpoch } : {}),
    ...(input.leaseToken !== undefined ? { finalizerLeaseToken: input.leaseToken } : {}),
    ...(input.owner !== undefined ? { finalizerOwner: input.owner } : {}),
    ...(input.leaseExpiresAt !== undefined ? { finalizerLeaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
  }).returning();
  return row!.id;
}

export async function seedResourceFinalizationStep(
  db: Db,
  input: {
    companyId: string;
    heartbeatRunId: string;
    heartbeatRunFinalizationId: string;
    stageClass?: string;
    stageKind: string;
    idempotencyKey: string;
    state?: string;
    leaseEpoch?: number;
    leaseToken?: string | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await db.insert(heartbeatRunFinalizationSteps).values({
    companyId: input.companyId,
    heartbeatRunId: input.heartbeatRunId,
    heartbeatRunFinalizationId: input.heartbeatRunFinalizationId,
    stageClass: input.stageClass ?? "test-stage",
    stageKind: input.stageKind,
    idempotencyKey: input.idempotencyKey,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.leaseEpoch !== undefined ? { leaseEpoch: input.leaseEpoch } : {}),
    ...(input.leaseToken !== undefined ? { leaseToken: input.leaseToken } : {}),
    ...(input.leaseOwner !== undefined ? { leaseOwner: input.leaseOwner } : {}),
    ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  }).returning();
  return row!.id;
}

export async function seedResourceWorkspaceOperation(
  db: Db,
  input: {
    companyId: string;
    heartbeatRunId?: string | null;
    phase: string;
    command?: string | null;
    status?: string;
    exitCode?: number | null;
    startedAt?: Date;
    finishedAt?: Date | null;
    stdoutExcerpt?: string | null;
  },
): Promise<string> {
  const [row] = await db.insert(workspaceOperations).values({
    companyId: input.companyId,
    ...(input.heartbeatRunId ? { heartbeatRunId: input.heartbeatRunId } : {}),
    phase: input.phase,
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    ...(input.stdoutExcerpt !== undefined ? { stdoutExcerpt: input.stdoutExcerpt } : {}),
  }).returning();
  return row!.id;
}

export async function seedResourceRuntimeService(
  db: Db,
  input: {
    companyId: string;
    issueId?: string | null;
    startedByRunId?: string | null;
    scopeType: string;
    scopeId?: string | null;
    serviceName?: string;
    status?: string;
    lifecycle?: string;
    provider?: string;
    port?: number | null;
    stoppedAt?: Date | null;
    stopPolicy?: Record<string, unknown> | null;
  },
): Promise<string> {
  const [row] = await db.insert(workspaceRuntimeServices).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.startedByRunId ? { startedByRunId: input.startedByRunId } : {}),
    scopeType: input.scopeType,
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    serviceName: input.serviceName ?? "test-service",
    status: input.status ?? "running",
    lifecycle: input.lifecycle ?? "ephemeral",
    provider: input.provider ?? "docker",
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
    ...(input.stopPolicy !== undefined ? { stopPolicy: input.stopPolicy } : {}),
  }).returning();
  return row!.id;
}

export async function seedResourceMissionRuntime(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    agentId: string;
    adapterType?: string;
    runtimeKey?: string;
    workspaceKey?: string;
    status?: string;
    lastRunId?: string | null;
    lastRunStatus?: string | null;
    currentIssueId?: string | null;
    queueDepth?: number;
    processPid?: number | null;
    stoppedAt?: Date | null;
    stateJson?: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await db.insert(missionAgentRuntimes).values({
    companyId: input.companyId,
    missionId: input.missionId,
    agentId: input.agentId,
    adapterType: input.adapterType ?? "test-adapter",
    runtimeKey: input.runtimeKey ?? randomUUID(),
    ...(input.workspaceKey !== undefined ? { workspaceKey: input.workspaceKey } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.lastRunId !== undefined ? { lastRunId: input.lastRunId } : {}),
    ...(input.lastRunStatus !== undefined ? { lastRunStatus: input.lastRunStatus } : {}),
    ...(input.currentIssueId !== undefined ? { currentIssueId: input.currentIssueId } : {}),
    ...(input.queueDepth !== undefined ? { queueDepth: input.queueDepth } : {}),
    ...(input.processPid !== undefined ? { processPid: input.processPid } : {}),
    ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
    ...(input.stateJson !== undefined ? { stateJson: input.stateJson } : {}),
  }).returning();
  return row!.id;
}
