import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { toolDefinitions, workflowStepRuns } from '@paperclipai/db';
import type { ArtifactContract } from '@paperclipai/shared';
import { fixture, database } from './helpers/qa-receipt-fixture.js';
import { freezeArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';
import { executeCoreWorkflowTool } from '../services/workflow/core-tool-executor.js';

// Explicit machine producer doubles; these do not claim the unavailable external verifier's format.
async function setup(receiptParam = 'publishResultPath', mutation = '') {
  const f = await fixture(), db = database(), qa = await f.invoke();
  expect(qa.status).toBe(200);
  const [qaStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await db.update(workflowStepRuns).set({ status: 'completed', metadata: { ...qaStep.metadata,
    toolArtifactReceipt: qa.toolArtifactReceipt } }).where(eq(workflowStepRuns.id, f.qaId));
  const dir = path.dirname(f.content), publishId = randomUUID(), verifyId = randomUUID();
  const contract: ArtifactContract = { role: 'publication', resultFileName: 'published.json',
    resultAdapter: 'generic', resultSchemaVersion: 'workflow.publication-result.v1', inputParams: {},
    consumerParams: { receipt: 'review', content: 'source' }, deploymentFiles: ['publisher.mjs'],
    inputEnvelopeVersion: 'workflow.artifact-input.v1', publication: {
      identity: { param: 'entry' }, bindings: [{ resultPointer: '/date', parameter: 'day' }],
      publishedAt: { resultPointer: '/publishedAt', dateParam: 'day', suffix: 'T00:00:00Z' },
      command: 'publish', commandKeySeparator: ':',
      audience: { parameter: 'access', privateValue: 'hidden', privateResult: 'private', defaultResult: 'public' } } };
  const add = async (id: string, name: string, artifactContract: ArtifactContract, script: string) => {
    const command = path.join(dir, `${name}.mjs`);
    await writeFile(command, script);
    const adapterConfig = { command: `${process.execPath} ${command}`, workingDirectory: dir, artifactContract };
    await db.insert(toolDefinitions).values({ companyId: f.companyId, name, description: 'test', adapterType: 'builtin', adapterConfig });
    const metadata = { artifactExecution: freezeArtifactAttempt({ adapterConfig, step: {}, executionGeneration: 0, requestId: name }) };
    await db.insert(workflowStepRuns).values({ id, workflowRunId: f.runId, stepId: name, status: 'running', lastDispatchRequestId: name, metadata });
    return metadata;
  };
  const publishMetadata = await add(publishId, 'publisher', contract, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),url='https://example.org/article';
const r={schemaVersion:'workflow.publication-result.v1',ok:true,command:'publish',mode:'content',section:'articles',
id:'article',date:'2026-10-01',title:null,publishedAt:'2026-10-01T00:00:00Z',publicUrl:url,
scope:JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE),
inputDigest:{mode:'content',sha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'article',slug:'article',publicUrl:url,liveStatus:200,blocks:1,assets:1,commandKey:'article:1',contentHash:'a'.repeat(64),contentBytes:123}};
fs.writeFileSync(4,JSON.stringify(r));`);
  const published = await executeCoreWorkflowTool({ db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: publishId,
    stepId: 'publisher', requestId: 'publisher', toolName: 'publisher', parameters: {
      review: path.join(qa.toolArtifactReceipt!.outputRoot, qa.toolArtifactReceipt!.relativePath), source: f.content, entry: 'article', day: '2026-10-01' } });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const completedMetadata = { ...publishMetadata, toolResult: { success: true, requestId: 'publisher',
    artifactPath: published.artifactPath, data: published.body.data } };
  await db.update(workflowStepRuns).set({ status: 'completed', metadata: completedMetadata }).where(eq(workflowStepRuns.id, publishId));
  const verifyContract: ArtifactContract = { ...contract, role: 'publication-verify', resultFileName: 'verified.json',
    consumerParams: { receipt: receiptParam }, deploymentFiles: ['inspector.mjs'], publication: {
      ...contract.publication, identity: undefined, bindings: undefined, publishedAt: undefined, command: 'verify' } };
  await add(verifyId, 'inspector', verifyContract, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),r=JSON.parse(Buffer.from(v.content.base64,'base64'));
const args=process.argv.slice(2);if(!args.includes('${receiptParam === 'publishResultPath' ? '--publish-result-path' : '--durable-receipt'}'))process.exit(8);
r.command='verify';r.scope=JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE);
${mutation}
fs.writeFileSync(4,JSON.stringify(r));console.log(JSON.stringify({ok:true,artifactPath:'/untrusted/stdout.json'}));`);
  const invoke = (parameters: Record<string, unknown> = { [receiptParam]: published.artifactPath }) => executeCoreWorkflowTool({ db,
    companyId: f.companyId, workflowRunId: f.runId, stepRunId: verifyId, stepId: 'inspector', requestId: 'inspector',
    toolName: 'inspector', parameters });
  return { ...f, published, publishId, verifyId, completedMetadata, invoke };
}

it.each(['publishResultPath', 'durableReceipt'])('consumes a durable publication via declared %s without requiring QA source params', async name => {
  const f = await setup(name), result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.artifactPath).toMatch(/\/verified.json$/);
  expect(JSON.parse(await readFile(result.artifactPath!, 'utf8'))).toMatchObject({ command: 'verify', id: 'article',
    scope: { companyId: f.companyId, stepRunId: f.verifyId, requestId: 'inspector' } });
}, 45000);
it.each([
  ['identity', "r.id='other';r.cms.contentId='other';r.cms.commandKey='other:1';"],
  ['date', "r.date='2026-10-02';"], ['digest', "r.inputDigest.sha256='b'.repeat(64);"],
  ['scope', "r.scope.requestId='old';"], ['url', "r.publicUrl=r.cms.publicUrl='https://example.org/other';"],
])('rejects verifier %s tampering instead of trusting successful stdout', async (_name, mutation) => {
  const f = await setup('publishResultPath', mutation), result = await f.invoke();
  expect(result.status).toBe(500); expect(result.artifactPath).toBeUndefined();
  expect(result.body.error).toMatch(/qa_publish_result_(target|input|scope)_mismatch/);
});
it.each(['bytes', 'request', 'incomplete', 'retry', 'iteration'])('rejects %s changes in durable publication authority before launching', async scenario => {
  const f = await setup(), db = database();
  if (scenario === 'bytes') {
    const raw = JSON.parse(await readFile(f.published.artifactPath!, 'utf8')); raw.id = 'changed';
    await chmod(f.published.artifactPath!, 0o600);
    await writeFile(f.published.artifactPath!, JSON.stringify(raw));
  } else await db.update(workflowStepRuns).set(
    scenario === 'request' ? { lastDispatchRequestId: 'new' } : scenario === 'retry' ? { retryCount: 1 }
      : scenario === 'iteration' ? { iterationIndex: 1 } : { status: 'running' }).where(eq(workflowStepRuns.id, f.publishId));
  const result = await f.invoke();
  expect(result.status).not.toBe(200); expect(result.artifactPath).toBeUndefined();
  expect(result.body.invocationProvenance).toBeNull();
});

// [2026-10-04 tech-scout 사고 교정] 종결/복구 세대 상승(발사 id·바이트 불변)은 완료 발행 권위를
// 무효화하지 않는다 — 검증기는 이를 소비한다.
it('consumes the durable publication across recovery generation bumps', async () => {
  const f = await setup(), db = database();
  await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.publishId));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.artifactPath).toMatch(/\/verified.json$/);
});
it('rejects an undeclared path parameter instead of routing by its familiar name', async () => {
  const f = await setup('durableReceipt'), result = await f.invoke({ publishResultPath: f.published.artifactPath });
  expect(result.status).toBe(500);
  expect(result.body.error).toBe('qa_artifact_consumer_receipt_required');
  expect(result.body.invocationProvenance).toBeNull();
});
it('rejects another run/company publication path even when the file is valid', async () => {
  const f = await setup(), other = await setup();
  const result = await f.invoke({ publishResultPath: other.published.artifactPath });
  expect(result.status).toBe(500);
  expect(result.body.error).toBe('qa_artifact_consumer_receipt_required');
  expect(result.body.invocationProvenance).toBeNull();
}, 45000);
