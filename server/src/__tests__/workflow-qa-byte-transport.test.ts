import { expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { toolDefinitions } from "@paperclipai/db";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";

it("progress-enabled QA uses stdin bytes and FD4 while FD3 remains progress-only", async () => {
  const f = await fixture();
  const [tool] = await database().select().from(toolDefinitions).where(eq(toolDefinitions.companyId, f.companyId));
  await database().update(toolDefinitions).set({ adapterConfig: { ...tool.adapterConfig,
    progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000, stages: [{ key: "qa", unit: "items" }] } } })
    .where(eq(toolDefinitions.id, tool.id));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.body.content).toBe('not JSON; stdout is diagnostic only');
});

it("stdout cannot replace the required machine result channel", async () => {
  const f = await fixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  await writeFile(script, `import fs from 'node:fs';fs.readFileSync(0);console.log(JSON.stringify({ok:true,schemaVersion:'manual-onboarding.qa.v1'}));`);

  const result = await f.invoke();
  expect(result.status).toBe(500); expect(result.body.error).toContain('qa_result_transport_missing');
  expect(result.toolArtifactReceipt).toBeUndefined();
});

it("runner receives verified-byte FD result but refuses persistence through a swapped root", async () => {
  const f = await fixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  await writeFile(script, `import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
if(process.env.PAPERCOMPANY_QA_INPUT!=='stdin-v1') throw Error('transport_required');
const v=JSON.parse(fs.readFileSync(0,'utf8')), h=b=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from(v.content.base64,'base64');if(h(source)!==v.content.sha256)throw Error('wrong_bytes');
const root=path.dirname(a.out), outside=root+'-outside';fs.mkdirSync(outside);fs.renameSync(root,root+'-old');fs.symlinkSync(outside,root);
const q={schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:'tech-blog',ok:true,checkedAt:new Date().toISOString(),checks:[{id:'fixture',ok:true,detail:null}],artifactPath:a.out,contentSha256:h(source),assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(q));console.log('diagnostic only');`);

  const r=await f.invoke();
  // Root changed after spawn: fail closed, and never write through the replacement.
  expect(r.status).toBe(500);
  expect(r.body.error).not.toContain('transport_required');
  expect(r.body.error).toContain('artifact_root_replaced');
  const { workflowStepRuns } = await import('@paperclipai/db');
  const [step]=await database().select().from(workflowStepRuns).where(eq(workflowStepRuns.id,f.qaId));
  const output=(step.metadata.toolArtifactRequest as {outputRoot:string}).outputRoot;
  await expect(readFile(path.join(output+'-outside','qa-result.json'))).rejects.toThrow();
});
