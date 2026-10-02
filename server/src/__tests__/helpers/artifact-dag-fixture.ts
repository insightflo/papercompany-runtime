import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns } from '@paperclipai/db';
import type { ArtifactContract } from '@paperclipai/shared';
import { fixture, database } from './qa-receipt-fixture.js';
import { freezeArtifactAttempt } from '../../services/workflow/artifact-contract-runtime.js';
import { executeCoreWorkflowTool } from '../../services/workflow/core-tool-executor.js';
import { completeWorkflowToolStepFromResult } from '../../services/workflow/dag-engine.js';
import { resolveWorkflowToolStepArgs } from '../../services/workflow/tool-step-args.js';

export async function artifactDagFixture(genericQa = false) {
  const f = await fixture(), db = database();
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  const dir = path.dirname(f.content), publishId = randomUUID(), verifyId = randomUUID();
  const contract: ArtifactContract = { role: 'publication', resultFileName: 'published.json',
    resultAdapter: 'generic', resultSchemaVersion: 'workflow.publication-result.v1', inputParams: {},
    consumerParams: { receipt: 'review', content: 'source' }, deploymentFiles: ['publisher.mjs'],
    inputEnvelopeVersion: 'workflow.artifact-input.v1', publication: {
      identity: { param: 'entry' }, bindings: [{ resultPointer: '/date', parameter: 'day' }],
      publishedAt: { resultPointer: '/publishedAt', dateParam: 'day', suffix: 'T00:00:00Z' },
      command: 'publish', commandKeySeparator: ':',
      audience: { parameter: 'access', privateValue: 'hidden', privateResult: 'private', defaultResult: 'public' } } };
  const steps = [...definition.stepsJson as Array<{ id: string; toolArtifactContract?: unknown }>,
    { id: 'publisher', name: 'Publisher', type: 'tool', toolNames: ['publisher'], dependencies: ['qa'],
      toolArtifactContract: { role: 'publication', schemaVersion: contract.resultSchemaVersion },
      toolArgs: { review: '{$steps.qa.workProductPath}', source: f.content, entry: 'article', day: '2026-10-01' } },
    { id: 'inspector', name: 'Inspector', type: 'tool', toolNames: ['inspector'], dependencies: ['publisher'],
      toolArtifactContract: { role: 'publication-verify', schemaVersion: contract.resultSchemaVersion },
      toolArgs: { publishedRecord: '{$steps.publisher.workProductPath}' } }];
  if (genericQa) {
    const artifactContract = { ...f.adapterConfig.artifactContract, resultSchemaVersion: 'workflow.qa-result.v1',
      resultAdapter: 'generic' as const, resultFileName: 'inspection.json' };
    const adapterConfig = { ...f.adapterConfig, artifactContract };
    steps[1].toolArtifactContract = { role: 'qa', schemaVersion: 'workflow.qa-result.v1', inputStepId: 'write' };
    await writeFile(path.join(adapterConfig.workingDirectory, artifactContract.deploymentFiles[0]), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync(4,JSON.stringify({schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true}],
inputDigest:{mode:'content',sha256:v.content.sha256},assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))}));`);
    await db.update(toolDefinitions).set({ adapterConfig }).where(eq(toolDefinitions.id, f.toolId));
    await db.update(workflowStepRuns).set({ metadata: { artifactExecution: freezeArtifactAttempt({ adapterConfig,
      step: steps[1], executionGeneration: 2, requestId: f.requestId }) } }).where(eq(workflowStepRuns.id, f.qaId));
  }
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, run.workflowId));
  const add = async (id: string, name: string, artifactContract: ArtifactContract, script: string) => {
    const command = path.join(dir, `${name}.mjs`);
    await writeFile(command, script);
    const adapterConfig = { command: `${process.execPath} ${command}`, workingDirectory: dir, artifactContract };
    await db.insert(toolDefinitions).values({ companyId: f.companyId, name, adapterType: 'builtin', adapterConfig });
    await db.insert(workflowStepRuns).values({ id, workflowRunId: f.runId, stepId: name, status: 'running', lastDispatchRequestId: name,
      metadata: { artifactExecution: freezeArtifactAttempt({ adapterConfig, step: {}, executionGeneration: 0, requestId: name }) } });
  };
  // Machine producer doubles only; runtime performs real request, receipt and durable result validation.
  await add(publishId, 'publisher', contract, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),url='https://example.org/article';
fs.writeFileSync(4,JSON.stringify({schemaVersion:'workflow.publication-result.v1',ok:true,command:'publish',mode:'content',section:'articles',
id:'article',date:'2026-10-01',title:null,publishedAt:'2026-10-01T00:00:00Z',publicUrl:url,
scope:JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE),
inputDigest:{mode:'content',sha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'article',slug:'article',publicUrl:url,liveStatus:200,blocks:1,assets:1,commandKey:'article:1',contentHash:'a'.repeat(64),contentBytes:123}}));`);
  await add(verifyId, 'inspector', { ...contract, role: 'publication-verify', resultFileName: 'verified.json',
    consumerParams: { receipt: 'publishedRecord' }, deploymentFiles: ['inspector.mjs'], publication: {
      ...contract.publication, identity: undefined, bindings: undefined, publishedAt: undefined, command: 'verify' } }, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),r=JSON.parse(Buffer.from(v.content.base64,'base64'));
r.command='verify';r.scope=JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE);fs.writeFileSync(4,JSON.stringify(r));`);
  const resolve = async (stepId: string) => resolveWorkflowToolStepArgs({ db, run: { id: f.runId, companyId: f.companyId },
    step: steps.find(s => s.id === stepId)!, workflowSteps: steps });
  const execute = async (stepId: string) => executeCoreWorkflowTool({ db, companyId: f.companyId, workflowRunId: f.runId,
    stepRunId: stepId === 'publisher' ? publishId : verifyId, stepId, requestId: stepId, toolName: stepId,
    parameters: await resolve(stepId) });
  const complete = async (stepId: string, result: Awaited<ReturnType<typeof executeCoreWorkflowTool>>) =>
    completeWorkflowToolStepFromResult(db, { companyId: f.companyId, workflowRunId: f.runId,
      stepRunId: stepId === 'qa' ? f.qaId : stepId === 'publisher' ? publishId : verifyId,
      stepId, requestId: stepId === 'qa' ? f.requestId : stepId, toolName: stepId,
      success: result.status === 200, data: result.body.data, artifactPath: result.artifactPath, toolArtifactReceipt: result.toolArtifactReceipt });
  return { ...f, db, steps, publishId, verifyId, resolve, execute, complete };
}
