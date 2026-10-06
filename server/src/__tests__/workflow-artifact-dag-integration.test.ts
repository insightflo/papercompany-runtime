import './helpers/workflow-control-node-boundary.js';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { workflowStepRuns } from '@paperclipai/db';
import { artifactDagFixture } from './helpers/artifact-dag-fixture.js';
import { completeWorkflowToolStepFromResult } from '../services/workflow/dag-engine.js';

it.each([false, true])('completes QA → publication → verification and resolves durable paths (generic QA=%s)', async genericQa => {
  const f = await artifactDagFixture(genericQa), qa = await f.invoke();
  expect(qa.status).toBe(200);
  await f.complete('qa', qa);
  const published = await f.execute('publisher');
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  await f.complete('publisher', published);
  expect(await f.resolve('inspector')).toEqual({ publishedRecord: published.artifactPath });
  const verified = await f.execute('inspector');
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const completed = await f.complete('inspector', verified);
  expect(completed?.status).toBe('completed');
  const rows = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId));
  expect(rows.every(s => s.status === 'completed')).toBe(true);
  expect(rows.find(s => s.id === f.publishId)?.metadata.toolResult).toMatchObject({ artifactPath: published.artifactPath, success: true });
  expect(rows.find(s => s.id === f.verifyId)?.metadata.toolResult).toMatchObject({ artifactPath: verified.artifactPath, success: true });
  expect(JSON.parse(await readFile(verified.artifactPath!, 'utf8')).scope).toMatchObject({ stepRunId: f.verifyId, requestId: 'inspector' });
});

it('resolves a completed publication by its frozen role instead of demanding a QA receipt', async () => {
  const f = await artifactDagFixture(), qa = await f.invoke();
  await f.complete('qa', qa);
  const published = await f.execute('publisher');
  expect(published.status).toBe(200);
  const [row] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  await f.db.update(workflowStepRuns).set({ status: 'completed', metadata: { ...row.metadata,
    toolResult: { success: true, requestId: 'publisher', artifactPath: published.artifactPath, data: published.body.data } } })
    .where(eq(workflowStepRuns.id, f.publishId));
  expect(await f.resolve('inspector')).toEqual({ publishedRecord: published.artifactPath });
});

it.each(['receipt-absent', 'marker-absent'])('QA completion fails closed with %s', async scenario => {
  const f = await artifactDagFixture();
  if (scenario === 'marker-absent') {
    // Frozen contract alone still requires the verified receipt, even without optional workflow marker.
    const { workflowDefinitions, workflowRuns } = await import('@paperclipai/db');
    const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    await f.db.update(workflowDefinitions).set({ stepsJson: f.steps.map(s => s.id === 'qa' ? { ...s, toolArtifactContract: undefined } : s) })
      .where(eq(workflowDefinitions.id, run.workflowId));
  }
  await expect(completeWorkflowToolStepFromResult(f.db, { companyId: f.companyId, stepRunId: f.qaId,
    requestId: f.requestId, success: true, artifactPath: '/tmp/untrusted.json' })).rejects.toThrow();
  const [row] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(row.status).toBe('running');
});

it.each([true, false])('historical v1 QA completion requires a valid receipt (provided=%s)', async provided => {
  const f = await artifactDagFixture(), qa = await f.invoke();
  if (qa.toolArtifactReceipt?.schemaVersion !== 'workflow.tool-artifact.v2') throw new Error('Expected v2 fixture receipt');
  const { contractHash: _, qaConfigHash: __, runtimeChecks: ___, pluginChecks: ____, ...receipt } = qa.toolArtifactReceipt;
  const [before] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  const { artifactExecution: _____, ...request } = before.metadata.toolArtifactRequest as Record<string, unknown>;
  await f.db.update(workflowStepRuns).set({ metadata: { toolArtifactRequest: request } }).where(eq(workflowStepRuns.id, f.qaId));
  const result = f.complete('qa', { ...qa, toolArtifactReceipt: provided
    ? { ...receipt, schemaVersion: 'workflow.tool-artifact.v1' } : undefined });
  if (provided) {
    await result;
    expect(await f.resolve('publisher')).toMatchObject({ review: `${receipt.outputRoot}/${receipt.relativePath}` });
  } else await expect(result).rejects.toThrow();
  const [after] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(after.status).toBe(provided ? 'completed' : 'running');
});

it.each(['bytes', 'scope'])('publication completion rejects %s tampering without storing success', async scenario => {
  const f = await artifactDagFixture(), qa = await f.invoke();
  await f.complete('qa', qa);
  const published = await f.execute('publisher');
  const raw = JSON.parse(await readFile(published.artifactPath!, 'utf8'));
  raw.scope.requestId = 'other-attempt';
  await chmod(published.artifactPath!, 0o600);
  await writeFile(published.artifactPath!, JSON.stringify(raw));
  if (scenario === 'scope') published.body.data = { ...raw, artifactPath: published.artifactPath };
  await expect(f.complete('publisher', published)).rejects.toThrow(scenario === 'bytes'
    ? 'qa_publication_receipt_bytes_changed' : 'qa_publish_result_scope_mismatch');
  const [row] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  expect(row.status).toBe('running'); expect(row.metadata.toolResult).toBeUndefined();
});

it.each(['running', 'request', 'retry', 'iteration', 'bytes'])('publication path rejects %s provenance changes', async scenario => {
  const f = await artifactDagFixture(), qa = await f.invoke();
  await f.complete('qa', qa);
  const published = await f.execute('publisher');
  await f.complete('publisher', published);
  if (scenario === 'bytes') {
    await chmod(published.artifactPath!, 0o600);
    await writeFile(published.artifactPath!, '{}');
  } else await f.db.update(workflowStepRuns).set(scenario === 'running' ? { status: 'running' }
    : scenario === 'request' ? { lastDispatchRequestId: 'replacement' } : scenario === 'retry' ? { retryCount: 1 }
      : { iterationIndex: 1 })
    .where(eq(workflowStepRuns.id, f.publishId));
  await expect(f.resolve('inspector')).rejects.toThrow();
});

// [2026-10-04 tech-scout 사고 교정] 종결/복구는 완료 발행 행의 세대를 발사 id·바이트 변경 없이
// 올린다 — 검증 소비는 이를 낡은 것으로 보지 않는다. 진짜 권위 교체는 request/retry/iteration 검사가 차단.
it('publication path survives recovery generation bumps on the completed publisher', async () => {
  const f = await artifactDagFixture(), qa = await f.invoke();
  await f.complete('qa', qa);
  const published = await f.execute('publisher');
  await f.complete('publisher', published);
  await f.db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.publishId));
  await expect(f.resolve('inspector')).resolves.toBeTruthy();
});
