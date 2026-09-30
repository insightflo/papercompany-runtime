import { randomUUID } from "node:crypto";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";

// Real executor + isolated DB, with a deliberately hostile machine producer.
async function publisher(mutation: string, progress = false) {
  const f = await fixture(), db = database(), qa = await f.invoke();
  expect(qa.status).toBe(200);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await db.update(workflowStepRuns).set({ status: "completed", metadata: { ...step.metadata,
    toolArtifactReceipt: qa.toolArtifactReceipt } }).where(eq(workflowStepRuns.id, f.qaId));
  const id = randomUUID(), script = path.join(path.dirname(f.content), `publisher-${id}.mjs`);
  await db.insert(workflowStepRuns).values({ id, workflowRunId: f.runId, stepId: "publish", status: "running", lastDispatchRequestId: "publish-1" });
  await writeFile(script, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'manual-onboarding.publication.v1',ok:true,command:'publish',mode:'content-draft',
section:'tech-blog',id:'test',date:'2026-09-29',title:null,publishedAtKst:'2026-09-29T00:00:00+09:00',publicUrl:'http://127.0.0.1/public/tech-blog/test',scope:JSON.parse(process.env.PAPERCOMPANY_PUBLICATION_SCOPE||'{}'),
input:{contentSha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'test',slug:'test',publicUrl:'http://127.0.0.1/public/tech-blog/test',liveStatus:200,blocks:1,assets:1,commandKey:'test:1',contentHash:'a'.repeat(64),contentBytes:123}};
${mutation}
console.log(JSON.stringify({ok:true,artifactPath:'/outside/unverified.json',id:'stdout-lie'}));`);
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "publish", description: "test", adapterType: "builtin", adapterConfig: {
    command: `${process.execPath} ${script}`, ...(progress ? { progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000, stages: [{ key: "publish", unit: "items" }] } } : {}),
  } });
  const result = await executeCoreWorkflowTool({ db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: id,
    stepId: "publish", requestId: "publish-1", toolName: "publish", parameters: { sourceContentPath: f.content,
      qaResultPath: path.join(qa.toolArtifactReceipt!.outputRoot, "qa-result.json"), section: "tech-blog", id: "test", date: "2026-09-29" } });
  return { result, root: qa.toolArtifactReceipt!.outputRoot, companyId: f.companyId };
}

it.each([
  ["missing", ""], ["garbage", "fs.writeFileSync(4,'NOT JSON');"],
  ["unversioned", "delete r.schemaVersion;fs.writeFileSync(4,JSON.stringify(r));"],
  ["failure", "r.ok=false;fs.writeFileSync(4,JSON.stringify(r));"],
  ["foreign scope", "r.scope.companyId='00000000-0000-4000-8000-000000000000';fs.writeFileSync(4,JSON.stringify(r));"],
  ["old request", "r.scope.requestId='old';fs.writeFileSync(4,JSON.stringify(r));"],
  ["old attempt", "r.scope.executionGeneration=999;fs.writeFileSync(4,JSON.stringify(r));"],
  ["invalid final hash", "r.cms.contentHash='not-a-hash';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong input hash", "r.input.contentSha256='b'.repeat(64);fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong QA hash", "r.input.qaSha256='b'.repeat(64);fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong assets", "r.input.assetManifest=[];fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong target", "r.id='other';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong CMS result", "r.cms.contentId='other';fs.writeFileSync(4,JSON.stringify(r));"],
  ["claimed path", "r.artifactPath='/outside/unverified.json';fs.writeFileSync(4,JSON.stringify(r));"],
])("rejects %s FD4 despite successful stdout", async (_name, mutation) => {
  const { result, root } = await publisher(mutation);
  expect(result.status, JSON.stringify(result.body)).toBe(500);
  expect(result.artifactPath).toBeUndefined();
  for (const dir of (await readdir(root)).filter(n => n.startsWith("publication-"))) {
    expect(await readdir(path.join(root, dir))).not.toContain("manual-onboarding-publish-result.json");
  }
});

it("keeps legacy non-contract stdout behavior", async () => {
  const f = await fixture(), db = database(), script = path.join(path.dirname(f.content), "legacy.mjs");
  await writeFile(script, `console.log(JSON.stringify({ok:true,id:'legacy'}));`);
  await db.insert(toolDefinitions).values({ companyId:f.companyId, name:"legacy", description:"legacy", adapterType:"builtin",
    adapterConfig:{ command:`${process.execPath} ${script}` } });
  const result=await executeCoreWorkflowTool({db,companyId:f.companyId,toolName:"legacy",requestId:"legacy",parameters:{}});
  expect(result.status).toBe(200); expect(result.body.data).toEqual({ok:true,id:"legacy"});
});

it.each([false, true])("returns only verified FD4 with server-owned durable path (progress=%s)", async progress => {
  const { result, companyId } = await publisher("fs.writeFileSync(4,JSON.stringify(r));", progress);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.data).toMatchObject({ schemaVersion: "manual-onboarding.publication.v1", id: "test", scope: { companyId } });
  expect(result.artifactPath).toMatch(/\/publication-[^/]+\/manual-onboarding-publish-result.json$/);
  const durable = JSON.parse(await readFile(result.artifactPath!, "utf8"));
  expect(durable.id).toBe("test"); expect(durable.artifactPath).toBeUndefined();
  expect(result.body.data).toEqual({ ...durable, artifactPath: result.artifactPath });
});
