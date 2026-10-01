import type { Request } from 'express';
import { canonicalQaJson } from '@paperclipai/shared';
import { assertBoard } from './authz.js';
import { workflowDefinitions, type Db } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { workflowService } from '../services/workflow/engine.js';

function policy(steps: unknown): string {
  if (!Array.isArray(steps)) return '[]';
  return canonicalQaJson(steps.filter(step => step?.qaConfig !== undefined || step?.deliveryVerification !== undefined || step?.capAcceptance !== undefined)
    .map(step => ({ id: step.id, qaConfig: step.qaConfig, deliveryVerification: step.deliveryVerification, capAcceptance: step.capAcceptance }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

/** Whole-step deletion/omission is a policy removal too, not an authorization bypass. */
export function assertWorkflowQaConfigWrite(req: Request, previousSteps: unknown = []) {
  if (req.body.steps !== undefined && policy(req.body.steps) !== policy(previousSteps)) assertBoard(req);
}

/** Serialize the policy comparison with the write; a stale route read cannot remove a new board policy. */
export async function updateAuthorizedWorkflowDefinition(db: Db, id: string, req: Request) {
  if (req.actor.type !== 'agent' || req.body.steps === undefined) {
    return workflowService.updateDefinition(db, id, req.body);
  }
  return db.transaction(async tx => {
    const [current] = await tx.select({ steps: workflowDefinitions.stepsJson }).from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, id)).for('update');
    if (!current) return null;
    assertWorkflowQaConfigWrite(req, current.steps);
    return workflowService.updateDefinition(tx as unknown as Db, id, req.body);
  });
}
