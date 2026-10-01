import { artifactContractSchema, qaConfigSchema } from '@paperclipai/shared';
import { badRequest } from '../../errors.js';

/** Shared write boundary for native, plugin-backed, and direct store saves. */
export function validateWorkflowQaConfigs(steps: unknown) {
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!step || typeof step !== 'object' || step.qaConfig === undefined) continue;
    const parsed = qaConfigSchema.safeParse(step.qaConfig);
    if (!parsed.success) throw badRequest('Invalid workflow qaConfig', parsed.error.issues);
  }
}

export function validateToolArtifactContract(adapterConfig: Record<string, unknown> | undefined) {
  if (adapterConfig?.artifactContract === undefined) return;
  const parsed = artifactContractSchema.safeParse(adapterConfig.artifactContract);
  if (!parsed.success) throw badRequest('Invalid tool artifactContract', parsed.error.issues);
}
