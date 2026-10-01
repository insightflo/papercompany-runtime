import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from '@paperclipai/db';
import { completeWorkflowToolStepFromResult } from '../services/workflow/dag-engine.js';
import { isStructuralGateStep } from '../services/workflow/control-flow/structural-gate.js';
import { validateStructuralGateReadinessForSteps } from '../services/workflow/control-flow/structural-gate-readiness.js';
import { isDeliveryReadbackStep } from '../services/workflow/delivery-verification-gate.js';
import { progressDatabase } from './helpers/tool-progress.js';
import { createWorkflowDefinition, createWorkflowRun } from '../services/workflow/workflow-store.js';
import { loadExecutionDefinition } from '../services/workflow/execution-definition.js';
import { buildCompanyWorkflowExecutionSteps } from '../services/workflow/company-execution-steps.js';
import { replacementDefinitionHash } from '../services/workflow/replacement-definition.js';

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const contract = { role: 'publication', resultFileName: 'result.json', resultSchemaVersion: 'workflow.publication-result.v1',
  resultAdapter: 'generic', inputParams: { content: 'document' }, deploymentFiles: ['run.mjs'], inputEnvelopeVersion: 'input.v1',
  publication: { identity: { param: 'id' }, bindings: [{ resultPointer: '/date', parameter: 'date' }],
    publishedAt: { resultPointer: '/publishedAt', dateParam: 'date', suffix: 'T00:00:00.000Z' } } };
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

describe('company-scoped delivery policy capture', () => {
  it('preserves structural publication verification through frozen reload and rejects verdict-free completion', async () => {
    const [company] = await fixture.db.insert(companies).values({ name: 'Structural fixture', issuePrefix: randomUUID() }).returning();
    const [tool] = await fixture.db.insert(toolDefinitions).values({ companyId: company.id, name: 'neutral-check', adapterType: 'builtin',
      adapterConfig: { artifactContract: { ...contract, role: 'publication-verify', publication: undefined, consumerParams: { receipt: 'receipt' } } },
    }).returning();
    const definition = await createWorkflowDefinition(fixture.db, { companyId: company.id, name: 'structural', steps: [
      { id: 'send', name: 'Send', agentId: '', dependencies: [], deliveryVerification: 'required' },
      { id: 'check', name: 'Check', agentId: '', type: 'tool', qaType: 'structural', toolNames: ['neutral-check'], dependencies: ['send'] },
    ] });
    const run = await createWorkflowRun(fixture.db, { companyId: company.id, workflowId: definition.id, triggeredBy: 'manual', triggerSource: 'manual' });
    await fixture.db.update(toolDefinitions).set({ adapterConfig: {} }).where(eq(toolDefinitions.id, tool.id));
    const loaded = await loadExecutionDefinition(fixture.reader, run.id, { requireHistorical: true });
    expect(loaded.steps).toHaveLength(2);
    expect(loaded.steps[1].qaType).toBe('structural');
    expect(isStructuralGateStep(loaded.steps[1])).toBe(true);
    expect(isDeliveryReadbackStep(loaded.steps[1])).toBe(true);
    const readinessErrors = await validateStructuralGateReadinessForSteps({ db: fixture.db, companyId: company.id, steps: loaded.steps });
    expect(readinessErrors).toEqual(['[check] Structural gate must declare assigneeAgentId as grant subject.']);
    await fixture.db.update(workflowRuns).set({ status: 'running' }).where(eq(workflowRuns.id, run.id));
    await fixture.db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: 'send', status: 'completed', completedAt: new Date() });
    const [gate] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: 'check', status: 'running', lastDispatchRequestId: 'request' }).returning();
    // Missing request IDs must not enter generic tool completion.
    await completeWorkflowToolStepFromResult(fixture.db, { companyId: company.id, workflowRunId: run.id, stepRunId: gate.id, success: true, data: {} });
    const [unmodified] = await fixture.reader.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate.id));
    expect(unmodified.status).toBe('running');
    await completeWorkflowToolStepFromResult(fixture.db, { companyId: company.id, workflowRunId: run.id, stepRunId: gate.id, requestId: 'request', success: true, data: {} });
    const [failed] = await fixture.reader.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate.id));
    expect(failed.status).toBe('failed');
    const verdicts = await fixture.reader.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, gate.id));
    expect(verdicts.filter(event => event.eventType === 'workflow_validation_verdict')).toHaveLength(0);
  });
  it('resolves tools within the company, freezes roles, and retains replacement hash parity', async () => {
    const [a, b] = await fixture.db.insert(companies).values([
      { name: 'Alpha fixture', issuePrefix: randomUUID() }, { name: 'Beta fixture', issuePrefix: randomUUID() },
    ]).returning();
    const [tool] = await fixture.db.insert(toolDefinitions).values({ companyId: a.id, name: 'neutral', adapterType: 'builtin', adapterConfig: { artifactContract: contract } }).returning();
    const steps = [{ id: 'send', name: 'Send result', agentId: '', dependencies: [], toolNames: ['neutral'] }];
    const definition = await createWorkflowDefinition(fixture.db, { companyId: a.id, name: 'delivery', steps });
    const [raw] = await fixture.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definition.id));
    expect(await buildCompanyWorkflowExecutionSteps(fixture.reader, { ...raw, companyId: b.id })).toHaveLength(1);
    const run = await createWorkflowRun(fixture.db, { companyId: a.id, workflowId: definition.id, triggeredBy: 'manual', triggerSource: 'manual' });
    const frozen = await loadExecutionDefinition(fixture.reader, run.id, { requireHistorical: true });
    expect(frozen.steps).toHaveLength(2);
    expect(frozen.steps[0]).toMatchObject({ deliveryVerification: 'required' });
    expect(frozen.steps[1]).toMatchObject({ qaType: 'delivery' });
    expect(await replacementDefinitionHash(fixture.reader, raw, null as never, run.id)).toBe(frozen.definitionHash);
    await fixture.db.update(toolDefinitions).set({ adapterConfig: {} }).where(eq(toolDefinitions.id, tool.id));
    const reloaded = await loadExecutionDefinition(fixture.reader, run.id, { requireHistorical: true });
    expect(reloaded).toEqual(frozen);
    expect(await buildCompanyWorkflowExecutionSteps(fixture.reader, raw)).toHaveLength(1);
    expect(await replacementDefinitionHash(fixture.reader, raw, null as never, run.id)).not.toBe(frozen.definitionHash);
  });
});
