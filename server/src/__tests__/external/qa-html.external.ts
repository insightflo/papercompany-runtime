import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns } from '@paperclipai/db';
import { fixture, database } from '../helpers/qa-receipt-fixture.js';
import { executeCoreWorkflowTool } from '../../services/workflow/core-tool-executor.js';
import { completeWorkflowToolStepFromResult } from '../../services/workflow/dag-engine.js';
import { prepareQaConsumer } from '../../services/workflow/qa-artifact-consumer.js';
import { digest } from '../../services/workflow/artifact-files.js';

it('real HTML QA -> current DB receipt -> verified buffer consumer with explicit source-bound ancillary', async () => {
 const script=process.env.OVERSIGHT_QA_PRODUCER;
 if(!script) throw Error('OVERSIGHT_QA_PRODUCER required (real producer)');
 const f=await fixture(script), db=database();
 const html=Buffer.from('<!doctype html><html><main><h2>Verified</h2><img src="assets/nested/hero.png"></main></html>');
 const asset=Buffer.alloc(22000,1), meta=Buffer.from('{"ok":false}');
 await writeFile(f.content,html);await mkdir(path.join(f.assetsDir,'nested'));await writeFile(path.join(f.assetsDir,'nested/hero.png'),asset);
 await writeFile(path.join(path.dirname(f.content),'repo-meta.json'),meta);
 const manifest=path.join(path.dirname(f.content),'html-input.json');
 await writeFile(manifest,JSON.stringify({schemaVersion:'manual-onboarding.html-input.v1',htmlSha256:digest(html),
 assets:[{fileName:'nested/hero.png',sha256:digest(asset),byteSize:asset.length}],
 ancillary:[{role:'repoMeta',fileName:'repo-meta.json',sha256:digest(meta),byteSize:meta.length}]}));
 const result=await executeCoreWorkflowTool({db,companyId:f.companyId,toolName:'local-qa',workflowRunId:f.runId,stepRunId:f.qaId,stepId:'qa',requestId:f.requestId,
 parameters:{html:f.content,htmlManifest:manifest,section:'tech-blog'}});
 expect(result.status,JSON.stringify(result.body)).toBe(200);
 const receipt=result.toolArtifactReceipt!;
 expect(receipt.input.mode).toBe('html');expect(receipt.input.ancillaryManifest).toEqual([{fileName:'repoMeta',sha256:digest(meta),byteSize:meta.length}]);
 await completeWorkflowToolStepFromResult(db,{companyId:f.companyId,workflowRunId:f.runId,stepRunId:f.qaId,stepId:'qa',requestId:f.requestId,toolName:'local-qa',success:true,toolArtifactReceipt:receipt,data:result.body.data});
 await db.update(workflowRuns).set({status:'running'}).where(eq(workflowRuns.id,f.runId));
 const publish=randomUUID();await db.insert(workflowStepRuns).values({id:publish,workflowRunId:f.runId,stepId:'publish',status:'running',lastDispatchRequestId:'publish-html'});
 // Change originals after QA. Consumer must deliver stored verified bytes, not reopen these paths.
 await writeFile(f.content,'changed');await writeFile(path.join(f.assetsDir,'nested/hero.png'),'changed');await writeFile(path.join(path.dirname(f.content),'repo-meta.json'),'changed');
 const args={db,companyId:f.companyId,workflowRunId:f.runId,stepRunId:publish,stepId:'publish',requestId:'publish-html',parameters:{sourceHtmlPath:f.content,qaResultPath:path.join(receipt.outputRoot,'qa-result.json')}};
 const delivered=await prepareQaConsumer(args), transport=JSON.parse(delivered.inputBytes!.toString());
 expect(transport.mode).toBe('html');expect(Buffer.from(transport.content.base64,'base64')).toEqual(html);
 expect(Buffer.from(transport.assets[0].base64,'base64')).toEqual(asset);expect(Buffer.from(transport.ancillary[0].base64,'base64')).toEqual(meta);
 await expect(prepareQaConsumer({...args,parameters:{sourceContentPath:f.content,qaResultPath:args.parameters.qaResultPath}})).rejects.toThrow('qa_artifact_consumer_input_mismatch');
 const snapshotMeta=path.join(receipt.outputRoot,'input/ancillary/repoMeta');await chmod(snapshotMeta,0o600);await writeFile(snapshotMeta,'{}');
 await expect(prepareQaConsumer(args)).rejects.toThrow('qa_artifact_ancillary_changed');
});
