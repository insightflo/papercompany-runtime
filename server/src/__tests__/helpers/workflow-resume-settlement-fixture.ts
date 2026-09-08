import { randomUUID } from "node:crypto";
import {
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { allRequiredStages, O_STAGE, STAGE_CLASS } from "../../services/heartbeat-finalization/stage-classifier.js";
import {
  canonicalHistoryRows,
  canonicalResourceRows,
  cleanupResourceTables,
  readModelScope,
  seedCompleteStepRuns,
  seedReadModelGraph,
  seedReadModelIssue,
  seedReadModelStepRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type ReadModelGraph,
} from "./workflow-resume-resource-fixture.js";

/**
 * [파일 목적] Task5c3a recorded-settlement 테스트 픽스처. 승인된 기존 fixture(resource →
 *   read-model → frozen/5a1)를 import 로만 재사용(수정 금지)하고, (1) 순수 테스트용 full
 *   DB-row($inferSelect) 타입 팩토리 — `as any`/부분 행 캐스트 없이 전체 열을 명시 — 와
 *   (2) 임베디드 PG 테스트용 직접 insert 시딩만 추가한다. mock DB/hash/engine 없음.
 * [정합성 계약] acceptedSettlementRecords 는 heartbeat/parent/Q+C stage 가 버전1·epoch·token·
 *   outcome·source 로 정확히 결속된 "정산 완료 v1" 기록을 만든다. 기존 resource seed 는 parent
 *   executionToken 이 random 이고 version0 이므로 정산 증명으로 쓰지 않는다(이 헬퍼가 존재하는 이유).
 *   Optional O stage 는 부재가 허용되므로 기본 생성하지 않는다(includeOptionalStage 로 추가).
 * [순수 테스트 계약] 팩토리 반환값은 caller 가 자유롭게 변이해도 다음 호출에 영향이 없도록
 *   호출마다 새 객체+새 uuid 를 만든다(id/executionToken/idempotencyKey 는 호출별 생성).
 */

export {
  canonicalHistoryRows,
  canonicalResourceRows,
  cleanupResourceTables,
  readModelScope,
  seedCompleteStepRuns,
  seedReadModelGraph,
  seedReadModelIssue,
  seedReadModelStepRun,
  startExecutionDefinitionFixture,
};
export type { ExecutionDefinitionFixture, ReadModelGraph };

export type SettlementHeartbeatRow = typeof heartbeatRuns.$inferSelect;
export type SettlementFinalizationRow = typeof heartbeatRunFinalizations.$inferSelect;
export type SettlementStageRow = typeof heartbeatRunFinalizationSteps.$inferSelect;

const T0 = new Date("2024-06-01T00:00:00.000Z");
const TERMINAL_SOURCES = "test-terminal-decision";

const HEARTBEAT_DEFAULTS: Omit<SettlementHeartbeatRow, "id" | "executionToken"> = {
  companyId: randomUUID(),
  agentId: "agent-1",
  issueId: null,
  invocationSource: "on_demand",
  triggerDetail: null,
  status: "succeeded",
  startedAt: T0,
  finishedAt: T0,
  error: null,
  wakeupRequestId: null,
  workflowStepRunId: null,
  workflowExecutionGeneration: null,
  executionScopeKind: "workflow_step",
  executionEpoch: 3,
  executorOwnerId: "default",
  executorOwnerLeaseEpoch: 1,
  executorOwnerLeaseToken: null,
  executorOwnerLeaseExpiresAt: null,
  executorOwnerAcknowledgedAt: T0,
  executorOwnerReleasedAt: T0,
  terminalOutcome: "succeeded",
  terminalDecidedAt: T0,
  terminalDecisionSource: TERMINAL_SOURCES,
  finalizationVersion: 1,
  settledAt: T0,
  exitCode: 0,
  signal: null,
  usageJson: null,
  resultJson: null,
  sessionIdBefore: null,
  sessionIdAfter: null,
  logStore: null,
  logRef: null,
  logBytes: null,
  logSha256: null,
  logCompressed: false,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  errorCode: null,
  externalRunId: null,
  processPid: null,
  processStartedAt: null,
  retryOfRunId: null,
  processLossRetryCount: 0,
  contextSnapshot: null,
  createdAt: T0,
  updatedAt: T0,
};

const FINALIZATION_DEFAULTS: Omit<SettlementFinalizationRow, "id" | "executionToken"> = {
  companyId: randomUUID(),
  heartbeatRunId: randomUUID(),
  executionEpoch: 3,
  terminalOutcome: "succeeded",
  terminalDecisionSource: TERMINAL_SOURCES,
  finalizationVersion: 1,
  state: "pending",
  finalizerLeaseEpoch: 0,
  finalizerLeaseToken: null,
  finalizerOwner: null,
  finalizerLeaseExpiresAt: null,
  attempts: 0,
  maxAttempts: 0,
  lastError: null,
  createdAt: T0,
  updatedAt: T0,
};

const STAGE_DEFAULTS: Omit<SettlementStageRow, "id" | "heartbeatRunFinalizationId" | "idempotencyKey"> = {
  companyId: randomUUID(),
  heartbeatRunId: randomUUID(),
  stageClass: STAGE_CLASS.quiescence,
  stageKind: "executor_quiescence",
  state: "done",
  leaseEpoch: 0,
  leaseToken: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  attempts: 0,
  maxAttempts: 0,
  lastError: null,
  payload: {},
  createdAt: T0,
  updatedAt: T0,
};

export function settlementHeartbeatRow(
  overrides: Partial<SettlementHeartbeatRow> = {},
): SettlementHeartbeatRow {
  return { ...HEARTBEAT_DEFAULTS, id: randomUUID(), executionToken: randomUUID(), ...overrides };
}

export function settlementFinalizationRow(
  overrides: Partial<SettlementFinalizationRow> = {},
): SettlementFinalizationRow {
  return { ...FINALIZATION_DEFAULTS, id: randomUUID(), executionToken: randomUUID(), ...overrides };
}

export function settlementStageRow(
  overrides: Partial<SettlementStageRow> = {},
): SettlementStageRow {
  return {
    ...STAGE_DEFAULTS,
    id: randomUUID(),
    heartbeatRunFinalizationId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

export interface AcceptedSettlementInput {
  id: string;
  companyId: string;
  agentId?: string;
  issueId?: string | null;
  executionScopeKind?: string;
  executionEpoch?: number;
  executionToken?: string;
  terminalOutcome?: "succeeded" | "failed" | "cancelled" | "timed_out";
  terminalDecisionSource?: string;
  workflowStepRunId?: string | null;
  workflowExecutionGeneration?: number | null;
  wakeupRequestId?: string | null;
  includeOptionalStage?: boolean;
}

export interface SettlementRecords {
  heartbeat: SettlementHeartbeatRow;
  finalization: SettlementFinalizationRow;
  stages: SettlementStageRow[];
}

/** 정산 완료 v1 heartbeat + 결속된 pending 무임대 parent + required Q/C(done) stage 행 전체. */
export function acceptedSettlementRecords(input: AcceptedSettlementInput): SettlementRecords {
  const executionToken = input.executionToken ?? randomUUID();
  const executionEpoch = input.executionEpoch ?? 3;
  const terminalOutcome = input.terminalOutcome ?? "succeeded";
  const terminalDecisionSource = input.terminalDecisionSource ?? TERMINAL_SOURCES;
  const heartbeat = settlementHeartbeatRow({
    id: input.id,
    companyId: input.companyId,
    agentId: input.agentId ?? "agent-1",
    issueId: input.issueId ?? null,
    status: terminalOutcome,
    executionScopeKind: input.executionScopeKind ?? "workflow_step",
    executionEpoch,
    executionToken,
    terminalOutcome,
    terminalDecisionSource,
    ...(input.workflowStepRunId !== undefined ? { workflowStepRunId: input.workflowStepRunId } : {}),
    ...(input.workflowExecutionGeneration !== undefined
      ? { workflowExecutionGeneration: input.workflowExecutionGeneration }
      : {}),
    ...(input.wakeupRequestId !== undefined ? { wakeupRequestId: input.wakeupRequestId } : {}),
  });
  const finalization = settlementFinalizationRow({
    companyId: input.companyId,
    heartbeatRunId: input.id,
    finalizationVersion: 1,
    executionEpoch,
    executionToken,
    terminalOutcome,
    terminalDecisionSource,
  });
  const stages = allRequiredStages(heartbeat)
    .filter((stage) => stage.stageClass !== STAGE_CLASS.optional)
    .map((stage) => settlementStageRow({
      companyId: input.companyId,
      heartbeatRunId: heartbeat.id,
      heartbeatRunFinalizationId: finalization.id,
      stageClass: stage.stageClass,
      stageKind: stage.kind,
      idempotencyKey: `settle:${stage.kind}:${heartbeat.id}`,
    }));
  if (input.includeOptionalStage) {
    stages.push(settlementStageRow({
      companyId: input.companyId,
      heartbeatRunId: heartbeat.id,
      heartbeatRunFinalizationId: finalization.id,
      stageClass: STAGE_CLASS.optional,
      stageKind: O_STAGE.livePublication,
      idempotencyKey: `settle:${O_STAGE.livePublication}:${heartbeat.id}`,
    }));
  }
  return { heartbeat, finalization, stages };
}

/** 임베디드 PG 용 — full select 행을 그대로 insert(FK 는 caller 가 그래프 id 로 채운다). */
export async function seedSettlementRecords(db: Db, records: SettlementRecords): Promise<void> {
  await db.insert(heartbeatRuns).values(records.heartbeat);
  await db.insert(heartbeatRunFinalizations).values(records.finalization);
  if (records.stages.length > 0) {
    await db.insert(heartbeatRunFinalizationSteps).values(records.stages);
  }
}
