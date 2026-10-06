import './helpers/workflow-control-node-boundary.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agentToolGrants, heartbeatRuns, issues, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns } from '@paperclipai/db';
import { agentArtifactFixture } from './helpers/agent-artifact-tool-fixture.js';
import { readQaReceiptBytes } from '../services/workflow/qa-artifact-receipt.js';
import { executeCoreWorkflowTool } from '../services/workflow/core-tool-executor.js';

// Real DB admission + child processes + executable byte hashing, not mocked unit work.
vi.setConfig({ testTimeout: 30_000 });

it('agent QA stores its verified receipt; agent publication and verification consume earlier completed attempts', async () => {
  const f = await agentArtifactFixture(), qa = await f.call('qa', undefined, {
    stepRunId: randomUUID(), workflowRunId: randomUUID(), requestId: 'untrusted-client' });
  expect(qa.status, JSON.stringify(qa.body)).toBe(200);
  const step = await f.step('qa'), receipt = step.metadata.toolArtifactReceipt;
  expect(step.status).toBe('running'); // Tool submission does not complete the agent's work.
  expect(receipt).toMatchObject({ companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId,
    stepRunId: f.qaId, executionGeneration: 2, requestId: step.lastDispatchRequestId });
  expect(step.lastDispatchRequestId).not.toBe('untrusted-client');
  expect(qa.body.data.artifactPath).toEqual(expect.any(String));
  await f.finish('qa');
  expect((await readQaReceiptBytes(f.db, { companyId: f.companyId, workflowRunId: f.runId, stepId: 'qa' })).receipt).toEqual(receipt);
  const published = await f.call('publisher', f.publishArgs(qa.body.data.artifactPath));
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect((await f.step('publisher')).metadata.toolResult).toMatchObject({ success: true, artifactPath: published.body.data.artifactPath });
  await f.finish('publisher');
  const verified = await f.call('inspector', { publishedRecord: published.body.data.artifactPath });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  expect(verified.body.data.scope).toMatchObject({ stepRunId: f.verifyId, requestId: (await f.step('inspector')).lastDispatchRequestId });
});

it.each(['retry', 'iteration', 'request', 'producer'])('publication rejects stale QA %s identity', async kind => {
  const f = await agentArtifactFixture(), qa = await f.call('qa');
  expect(qa.status, JSON.stringify(qa.body)).toBe(200);
  await f.finish('qa');
  if (kind === 'producer') {
    const [producer] = await f.db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, 'write')));
    await f.db.update(workflowStepRuns).set({ executionGeneration: 2 }).where(eq(workflowStepRuns.id, producer.id));
  } else await f.db.update(workflowStepRuns).set(kind === 'retry' ? { retryCount: 1 } : kind === 'iteration' ? { iterationIndex: 1 } : { lastDispatchRequestId: 'reworked' })
    .where(eq(workflowStepRuns.id, f.qaId));
  const published = await f.call('publisher', f.publishArgs(qa.body.data.artifactPath));
  expect(published.status).not.toBe(200);
  expect((await f.step('publisher')).metadata.toolResult).not.toMatchObject({ success: true });
});

// [2026-10-04 tech-scout 사고 교정] 종결/복구 사이클은 완료 QA 행의 세대를 발사 id · 영수증 · 바이트
// 변경 없이 올린다. 세대만 올라간 완료 소스는 낡은 것이 아니므로 발행은 이를 소비한다.
// 진짜 무효화(재발사·재시도·반복·생산자 교체)는 위의 identity 검사가 계속 차단한다.
it('publication consumes the completed QA source across recovery generation bumps', async () => {
  const f = await agentArtifactFixture(), qa = await f.call('qa');
  expect(qa.status, JSON.stringify(qa.body)).toBe(200);
  await f.finish('qa');
  await f.db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, f.qaId));
  const published = await f.call('publisher', f.publishArgs(qa.body.data.artifactPath));
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect((await f.step('publisher')).metadata.toolResult).toMatchObject({ success: true, artifactPath: published.body.data.artifactPath });
});

it.each(['no-step', 'not-running', 'foreign-company', 'foreign-agent', 'old-heartbeat', 'retry', 'iteration', 'finished-run', 'mission'])
('fails closed on %s even if the caller supplies matching-looking workflow parameters', async scenario => {
  const f = await agentArtifactFixture();
  if (scenario === 'no-step') await f.db.update(heartbeatRuns).set({ workflowStepRunId: null, issueId: null })
    .where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  if (scenario === 'not-running') await f.db.update(workflowStepRuns).set({ status: 'pending' }).where(eq(workflowStepRuns.id, f.qaId));
  if (scenario === 'foreign-company') {
    const other = await agentArtifactFixture();
    await f.db.update(heartbeatRuns).set({ workflowStepRunId: other.qaId }).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  }
  if (scenario === 'foreign-agent') {
    const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    await f.db.update(workflowDefinitions).set({ stepsJson: f.steps.map(s => ({ ...s, agentId: randomUUID() })) })
      .where(eq(workflowDefinitions.id, run.workflowId));
  }
  if (scenario === 'old-heartbeat') await f.db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, f.qaId));
  if (scenario === 'retry' || scenario === 'iteration') await f.db.update(workflowStepRuns)
    .set(scenario === 'retry' ? { retryCount: 1 } : { iterationIndex: 1 }).where(eq(workflowStepRuns.id, f.qaId));
  if (scenario === 'finished-run') await f.db.update(workflowRuns).set({ status: 'completed' }).where(eq(workflowRuns.id, f.runId));
  if (scenario === 'mission') await f.db.update(issues).set({ missionId: null }).where(eq(issues.id, f.calls.qa.issueId));
  const response = await f.call('qa', { content: f.content, stepRunId: f.qaId, workflowRunId: f.runId });
  expect(response.status).toBe(422);
  expect(response.body.error).toBe('artifact_tool_step_binding_required');
  expect((await f.step('qa')).metadata.toolArtifactReceipt).toBeUndefined();
});

it('allows sequential repeated QA with a fresh request and refuses simultaneous calls without overwriting evidence', async () => {
  const f = await agentArtifactFixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  const marker = `${script}.entered`, release = `${script}.release`;
  await writeFile(script, `import fs2 from 'node:fs'; fs2.writeFileSync(${JSON.stringify(marker)},'entered');
while(!fs2.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10));\n${await readFile(script, 'utf8')}`);
  const first = f.call('qa').then(r => r);
  let before: Awaited<ReturnType<typeof f.step>>;
  try {
    await expect.poll(async () => readFile(marker, 'utf8').catch(() => ''), { timeout: 5000 }).toBe('entered');
    before = await f.step('qa');
    const overlap = await f.call('qa', undefined, { idempotencyKey: 'overlap-key' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toBe('artifact_tool_step_call_in_progress');
    expect((await f.step('qa')).lastDispatchRequestId).toBe(before.lastDispatchRequestId);
  } finally { await writeFile(release, 'go'); await first; }
  expect((await first).status).toBe(200);
  // The 409 executed nothing, so its idempotency claim was released: the same key now executes.
  const second = await f.call('qa', undefined, { idempotencyKey: 'overlap-key' });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  expect(second.headers['x-idempotent-replay']).toBeUndefined();
  const after = await f.step('qa');
  expect(after.lastDispatchRequestId).not.toBe(before.lastDispatchRequestId);
  expect(after.metadata.toolArtifactReceipt).toMatchObject({ requestId: after.lastDispatchRequestId });
});

it('recovers a claim left unsettled by a heartbeat that is no longer running, by DB state only', async () => {
  const f = await agentArtifactFixture();
  const before = await f.step('qa');
  const stale = { status: 'claimed', claimedAt: new Date(0).toISOString(), heartbeatRunId: randomUUID(),
    executionGeneration: before.executionGeneration, retryCount: before.retryCount, iterationIndex: before.iterationIndex };
  await f.db.update(workflowStepRuns).set({ metadata: { ...before.metadata, toolQueue: stale } }).where(eq(workflowStepRuns.id, f.qaId));
  const recovered = await f.call('qa');
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  // A claim owned by the still-running caller heartbeat is never stolen.
  const live = { ...stale, heartbeatRunId: f.calls.qa.heartbeatId };
  const now = await f.step('qa');
  await f.db.update(workflowStepRuns).set({ metadata: { ...now.metadata, toolQueue: live } }).where(eq(workflowStepRuns.id, f.qaId));
  const blocked = await f.call('qa');
  expect(blocked.status).toBe(409);
  expect((await f.step('qa')).lastDispatchRequestId).toBe(now.lastDispatchRequestId);
});

it('does not let unbound test execution acquire agent authority', async () => {
  const f = await agentArtifactFixture();
  const result = await executeCoreWorkflowTool({ db: f.db, companyId: f.companyId, toolName: 'local-qa', requestId: randomUUID(), parameters: {} });
  expect(result).toMatchObject({ status: 422, body: { error: 'artifact_contract_workflow_required' } });
});

it('leaves non-contract core calls unbound and their response unchanged', async () => {
  const f = await agentArtifactFixture();
  const [tool] = await f.db.insert(toolDefinitions).values({ companyId: f.companyId, name: 'echo', adapterType: 'builtin',
    adapterConfig: { command: `${process.execPath} -e "console.log('ordinary')"` } }).returning();
  await f.db.insert(agentToolGrants).values({ companyId: f.companyId, agentId: f.agentId, toolId: tool.id, grantedBy: 'test' });
  await f.db.update(heartbeatRuns).set({ workflowStepRunId: null, issueId: null, contextSnapshot: {
    paperclipWorkflowStepToolContract: { toolNames: ['echo'], tools: [{ name: 'echo' }] } } }).where(eq(heartbeatRuns.id, f.calls.qa.heartbeatId));
  const direct = await executeCoreWorkflowTool({ db: f.db, companyId: f.companyId, agentId: f.agentId, toolName: 'echo', parameters: {}, requestId: randomUUID() });
  const response = await f.call('qa', {}, {}, 'echo');
  expect(response.status).toBe(direct.status);
  expect(response.body).toEqual(direct.body);
  expect((await f.step('qa')).lastDispatchRequestId).toBeNull();
});
