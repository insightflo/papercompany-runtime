import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns, type Db } from '@paperclipai/db';
import { artifactContractSchema, qaConfigSchema, resolveEffectiveQaConfig } from '@paperclipai/shared';
import { hashArtifactContract, hashQaConfig } from './qa-rules.js';
import { readObject } from './core-tool-context.js';
import { loadExecutionDefinition } from './execution-definition.js';

const schema = z.object({ schemaVersion: z.literal('workflow.artifact-execution.v1'),
  executionGeneration: z.number().int().nonnegative(), requestId: z.string().min(1),
  contract: artifactContractSchema, qaConfig: qaConfigSchema,
  contractHash: z.string().regex(/^[a-f0-9]{64}$/), qaConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenArtifactAttempt = z.infer<typeof schema>;

/** Call while constructing the attempt metadata, before its running/dispatch CAS. */
export function freezeArtifactAttempt(input: { adapterConfig: unknown; step: unknown;
  executionGeneration: number; requestId: string }): FrozenArtifactAttempt | null {
  const config = readObject(input.adapterConfig), step = readObject(input.step);
  if (config.artifactContract === undefined) {
    if (step.toolArtifactContract !== undefined) throw new Error('artifact_contract_required');
    return null;
  }
  const parsed = artifactContractSchema.safeParse(config.artifactContract);
  if (!parsed.success) throw new Error('artifact_contract_invalid');
  const contract = parsed.data;
  const declared = readObject(step.toolArtifactContract);
  if (step.toolArtifactContract && (declared.role !== contract.role || declared.schemaVersion !== contract.resultSchemaVersion)) {
    throw new Error('artifact_contract_step_mismatch');
  }
  const qaConfig = resolveEffectiveQaConfig(contract.defaultRules, step.qaConfig === undefined ? undefined : qaConfigSchema.parse(step.qaConfig));
  return schema.parse({ schemaVersion: 'workflow.artifact-execution.v1', executionGeneration: input.executionGeneration,
    requestId: input.requestId, contract, qaConfig, contractHash: hashArtifactContract(contract), qaConfigHash: hashQaConfig(qaConfig) });
}
export function readFrozenArtifactAttempt(raw: unknown, scope?: { executionGeneration: number; requestId: string }) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('artifact_contract_snapshot_required');
  const frozen = parsed.data;
  if (scope && (scope.executionGeneration !== frozen.executionGeneration || scope.requestId !== frozen.requestId)) {
    throw new Error('artifact_contract_snapshot_stale');
  }
  if (frozen.contractHash !== hashArtifactContract(frozen.contract) || frozen.qaConfigHash !== hashQaConfig(frozen.qaConfig)) {
    throw new Error('artifact_contract_snapshot_hash');
  }
  return frozen;
}

/**
 * [2026-10-04 tech-scout 사고] 완료(completed) 소스 소비 펜스. finalizeRunTerminal/
 *   recoverTerminalRun/resetForResume 은 완료 step 행의 execution_generation 을 올리지만
 *   냉동 영수증과 발사 id 는 그대로 둔다. 따라서 완료 소스는 (a) 냉동 세대가 현재 행 세대를
 *   넘지 않고 (b) 생성 발사가 여전히 행의 발사 권위(lastDispatchRequestId)이면 계속 소비
 *   가능하다. running/failed 행(완료 기록 경로)은 readFrozenArtifactAttempt 의 정확-일치
 *   스코프를 그대로 쓴다. 바이트 무결성은 영수증 계층에서 매 소비마다 재검증된다.
 */
export function readCompletedSourceArtifactAttempt(raw: unknown,
  row: { executionGeneration: number; lastDispatchRequestId: string | null }): FrozenArtifactAttempt {
  const frozen = readFrozenArtifactAttempt(raw);
  if (frozen.executionGeneration > row.executionGeneration
    || frozen.requestId !== (row.lastDispatchRequestId ?? '')) throw new Error('artifact_contract_snapshot_stale');
  return frozen;
}

/** Frozen workflow metadata is authoritative. Live config only detects a missing required freeze. */
export async function loadArtifactAttempt(input: { db: Db; companyId: string; workflowRunId?: string | null;
  stepRunId?: string | null; stepId?: string | null; requestId?: string; adapterConfig?: unknown }) {
  if (!input.workflowRunId || !input.stepRunId) {
    if (readObject(input.adapterConfig).artifactContract !== undefined) throw new Error('artifact_contract_workflow_required');
    return null;
  }
  const [row] = await input.db.select({ step: workflowStepRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.id, input.workflowRunId), eq(workflowStepRuns.id, input.stepRunId)));
  if (!row) {
    if (readObject(input.adapterConfig).artifactContract !== undefined) throw new Error('artifact_contract_snapshot_stale');
    return null;
  }
  if (row.step.stepId !== input.stepId) throw new Error('artifact_contract_snapshot_stale');
  if (row.step.metadata.artifactExecution !== undefined) return readFrozenArtifactAttempt(row.step.metadata.artifactExecution,
    { executionGeneration: row.step.executionGeneration, requestId: input.requestId ?? "" });
  const execution = await loadExecutionDefinition(input.db, input.workflowRunId, { requireHistorical: false });
  const step = execution.steps.find(s => s.id === input.stepId);
  if (readObject(step).toolArtifactContract !== undefined || readObject(input.adapterConfig).artifactContract !== undefined) {
    throw new Error('artifact_contract_snapshot_required');
  }
  return null;
}
