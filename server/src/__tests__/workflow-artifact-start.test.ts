import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { companies, toolDefinitions, workflowDefinitions, workflowStepRuns } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { progressDatabase } from './helpers/tool-progress.js';
import { setupWorkflow } from './helpers/workflow-step-retry-fixtures.js';
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor, syncWorkflowRunState } from '../services/workflow/dag-engine.js';
import { loadArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const contract = { role: 'qa', resultFileName: 'checks.json', resultSchemaVersion: 'workflow.qa-result.v1', resultAdapter: 'generic',
  inputParams: { content: 'document' }, deploymentFiles: ['checker.mjs'], inputEnvelopeVersion: 'input.v1',
  defaultRules: { rules: { 'tag-count': { params: { min: 2 } } } } };
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterEach(() => { setWorkflowToolStepExecutor(null); });
afterAll(async () => { await fixture?.cleanup(); });
async function seed(config: unknown = contract, declared = true) {
  const [company] = await fixture.db.insert(companies).values({ name: 'Start freeze', issuePrefix: randomUUID() }).returning();
  const [tool] = await fixture.db.insert(toolDefinitions).values({ companyId: company.id, name: 'checker', adapterType: 'builtin',
    adapterConfig: config === undefined ? {} : { artifactContract: config } }).returning();
  const step = { id: 'check', name: 'Check', type: 'tool', toolNames: ['checker'], onFailure: 'retry', maxRetries: 1,
    ...(config !== null ? { qaConfig: { rules: { 'tag-count': { params: { min: 3 } } } } } : {}),
    ...(declared ? { toolArtifactContract: { role: 'qa', schemaVersion: 'workflow.qa-result.v1' } } : {}) };
  const workflow = await setupWorkflow(fixture.db, company.id, [step]);
  setWorkflowToolStepExecutor(async () => ({ accepted: true }));
  return { ...workflow, companyId: company.id, tool, step };
}
async function readStep(runId: string) {
  const [row] = await fixture.reader.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  return row;
}
it('freezes config at running CAS and honors it after live definition and tool edits', async () => {
  const world = await seed();
  await syncWorkflowRunState(fixture.db, world.runId);
  const row = await readStep(world.runId);
  expect(row.status).toBe('running');
  expect(row.metadata.artifactExecution).toMatchObject({ requestId: row.lastDispatchRequestId,
    executionGeneration: row.executionGeneration, contract: { resultFileName: 'checks.json' },
    qaConfig: { rules: { 'tag-count': { params: { min: 3 } } } }, contractHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await fixture.db.update(toolDefinitions).set({ adapterConfig: { artifactContract: { ...contract, resultFileName: 'changed.json' } } }).where(eq(toolDefinitions.id, world.tool.id));
  await fixture.db.update(workflowDefinitions).set({ stepsJson: [{ ...world.step, qaConfig: { rules: { 'tag-count': { params: { min: 9 } } } } }] }).where(eq(workflowDefinitions.id, world.wfId));
  const loaded = await loadArtifactAttempt({ db: fixture.reader, companyId: world.companyId, workflowRunId: world.runId,
    stepRunId: row.id, stepId: row.stepId, requestId: row.lastDispatchRequestId!, adapterConfig: {} });
  expect(loaded!.contract.resultFileName).toBe('checks.json');
  expect(loaded!.qaConfig.rules['tag-count']!.params!.min).toBe(3);
});
it('new retry snapshots current contract and replaces the prior request binding', async () => {
  const world = await seed();
  await syncWorkflowRunState(fixture.db, world.runId);
  const first = await readStep(world.runId);
  await fixture.db.update(toolDefinitions).set({ adapterConfig: { artifactContract: { ...contract, resultFileName: 'next.json' } } }).where(eq(toolDefinitions.id, world.tool.id));
  await completeWorkflowToolStepFromResult(fixture.db, { companyId: world.companyId, stepRunId: first.id,
    requestId: first.lastDispatchRequestId!, success: false, error: 'retry fixture' });
  const next = await readStep(world.runId);
  expect(next.status).toBe('running'); expect(next.retryCount).toBe(1);
  expect(next.lastDispatchRequestId).not.toBe(first.lastDispatchRequestId);
  expect(next.metadata.artifactExecution).toMatchObject({ requestId: next.lastDispatchRequestId, contract: { resultFileName: 'next.json' } });
});
it.each([null, { ...contract, bad: true }])('invalid declared contract fails before queued dispatch: %j', async invalid => {
  const world = await seed(invalid);
  await syncWorkflowRunState(fixture.db, world.runId);
  const row = await readStep(world.runId);
  expect(row.status).toBe('failed');
  expect(row.lastDispatchErrorSummary).toContain('artifact_contract_invalid');
  expect(row.metadata.toolQueue).toBeUndefined();
});
it('missing declared tool contract fails closed', async () => {
  const world = await seed();
  await fixture.db.update(toolDefinitions).set({ adapterConfig: {} }).where(eq(toolDefinitions.id, world.tool.id));
  await syncWorkflowRunState(fixture.db, world.runId);
  expect((await readStep(world.runId)).lastDispatchErrorSummary).toContain('artifact_contract_required');
});
it('dispatch rejection retains the current frozen policy for durable diagnostics', async () => {
  const world = await seed();
  await fixture.db.update(workflowDefinitions).set({ stepsJson: [{ ...world.step, maxRetries: 0 }] }).where(eq(workflowDefinitions.id, world.wfId));
  await syncWorkflowRunState(fixture.db, world.runId);
  const before = await readStep(world.runId);
  setWorkflowToolStepExecutor(async () => ({ accepted: false }));
  await processQueuedWorkflowToolStepRuns(fixture.db);
  const after = await readStep(world.runId);
  expect(after.status).toBe('failed');
  expect(after.metadata.artifactExecution).toEqual(before.metadata.artifactExecution);
});
it('qaConfig alone cannot silently downgrade to an ordinary tool without a contract', async () => {
  const world = await seed(contract, false);
  await fixture.db.update(toolDefinitions).set({ adapterConfig: {} }).where(eq(toolDefinitions.id, world.tool.id));
  await syncWorkflowRunState(fixture.db, world.runId);
  expect((await readStep(world.runId)).lastDispatchErrorSummary).toBe('artifact_contract_required');
});
it('uses a declared tool contract even without the optional step artifact marker', async () => {
  const world = await seed(contract, false);
  await syncWorkflowRunState(fixture.db, world.runId);
  expect((await readStep(world.runId)).metadata.artifactExecution).toMatchObject({ contract: { resultFileName: 'checks.json' } });
});
it('does not adopt another company same-name contract', async () => {
  const world = await seed();
  await seed();
  await fixture.db.delete(toolDefinitions).where(eq(toolDefinitions.id, world.tool.id));
  await syncWorkflowRunState(fixture.db, world.runId);
  expect((await readStep(world.runId)).lastDispatchErrorSummary).toBe('artifact_contract_required');
});
it('ordinary new attempt removes a stale prior artifact snapshot', async () => {
  const world = await seed(null, false);
  await fixture.db.update(toolDefinitions).set({ adapterConfig: {} }).where(eq(toolDefinitions.id, world.tool.id));
  await fixture.db.insert(workflowStepRuns).values({ workflowRunId: world.runId, stepId: 'check', status: 'pending', metadata: { artifactExecution: { stale: true } } });
  await syncWorkflowRunState(fixture.db, world.runId);
  const row = await readStep(world.runId);
  expect(row.status).toBe('running'); expect(row.metadata.artifactExecution).toBeUndefined();
});
