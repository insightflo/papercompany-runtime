import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { activityLog, toolDefinitions } from '@paperclipai/db';
import { executeCoreWorkflowTool } from '../services/workflow/core-tool-executor.js';
import { toolCallProvenanceSchema } from '../services/workflow/tool-call-provenance.js';
import { progressDatabase, progressTool } from './helpers/tool-progress.js';

let fixture: Awaited<ReturnType<typeof progressDatabase>>, root: string;
const files = ['manual-onboarding-qa.mjs','manual-onboarding-workflow-tool.mjs','manual-onboarding-assets.mjs',
  'publication-date-contract.mjs','hub-flow-update.mjs','cms-publish.mjs','legacy-to-contentv1.mjs','canonical-json.mjs'];
beforeAll(async () => { fixture = await progressDatabase(); root=await mkdtemp(join(tmpdir(),'provenance-')); },60_000);
afterAll(async()=>{await fixture?.cleanup(); if(root)await rm(root,{recursive:true,force:true});});
it('records server-observed call identity for publish, verify, QA and hub; retains every failed attempt',async()=>{
  for(const name of files) await writeFile(join(root,name),'console.log(JSON.stringify({ok:true,provenance:"forged"}));');
  const scope=await progressTool(fixture.db,'builtin',{command:`node ${join(root,files[1])}`,env:{PATH:dirname(process.execPath)}});
  for(const [script,parameters,status] of [[files[1],['publish'],200],[files[1],['verify'],200],[files[0],[],200],[files[4],[],200],[files[1],['fail'],500]] as const){
    if(status===500)await writeFile(join(root,script),'console.error("expected failure");process.exit(7);');
    await fixture.db.update(toolDefinitions).set({adapterConfig:{command:`node ${join(root,script)}`,env:{PATH:dirname(process.execPath)}}}).where(eq(toolDefinitions.id,scope.toolId));
    const requestId=randomUUID();
    const result=await executeCoreWorkflowTool({db:fixture.db,...scope,requestId,parameters:[...parameters]});
    expect(result.status).toBe(status);
    const p=(result.body as any).invocationProvenance;
    expect(p?.schemaVersion).toBe('workflow.tool-call-provenance.v1');
    expect(p.requestId).toBe(requestId);
    expect(p.executable.path).toBe(process.execPath);
    expect(p.executable.sha256).toBe(createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
    expect(p.interpreter.sha256).toBe(p.executable.sha256);
    expect(toolCallProvenanceSchema.safeParse({...p,schemaVersion:'v2'}).success).toBe(false);
    expect(toolCallProvenanceSchema.safeParse({...p,forged:true}).success).toBe(false);
    expect(p.toolFiles).toHaveLength(8);
    const awaitScriptPath = await realpath(join(root,script));
    expect(p.toolFiles.find((f:any)=>f.path===awaitScriptPath).sha256).toBe(createHash('sha256').update(await readFile(join(root,script))).digest('hex'));
    expect(p.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.core.processId).toBe(process.pid);
    expect(p.core.processStartedAt).toEqual(expect.any(String));
    expect(p.core.files.some((f:any)=>f.path.endsWith('core-tool-executor.ts')&&f.sha256)).toBe(true);
    expect(p.core.loadedBytesAttested).toBe(false);
    expect(p.phase).toBe(status===200?'returned':'threw');
    const rows=await fixture.reader.select().from(activityLog).where(eq(activityLog.entityId,scope.toolId));
    const calls=rows.filter(r=>(r.details as any)?.requestId===requestId);
    expect(calls.map(r=>(r.details as any).phase)).toEqual(['prepared',status===200?'returned':'threw']);
    expect(calls.every(r=>r.companyId===scope.companyId)).toBe(true);
  }
},30_000);
it('direct executable script records the actual env-resolved interpreter separately',async()=>{
  const script=join(root,'manual-onboarding-workflow-tool.mjs');
  await writeFile(script,'#!/usr/bin/env node\nconsole.log("ok");'); await chmod(script,0o755);
  const scope=await progressTool(fixture.db,'builtin',{command:script,env:{PATH:dirname(process.execPath)}});
  const result=await executeCoreWorkflowTool({db:fixture.db,...scope,parameters:['verify']});
  expect(result.status).toBe(200);
  const p=(result.body as any).invocationProvenance;
  expect(p.executable.path).toBe(await realpath(script));
  expect(p.interpreter.path).toBe(process.execPath);
  expect(p.interpreter.sha256).toBe(createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
});
it('provenance never upgrades forged stdout or missing bundle files to authoritative evidence',async()=>{
  const script=join(root,'manual-onboarding-workflow-tool.mjs');
  await writeFile(script,'console.log("not a machine record");');
  await rm(join(root,'cms-publish.mjs'));
  const scope=await progressTool(fixture.db,'builtin',{command:`${process.execPath} ${script}`});
  const result=await executeCoreWorkflowTool({db:fixture.db,...scope,parameters:['verify']});
  expect(result.status).toBe(200); // observability is not a new completion gate
  const p=(result.body as any).invocationProvenance;
  expect(p?.bundleSha256).toBe(null);
  expect(p.toolFiles.find((f:any)=>f.path.endsWith('cms-publish.mjs')).error).toBe('ENOENT');
});
