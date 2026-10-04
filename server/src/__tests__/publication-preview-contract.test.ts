import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { workflowStepRuns } from '@paperclipai/db';
import { database, fixture } from './helpers/qa-receipt-fixture.js';
import { publicationPreviewProvider } from '../services/workflow/publication-preview-contract.js';
import { freezeArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';
import { registerWorkflowArtifact } from '../services/workflow/agent-api.js';
import { legacyHtmlManualPublicationContract } from './helpers/legacy-html-manual.js';
it('uses only the current company-scoped frozen provider at registration', async () => {
  const f = await fixture(), db = database();
  const producer = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId))).find(s => s.issueId)!;
  const issue = { id: producer.issueId!, companyId: f.companyId, missionId: f.missionId, projectId: null,
    originKind: 'workflow', title: 'Publish', startedAt: null, status: 'in_progress' };
  const contract = { ...legacyHtmlManualPublicationContract('publish.mjs'), previewProvider: 'declared_catalog' };
  await db.update(workflowStepRuns).set({ lastDispatchRequestId: 'preview-1', metadata: { artifactExecution: freezeArtifactAttempt({
    adapterConfig: { artifactContract: contract }, step: {}, executionGeneration: producer.executionGeneration, requestId: 'preview-1' }) } })
    .where(eq(workflowStepRuns.id, producer.id));
  expect(await publicationPreviewProvider(db, issue)).toBe('declared_catalog');
  const result = await registerWorkflowArtifact({ db, issue, actor: { actorType: 'user', actorId: 'board', agentId: null, runId: null },
    data: { type: 'preview_url', url: 'https://example.org/article', title: 'Article' } });
  expect(result.provider).toBe('declared_catalog');
  expect(await publicationPreviewProvider(db, { ...issue, companyId: '00000000-0000-4000-8000-000000000000' })).toBe('public_url');
  await db.update(workflowStepRuns).set({ executionGeneration: producer.executionGeneration + 1 }).where(eq(workflowStepRuns.id, producer.id));
  // 종결/복구 세대 상승은 완료 소스의 냉동 provider 를 무효화하지 않는다(2026-10-04 교정).
  expect(await publicationPreviewProvider(db, issue)).toBe('declared_catalog');
  // 재발사(발사 권위 교체)는 여전히 fail-closed.
  await db.update(workflowStepRuns).set({ lastDispatchRequestId: 'preview-2' }).where(eq(workflowStepRuns.id, producer.id));
  await expect(publicationPreviewProvider(db, issue)).rejects.toThrow('artifact_contract_snapshot_stale');
});
