import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { companies, toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { legacyHtmlManualPublicationContract } from "./helpers/legacy-html-manual.js";

// Real executor + isolated DB, with a deliberately hostile machine producer.
type IdSource = { body: string | null; params: (sourcePath: string, runDir: string) => Record<string, unknown> };
async function publisher(mutation: string, progress = false, idSource?: IdSource) {
  const f = await fixture(), db = database(), qa = await f.invoke();
  expect(qa.status).toBe(200);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await db.update(workflowStepRuns).set({ status: "completed", metadata: { ...step.metadata,
    toolArtifactReceipt: qa.toolArtifactReceipt } }).where(eq(workflowStepRuns.id, f.qaId));
  let targetParams: Record<string, unknown> = { id: "test", date: "2026-09-29" };
  if (idSource) {
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    const runDir = path.join(company.workProductRoot!, "missions", f.missionId, "runs", f.runId);
    const sourcePath = path.join(runDir, "steps", "register", "topic-decision.json");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    if (idSource.body !== null) await writeFile(sourcePath, idSource.body);
    targetParams = idSource.params(sourcePath, runDir);
  }
  const id = randomUUID(), script = path.join(path.dirname(f.content), `publisher-${id}.mjs`);
  const artifactContract = { ...legacyHtmlManualPublicationContract(path.basename(script)), resultFileName: "manual-onboarding-publish-result.json" };
  const adapterConfig = { workingDirectory: path.dirname(script), artifactContract };
  await db.insert(workflowStepRuns).values({ id, workflowRunId: f.runId, stepId: "publish", status: "running", lastDispatchRequestId: "publish-1",
    metadata: { artifactExecution: freezeArtifactAttempt({ adapterConfig, step: { id: "publish", type: "tool" }, executionGeneration: 0, requestId: "publish-1" }) } });
  await writeFile(script, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'manual-onboarding.publication.v1',ok:true,command:'publish',mode:'content-draft',
section:'tech-blog',id:'test',date:'2026-09-29',title:null,publishedAtKst:'2026-09-29T00:00:00+09:00',publicUrl:'http://127.0.0.1/public/tech-blog/test',scope:JSON.parse(process.env.PAPERCOMPANY_PUBLICATION_SCOPE||'{}'),
input:{contentSha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'test',slug:'test',publicUrl:'http://127.0.0.1/public/tech-blog/test',liveStatus:200,blocks:1,assets:1,commandKey:'test:1',contentHash:'a'.repeat(64),contentBytes:123}};
${mutation}
console.log(JSON.stringify({ok:true,artifactPath:'/outside/unverified.json',id:'stdout-lie'}));`);
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "publish", description: "test", adapterType: "builtin", adapterConfig: {
    ...adapterConfig, command: `${process.execPath} ${script}`, ...(progress ? { progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000, stages: [{ key: "publish", unit: "items" }] } } : {}),
  } });
  const result = await executeCoreWorkflowTool({ db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: id,
    stepId: "publish", requestId: "publish-1", toolName: "publish", parameters: { sourceContentPath: f.content,
      qaResultPath: path.join(qa.toolArtifactReceipt!.outputRoot, "qa-result.json"), section: "tech-blog", ...targetParams } });
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
  ["wrong timestamp", "r.publishedAtKst='2026-09-29T00:00:00Z';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong audience", "r.cms.audience='private';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong date", "r.date='2026-09-30';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong command sequence", "r.cms.commandKey='test:0';fs.writeFileSync(4,JSON.stringify(r));"],
  ["wrong CMS URL", "r.cms.publicUrl='https://example.org/other';fs.writeFileSync(4,JSON.stringify(r));"],
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

// idSourcePath/idSourceField: the runtime independently re-derives the expected id from the durable run-scoped file.
const emitId = (id: string) => `r.id='${id}';r.cms.contentId=r.id;r.cms.commandKey=r.id+':1';fs.writeFileSync(4,JSON.stringify(r));`;
const decision = (slug: unknown) => JSON.stringify({ status: "selected", selection: { topicSlug: slug } });
const viaSource = (body: string | null, extra: Record<string, unknown> = {}): IdSource => ({ body,
  params: (sourcePath) => ({ idSourcePath: sourcePath, idSourceField: "selection.topicSlug", date: "2026-09-29", ...extra }) });

it("accepts an explicit id arg before attempting an invalid source", async () => {
  const { result } = await publisher(emitId("test"), false, viaSource(null, { id: ' test ', idSourceField: 'invalid..field' }));
  expect(result.status, JSON.stringify(result.body)).toBe(200);
});

it.each([["dated slug", "dioxus", "20260929-dioxus"], ["pre-dated slug", "20260930-dioxus", "20260930-dioxus"]])(
  "accepts an id derived from idSourcePath (%s)", async (_n, slug, expected) => {
    const { result } = await publisher(emitId(expected), false, viaSource(decision(slug)));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ id: expected });
  });

it.each([
  ["derived mismatch", emitId("20260929-other"), viaSource(decision("dioxus")), "qa_publish_result_target_mismatch"],
  ["missing source file", emitId("20260929-dioxus"), viaSource(null), "qa_publish_result_id_source_invalid"],
  ["bad slug", emitId("20260929-Bad_Slug"), viaSource(decision("Bad_Slug")), "qa_publish_result_id_source_invalid"],
  ["missing field", emitId("20260929-dioxus"), viaSource(JSON.stringify({ selection: {} })), "qa_publish_result_id_source_invalid"],
  ["bad field path", emitId("20260929-dioxus"), viaSource(decision("dioxus"), { idSourceField: "selection..topicSlug" }), "qa_publish_result_id_source_invalid"],
  ["missing date", emitId("20260929-dioxus"), viaSource(decision("dioxus"), { date: undefined }), "qa_publish_result_id_source_invalid"],
  ["source outside run root", emitId("20260929-dioxus"), { body: decision("dioxus"),
    params: () => ({ idSourcePath: "/etc/hosts", idSourceField: "selection.topicSlug", date: "2026-09-29" }) }, "qa_publish_result_id_source_invalid"],
  ["traversal out of run root", emitId("20260929-dioxus"), { body: decision("dioxus"),
    params: (_s: string, runDir: string) => ({ idSourcePath: `${runDir}/../../../../etc/x.json`, idSourceField: "selection.topicSlug", date: "2026-09-29" }) }, "qa_publish_result_id_source_invalid"],
  ["neither id nor idSourcePath", emitId("20260929-dioxus"), { body: null, params: () => ({ date: "2026-09-29" }) }, "qa_publish_result_target_mismatch"],
] as const)("rejects %s", async (_n, mutation, source, error) => {
  const { result } = await publisher(mutation, false, source as IdSource);
  expect(result.status, JSON.stringify(result.body)).toBe(500);
  expect(String((result.body as { error?: string }).error)).toContain(error);
  expect(result.artifactPath).toBeUndefined();
});
