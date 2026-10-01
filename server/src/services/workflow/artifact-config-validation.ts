import { artifactContractSchema, qaConfigSchema } from '@paperclipai/shared';
import { badRequest } from '../../errors.js';
import { z } from 'zod';
const policySchema = z.object({ deliveryVerification: z.literal('required').optional(), capAcceptance: z.literal('blocked').optional(), qaConfig: qaConfigSchema.optional() });

/** Shared write boundary for native, plugin-backed, and direct store saves. */
export function validateWorkflowQaConfigs(steps: unknown) {
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const parsed = policySchema.safeParse(step);
    if (!parsed.success) throw badRequest('Invalid workflow policy', parsed.error.issues);
  }
}

export function validateToolArtifactContract(adapterConfig: Record<string, unknown> | undefined) {
  if (adapterConfig?.artifactContract === undefined) return;
  const parsed = artifactContractSchema.safeParse(adapterConfig.artifactContract);
  if (!parsed.success) throw badRequest('Invalid tool artifactContract', parsed.error.issues);
}
