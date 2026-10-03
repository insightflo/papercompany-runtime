import './helpers/workflow-control-node-boundary.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import * as toolContext from '../services/workflow/core-tool-context.js';
import { heartbeatRuns, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from '@paperclipai/db';
import { agentArtifactFixture } from './helpers/agent-artifact-tool-fixture.js';
import { admittedProducer } from './helpers/admitted-producer.js';
import { resetStepRunForRework } from '../services/workflow/control-flow/step-reset.js';
import { freezeCompanyArtifactAttempt } from '../services/workflow/artifact-attempt-start.js';

// Several real DB admissions and byte-verified tool processes per scenario.
vi.setConfig({ testTimeout: 30_000 });

it('accepts the issue link fallback only with the original admitted attempt proof', async () => {
  const f = await agentArtifactFixture();
  await f.db.update(heartbeatRuns).set({ workflowStepRunId: null }).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  const result = await f.call('qa');
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await f.step('qa')).metadata.toolArtifactReceipt).toMatchObject({ stepRunId: f.qaId });
});

it('engine publication consumes agent QA using the QA attempt, not its own request id', async () => {
  const f = await agentArtifactFixture(), qa = await f.call('qa');
  expect(qa.status).toBe(200);
  await f.finish('qa');
  const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [definition] = await f.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  const steps = (definition.stepsJson as Array<{ id: string }>).map(s => s.id === 'publisher' ? { ...s, type: 'tool', agentId: '' } : s);
  await f.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, run.workflowId));
  const artifactExecution = await freezeCompanyArtifactAttempt({ db: f.db, companyId: f.companyId, toolName: 'publisher',
    step: steps.find(s => s.id === 'publisher'), executionGeneration: 0, requestId: 'publisher' });
  await f.db.update(workflowStepRuns).set({ issueId: null, lastDispatchRequestId: 'publisher', metadata: { artifactExecution } })
    .where(eq(workflowStepRuns.id, f.publishId));
  const published = await f.execute('publisher');
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  await f.complete('publisher', published);
  expect((await f.step('publisher')).status).toBe('completed');
});

it('a real rework invalidates the old receipt and heartbeat but permits fresh admitted QA', async () => {
  const f = await agentArtifactFixture(), qa = await f.call('qa');
  expect(qa.status).toBe(200);
  await f.finish('qa');
  await resetStepRunForRework({ db: f.db, companyId: f.companyId, stepRun: await f.step('qa') });
  expect((await f.call('publisher', f.publishArgs(qa.body.data.artifactPath))).status).not.toBe(200);
  await f.db.update(workflowStepRuns).set({ status: 'running' }).where(eq(workflowStepRuns.id, f.qaId));
  expect((await f.call('qa')).body.error).toBe('artifact_tool_step_binding_required');
  const heartbeatId = randomUUID();
  await admittedProducer(f.db, { companyId: f.companyId, agentId: f.agentId, issueId: f.calls.qa.issueId,
    stepRunId: f.qaId, heartbeatId, status: 'running' });
  const [previous] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  await f.db.update(heartbeatRuns).set({ contextSnapshot: previous.contextSnapshot }).where(eq(heartbeatRuns.id, heartbeatId));
  await f.db.update(issues).set({ executionRunId: heartbeatId }).where(eq(issues.id, f.calls.qa.issueId));
  f.calls.qa.heartbeatId = heartbeatId;
  const next = await f.call('qa');
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  expect((await f.step('qa')).metadata.toolArtifactReceipt).toMatchObject({ iterationIndex: 1 });
});

it('late tool completion after real rework cannot write or settle the replacement attempt', async () => {
  const f = await agentArtifactFixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  const marker = `${script}.entered`, release = `${script}.release`;
  await writeFile(script, `import fs2 from 'node:fs'; fs2.writeFileSync(${JSON.stringify(marker)},'entered');
while(!fs2.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));\n${await readFile(script, 'utf8')}`);
  const first = f.call('qa').then(r => r);
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 5000 }).toBe('entered');
    const before = await f.step('qa');
    await resetStepRunForRework({ db: f.db, companyId: f.companyId, stepRun: before });
    const reset = await f.step('qa');
    await writeFile(release, 'go');
    expect((await first).status).not.toBe(200);
    expect((await f.step('qa')).metadata).toEqual(reset.metadata);
  } finally { await writeFile(release, 'go'); await first; }
});

it('does not adopt a reworked iteration during environment preparation before launch', async () => {
  const f = await agentArtifactFixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  const marker = `${script}.launched`;
  await writeFile(script, `import fs2 from 'node:fs'; fs2.writeFileSync(${JSON.stringify(marker)},'launched');\n${await readFile(script, 'utf8')}`);
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const original = toolContext.resolveWorkflowRunStepEnv;
  const spy = vi.spyOn(toolContext, 'resolveWorkflowRunStepEnv').mockImplementation(async (...args) => {
    entered(); await gate; return original(...args);
  });
  const first = f.call('qa').then(r => r);
  try {
    await preparing;
    await resetStepRunForRework({ db: f.db, companyId: f.companyId, stepRun: await f.step('qa') });
    await f.db.update(workflowStepRuns).set({ status: 'running' }).where(eq(workflowStepRuns.id, f.qaId));
    release();
    expect((await first).status).not.toBe(200);
    expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
  } finally { release(); await first; spy.mockRestore(); }
});

it('rework replaces an abandoned claim without allowing a same-attempt takeover', async () => {
  const f = await agentArtifactFixture();
  const before = await f.step('qa');
  await f.db.update(workflowStepRuns).set({ metadata: { toolQueue: { status: 'claimed',
    executionGeneration: before.executionGeneration, retryCount: before.retryCount, iterationIndex: before.iterationIndex } } })
    .where(eq(workflowStepRuns.id, f.qaId));
  expect((await f.call('qa')).status).toBe(409);
  await resetStepRunForRework({ db: f.db, companyId: f.companyId, stepRun: await f.step('qa') });
  await f.db.update(workflowStepRuns).set({ status: 'running' }).where(eq(workflowStepRuns.id, f.qaId));
  const heartbeatId = randomUUID();
  await admittedProducer(f.db, { companyId: f.companyId, agentId: f.agentId, issueId: f.calls.qa.issueId,
    stepRunId: f.qaId, heartbeatId, status: 'running' });
  const [previous] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  await f.db.update(heartbeatRuns).set({ contextSnapshot: previous.contextSnapshot }).where(eq(heartbeatRuns.id, heartbeatId));
  await f.db.update(issues).set({ executionRunId: heartbeatId }).where(eq(issues.id, f.calls.qa.issueId));
  f.calls.qa.heartbeatId = heartbeatId;
  const next = await f.call('qa');
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  expect((await f.step('qa')).metadata.toolArtifactReceipt).toMatchObject({ iterationIndex: 1 });
});

it('requires a completed earlier QA step rather than QA and publication on one running step', async () => {
  const f = await agentArtifactFixture(), qa = await f.call('qa');
  expect(qa.status).toBe(200);
  const response = await f.call('qa', f.publishArgs(qa.body.data.artifactPath), {}, 'publisher');
  expect(response.status).not.toBe(200);
  expect((await f.step('qa')).status).toBe('running');
  expect((await f.step('qa')).metadata.toolResult).not.toMatchObject({ success: true, toolName: 'publisher' });
});

it('replays a same-key HTTP retry without replacing the current QA evidence', async () => {
  const f = await agentArtifactFixture();
  const first = await f.call('qa', undefined, { idempotencyKey: 'same-effect' });
  expect(first.status).toBe(200);
  const before = await f.step('qa');
  const replay = await f.call('qa', undefined, { idempotencyKey: 'same-effect' });
  expect(replay.headers['x-idempotent-replay']).toBe('true');
  expect(replay.body).toEqual(first.body);
  expect(await f.step('qa')).toEqual(before);
});

it.each(['input', 'no-contract', 'receipt-from-other-run', 'missing-wake', 'issue-assignee'])('rejects %s without inventing artifact authority', async kind => {
  const f = await agentArtifactFixture();
  let params: unknown;
  if (kind === 'input') params = { content: path.join(f.assetsDir, 'hero.png'), assetsDir: f.assetsDir };
  if (kind === 'no-contract') {
    const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    const [definition] = await f.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    await f.db.update(workflowDefinitions).set({ stepsJson: (definition.stepsJson as Array<{ id: string }>).map(s =>
      s.id === 'qa' ? { ...s, toolArtifactContract: undefined } : s) }).where(eq(workflowDefinitions.id, run.workflowId));
  }
  if (kind === 'receipt-from-other-run') {
    const other = await agentArtifactFixture(), qa = await other.call('qa');
    expect(qa.status).toBe(200); await other.finish('qa');
    expect((await f.call('publisher', f.publishArgs(qa.body.data.artifactPath))).body.error).toBe('qa_artifact_consumer_receipt_required');
    return;
  }
  if (kind === 'missing-wake') await f.db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  if (kind === 'issue-assignee') {
    const [producer] = await f.db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.title, 'Write')));
    await f.db.update(issues).set({ assigneeAgentId: producer.assigneeAgentId }).where(eq(issues.id, f.calls.qa.issueId));
  }
  const result = await f.call('qa', params);
  expect(result.status).not.toBe(200);
  expect((await f.step('qa')).metadata.toolArtifactReceipt).toBeUndefined();
});
