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
