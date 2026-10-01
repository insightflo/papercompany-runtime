import { toolDefinitions, type Db } from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import { freezeArtifactAttempt, type FrozenArtifactAttempt } from './artifact-contract-runtime.js';

/** Resolve only the company's tool. Never adopt a same-name tool from another company. */
export async function freezeCompanyArtifactAttempt(input: {
  db: Db; companyId: string; toolName: string; step: unknown; executionGeneration: number; requestId: string;
}) {
  const [tool] = await input.db.select({ adapterConfig: toolDefinitions.adapterConfig }).from(toolDefinitions)
    .where(and(eq(toolDefinitions.companyId, input.companyId), eq(toolDefinitions.name, input.toolName))).limit(1);
  const step = input.step as { qaConfig?: unknown } | null;
  if (step?.qaConfig !== undefined && tool?.adapterConfig.artifactContract === undefined) {
    throw new Error('artifact_contract_required');
  }
  return freezeArtifactAttempt({ ...input, adapterConfig: tool?.adapterConfig ?? {} });
}

export function artifactAttemptMetadata(metadata: Record<string, unknown>, frozen: FrozenArtifactAttempt | null) {
  const { artifactExecution: _previous, ...next } = metadata;
  return frozen ? { ...next, artifactExecution: frozen } : next;
}
