import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { workflowStepRuns, toolDefinitions } from '@paperclipai/db';
import path from 'node:path';
import { freezeArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';
import { executeCoreWorkflowTool } from '../services/workflow/core-tool-executor.js';
import { fixture, database } from './helpers/qa-receipt-fixture.js';

it('issues v2 receipts from frozen config despite live contract mutation', async () => {
  const f = await fixture(), db = database();
  await db.update(toolDefinitions).set({ adapterConfig: { ...f.adapterConfig,
    artifactContract: { ...f.adapterConfig.artifactContract, resultFileName: 'changed.json',
      defaultRules: { rules: { 'required-fields': { params: { pointers: ['/missing'] } } } } } } }).where(eq(toolDefinitions.id, f.toolId));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt).toMatchObject({ schemaVersion: 'workflow.tool-artifact.v2', relativePath: 'qa-result.json' });
  expect(result.toolArtifactReceipt?.runtimeChecks?.length).toBeGreaterThanOrEqual(6);
  expect(result.toolArtifactReceipt?.pluginChecks).toHaveLength(1);
});
it('routes arbitrary parameter names, result filename, envelope and pointer assets from the frozen contract', async () => {
  const f = await fixture(), db = database();
  const artifactContract = { ...f.adapterConfig.artifactContract, resultFileName: 'verdict.data.json',
    inputParams: { content: 'payload', assetsDir: 'attachments', out: 'destination' },
    assetDiscovery: ['/resources/*/file'], inputEnvelopeVersion: 'example.byte-input.v9' };
  await writeFile(f.content, JSON.stringify({ resources: [{ file: 'hero.png' }] }));
  const script = path.join(f.adapterConfig.workingDirectory, artifactContract.deploymentFiles[0]);
  await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
if(input.schemaVersion!=='example.byte-input.v9'||!a.payload||!a.attachments||!a.destination.endsWith('verdict.data.json')||process.env.PAPERCOMPANY_ARTIFACT_RESULT_FD!=='4')process.exit(8);
writeFileSync(4,JSON.stringify({schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:null,
ok:true,checks:[{id:'fixture',ok:true}],checkedAt:new Date().toISOString(),artifactPath:a.destination,contentSha256:input.content.sha256,
assetManifest:input.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))}));`);
  const adapterConfig = { ...f.adapterConfig, artifactContract };
  await db.update(toolDefinitions).set({ adapterConfig }).where(eq(toolDefinitions.id, f.toolId));
  await db.update(workflowStepRuns).set({ metadata: { artifactExecution: freezeArtifactAttempt({ adapterConfig,
    step: {}, executionGeneration: 2, requestId: f.requestId }) } }).where(eq(workflowStepRuns.id, f.qaId));
  const result = await executeCoreWorkflowTool({ db, companyId: f.companyId, toolName: 'local-qa', workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: 'qa', requestId: f.requestId, parameters: { payload: f.content, attachments: f.assetsDir } });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.relativePath).toBe('verdict.data.json');
  expect(result.toolArtifactReceipt?.input.assetManifest).toHaveLength(1);
});
it('fails closed rather than executing an artifact step without its frozen contract', async () => {
  const f = await fixture(), db = database();
  await db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, f.qaId));
  const result = await f.invoke();
  expect(result.status).toBe(422);
  expect(result.body.error).toBe('artifact_contract_snapshot_required');
});
it('rejects independent mandatory engine checks even when the plugin reports pass', async () => {
  const f = await fixture();
  await writeFile(f.content, JSON.stringify({ html: '<script src="https://example.org/evil.js"></script>',
    blocks: [{ type: 'image', assetFile: 'hero.png' }] }));
  const result = await f.invoke();
  expect(result.status).not.toBe(200);
  expect(result.body.error).toContain('qa_artifact_runtime_checks_failed');
});
