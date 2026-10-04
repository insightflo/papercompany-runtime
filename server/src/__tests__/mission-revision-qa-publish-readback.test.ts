// server/src/__tests__/mission-revision-qa-publish-readback.test.ts
//
// [수정 변경맵 — Q2/Q6 수정 실행의 새 검수→게시→확인 경로] 발행 조건만 바뀐 수정 실행에서 본문
// 생성 결과는 검증된 seed 로 재사용하고, 검수는 이번 실행 계약에 묶여 새로 실행된다. 재사용된
// 콘텐츠(원본 실행 생산자 계보 + sha 검증)로 구성된 본문에 대해 현재 실행/시도의 requestId·실행세대에
// 결합된 toolArtifactReceipt 가 발급되고, 통과 시 모형 게시 도구가 그 영수증을 소비해 게시하며,
// 게시 결과 경로·스코프는 원본 실행이 아닌 현재 실행·게시 스텝런·시도에 묶여 회수된다. 실제 공개
// 경로(createAdmittedWorkflowRun → executeWorkflowRun → processQueuedWorkflowToolStepRuns →
// executeCoreWorkflowTool/completeWorkflowToolStepFromResult)와 실제 격리 DB+파일 fixture 만
// 사용한다(소스 문자열 검사 아님). 게시·확인 도구는 회사별 모형 스크립트다.
//
// GREEN) 본문 재사용 + 새 검수 + 게시 + 확인이 한 실행 계획에서 연결되고, 검수 영수증·게시 결과
//   경로·스코프·확인 회수가 모두 현재 실행/시도에 결합된다. 원본 콘텐츠와 원본 검수 결과 bytes 는
//   불변이며 게시는 새 검수 결과를 소비한다.
// RED) 원본 실행의 이전 검수 PASS 를 새 실행 통과로 복사하는 경로가 없다: 완료 기록은 영수증 스코프
//   불일치로 거절되고(부분 통과 기록 없음), 게시자는 원본 영수증 경로를 받지 않으며(게시물 0), 현재
//   실행 검수 단계에서 회수 가능한 영수증이 없다(게시 단계는 대기).
// [범위 고지] UI·리팩터·승인/회사/검증 게이트 변경은 이 슬라이스 범위 밖이다(게이트 약화 없음).
import "./helpers/workflow-control-node-boundary.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { board } from "./helpers/workflow-seed-world.js";
import { workProductService } from "../services/work-products.js";
import { createAdmittedWorkflowRun } from "services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { executeCoreWorkflowTool, resolveWorkflowRunStepEnv } from "../services/workflow/core-tool-executor.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { resolveQaReceiptPath } from "../services/workflow/qa-artifact-consumer.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("rev-qa-publish-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rev-qa-publish-")));
  // 모형 검수 도구: stdin 봉투의 콘텐츠 다이제스트를 검사하고 fd4 기계 채널로만 결과를 쓴다.
  // 결과에 현재 시도 requestId 를 실어 실행마다 bytes 가 달라지게 한다(진단 stdout 아님).
  await writeFile(path.join(root, "qa.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`);
  // 모형 게시 도구: 검수 봉투(content+qa bytes)를 소비하고 게시 스코프를 결과에 되돬린다.
  await writeFile(path.join(root, "publish.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8')),url='https://example.org/article';
const r={schemaVersion:'workflow.publication-result.v1',ok:true,command:'publish',mode:'content',section:'articles',
id:'article',date:'2026-10-01',title:null,publishedAt:'2026-10-01T00:00:00Z',publicUrl:url,
scope:JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE),
inputDigest:{mode:'content',sha256:v.content.sha256,qaSha256:v.qa.sha256,
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'article',slug:'article',publicUrl:url,liveStatus:200,blocks:1,assets:0,
commandKey:'article:1',contentHash:'a'.repeat(64),contentBytes:123}};
fs.writeFileSync(4,JSON.stringify(r));`);
  // 모형 확인 도구: 게시 결과 bytes 를 읽어 command/scope 만 확인용으로 교체해 돌려준다.
  await writeFile(path.join(root, "readback.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r=JSON.parse(Buffer.from(v.content.base64,'base64').toString('utf8'));
r.command='verify';r.scope=JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE);
fs.writeFileSync(4,JSON.stringify(r));`);
  // app.ts 운영 executor 와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록.
  setWorkflowToolStepExecutor(async (request) => {
    const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId,
      agentName: request.agentName, toolName: request.toolName, parameters: request.args ?? {},
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepRunId: request.stepRunId,
      stepId: request.stepId, stepEnv: await resolveWorkflowRunStepEnv(db, { companyId: request.companyId,
        workflowRunId: request.workflowRunId, stepId: request.stepId }) });
    const success = coreResult.status === 200;
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId,
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepId: request.stepId,
      toolName: request.toolName, success, stdout: coreResult.body.content, data: coreResult.body.data,
      artifactPath: coreResult.artifactPath, toolArtifactReceipt: coreResult.toolArtifactReceipt,
      stderr: coreResult.body.stderr ?? "", exitCode: success ? 0 : 1, error: success ? undefined : coreResult.body.error });
    return { accepted: true };
  });
}, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const meta = (row: typeof workflowStepRuns.$inferSelect) => (row.metadata ?? {}) as Record<string, unknown>;
type Receipt = { outputRoot: string; relativePath: string } & Record<string, unknown>;
const qaContract: ArtifactContract = { role: "qa", resultFileName: "inspection.json", resultAdapter: "generic",
  resultSchemaVersion: "workflow.qa-result.v1", inputParams: { content: "document" }, deploymentFiles: ["qa.mjs"],
  inputEnvelopeVersion: "workflow.artifact-input.v1" };
const publishContract: ArtifactContract = { role: "publication", resultFileName: "published.json", resultAdapter: "generic",
  resultSchemaVersion: "workflow.publication-result.v1", inputParams: {},
  consumerParams: { receipt: "review", content: "source" }, deploymentFiles: ["publish.mjs"],
  inputEnvelopeVersion: "workflow.artifact-input.v1",
  publication: { identity: { param: "entry" }, bindings: [{ resultPointer: "/date", parameter: "day" }],
    publishedAt: { resultPointer: "/publishedAt", dateParam: "day", suffix: "T00:00:00Z" },
    command: "publish", commandKeySeparator: ":",
    audience: { parameter: "access", privateValue: "hidden", privateResult: "private", defaultResult: "public" } } };
const readbackContract: ArtifactContract = { ...publishContract, role: "publication-verify", resultFileName: "verified.json",
  consumerParams: { receipt: "publishResultPath" }, deploymentFiles: ["readback.mjs"],
  publication: { ...publishContract.publication, identity: undefined, bindings: undefined, publishedAt: undefined, command: "verify" } };
type Step = { id: string; sourceStepId?: string; name: string; type: string; agentId: string; dependencies: string[];
  toolNames?: string[]; toolArgs?: Record<string, string>; graphWorkProductRequired?: boolean;
  workProductSelectors?: Record<string, { type: string; title: string }>;
  toolArtifactContract?: { schemaVersion: string; role: string; inputStepId: string } };

// 원본 실행: 본문(write)+검수 PASS(qa)까진 끝났고 게시 전에 종료됐다. 수정 실행 계획은 본문만
// seed 로 재사용하고, 검수·게시·확인은 이번 실행의 새 단계로 새 실행 계약에 묶여 돈다.
async function world() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "RevPub", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "operator", adapterType: "process" });
  for (const [name, contract, script] of [["revision-qa", qaContract, "qa.mjs"], ["revision-publish", publishContract, "publish.mjs"],
    ["revision-readback", readbackContract, "readback.mjs"]] as const)
    await db.insert(toolDefinitions).values({ companyId, name, description: "Mock artifact tool", adapterType: "builtin",
      adapterConfig: { command: `${process.execPath} ${path.join(root, script)}`, workingDirectory: root, artifactContract: contract } });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "active" }).returning();
  const write: Step = { id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true };
  const sourceQa: Step = { id: "qa", name: "QA", type: "tool", agentId: "", dependencies: ["write"], toolNames: ["revision-qa"],
    workProductSelectors: { write: { type: "document", title: "content.json" } },
    toolArtifactContract: { schemaVersion: qaContract.resultSchemaVersion, role: "qa", inputStepId: "write" },
    toolArgs: { document: "{$steps.write.workProductPath}" } };
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "RevPub", stepsJson: [write, sourceQa] }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id, triggeredBy: "board" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const [issue] = await db.insert(issues).values({ companyId, missionId: sourceMission.id, title: "Write", status: "done" }).returning();
  const [writeStep] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "write",
    issueId: issue.id, status: "running", startedAt: new Date() }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId, agentId, issueId: issue.id, stepRunId: writeStep.id, heartbeatId });
  const dir = path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "write");
  await mkdir(dir, { recursive: true });
  const content = path.join(dir, "content.json"), contentBytes = Buffer.from('{"blocks":[]}');
  await writeFile(content, contentBytes);
  await workProductService(db).createForIssue(issue.id, companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: heartbeatId, metadata: { path: content, sha256: sha(contentBytes) } });
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, writeStep.id));
  // 원본 실행의 이전 검수 PASS: 같은 공개 경로(실행기→완료 기록)로 발급된 실제 영수증.
  const sourceRequestId = `${sourceRun.id}:qa:1`;
  const [sourceQaRun] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "qa",
    status: "running", lastDispatchRequestId: sourceRequestId, metadata: { artifactExecution: freezeArtifactAttempt({
      adapterConfig: { artifactContract: qaContract }, step: sourceQa, executionGeneration: 0, requestId: sourceRequestId }) } }).returning();
  const sourceArgs = await resolveWorkflowToolStepArgs({ db, run: sourceRun, step: sourceQa,
    workflowSteps: [write, sourceQa], consumerStepRunId: sourceQaRun.id });
  const sourceQaResult = await executeCoreWorkflowTool({ db, companyId, toolName: "revision-qa",
    workflowRunId: sourceRun.id, stepRunId: sourceQaRun.id, stepId: "qa", requestId: sourceRequestId, parameters: sourceArgs });
  expect(sourceQaResult.status).toBe(200);
  await completeWorkflowToolStepFromResult(db, { companyId, stepRunId: sourceQaRun.id, requestId: sourceRequestId,
    workflowRunId: sourceRun.id, stepId: "qa", toolName: "revision-qa", success: true,
    stdout: sourceQaResult.body.content, data: sourceQaResult.body.data,
    toolArtifactReceipt: sourceQaResult.toolArtifactReceipt, stderr: "", exitCode: 0 });
  const [sourceQaAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceQaRun.id));
  const sourceReceipt = meta(sourceQaAfter).toolArtifactReceipt as Receipt;
  await db.update(missions).set({ status: "completed" }).where(eq(missions.id, sourceMission.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  // 수정 실행 계획: 본문만 seed 재사용, 검수·게시·확인은 새 실행 계약의 새 단계.
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const revisionWrite: Step = { ...write, id: "revision-write", sourceStepId: "write" };
  const revisionQa: Step = { ...sourceQa, id: "revision-qa", dependencies: ["revision-write"],
    workProductSelectors: { "revision-write": { type: "document", title: "content.json" } },
    toolArtifactContract: { schemaVersion: qaContract.resultSchemaVersion, role: "qa", inputStepId: "revision-write" },
    toolArgs: { document: "{$steps.revision-write.workProductPath}" } };
  const revisionPublish: Step = { id: "revision-publish", name: "Publish", type: "tool", agentId: "",
    dependencies: ["revision-qa", "revision-write"], toolNames: ["revision-publish"],
    workProductSelectors: { "revision-write": { type: "document", title: "content.json" } },
    toolArgs: { review: "{$steps.revision-qa.workProductPath}", source: "{$steps.revision-write.workProductPath}", entry: "article", day: "2026-10-01" } };
  const revisionReadback: Step = { id: "revision-readback", name: "Readback", type: "tool", agentId: "",
    dependencies: ["revision-publish"], toolNames: ["revision-readback"],
    toolArgs: { publishResultPath: "{$steps.revision-publish.workProductPath}" } };
  await db.update(workflowDefinitions).set({ stepsJson: [revisionWrite, revisionQa, revisionPublish, revisionReadback] })
    .where(eq(workflowDefinitions.id, definition.id));
  return { companyId, sourceMission, sourceRun, writeStep, content, contentBytes, sourceReceipt,
    sourceReceiptPath: path.join(sourceReceipt.outputRoot, sourceReceipt.relativePath), revision,
    admit: () => createAdmittedWorkflowRun(db, { companyId, workflowId: definition.id, missionId: revision.id,
      triggeredBy: "board", seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["revision-write"] } }, board) };
}
const stepRunOf = async (runId: string, stepId: string) =>
  (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find(s => s.stepId === stepId)!;

it("[GREEN] 재사용된 본문에 새 검수→게시→확인이 현재 실행/시도에 묶여 실행된다", async () => {
  const f = await world();
  const target = await f.admit();
  await mkdir(path.join(root, "missions", f.revision.id), { recursive: true });
  for (let round = 0; round < 4; round++) { await executeWorkflowRun(db, target.id); await processQueuedWorkflowToolStepRuns(db); }
  const qa = await stepRunOf(target.id, "revision-qa"), publish = await stepRunOf(target.id, "revision-publish"),
    readback = await stepRunOf(target.id, "revision-readback");
  expect([qa, publish, readback].map(s => s.status)).toEqual(["completed", "completed", "completed"]);
  expect(await stepRunOf(target.id, "revision-write")).toMatchObject({ status: "completed", issueId: null }); // 본문 = 검증 seed 재사용
  const receipt = meta(qa).toolArtifactReceipt as Receipt | undefined;
  expect(receipt).toMatchObject({ role: "qa", workflowRunId: target.id, stepRunId: qa.id, missionId: f.revision.id,
    requestId: qa.lastDispatchRequestId, executionGeneration: qa.executionGeneration, retryCount: 0, iterationIndex: 0,
    input: { path: f.content, sha256: sha(f.contentBytes), // 새 검수 영수증 = 현재 실행 계약 + 원본 생산자 계보
      producer: { workflowRunId: f.sourceRun.id, stepRunId: f.writeStep.id } } });
  expect(receipt!.outputRoot).toContain(path.join("missions", f.revision.id)); // 검수 결과 루트 = 현재 실행 미션
  const publicationPath = (meta(publish).toolResult as { artifactPath: string }).artifactPath;
  expect(publicationPath).toContain(path.join("missions", f.revision.id)); // 게시 결과 경로 = 현재 실행 미션 루트
  expect(publicationPath).not.toContain(path.join("missions", f.sourceMission.id)); // 원본 실행 미션 아님
  const publication = JSON.parse(await readFile(publicationPath, "utf8"));
  expect(publication.scope).toMatchObject({ companyId: f.companyId, missionId: f.revision.id, workflowRunId: target.id,
    stepRunId: publish.id, requestId: publish.lastDispatchRequestId, executionGeneration: publish.executionGeneration });
  const freshQaBytes = await readFile(path.join(receipt!.outputRoot, receipt!.relativePath));
  expect(publication.inputDigest.qaSha256).toBe(sha(freshQaBytes)); // 게시는 새 검수 결과를 소비했다
  expect(sha(freshQaBytes)).not.toBe(sha(await readFile(f.sourceReceiptPath))); // 원본 검수 결과와 다른 bytes
  const readbackPath = (meta(readback).toolResult as { artifactPath: string }).artifactPath;
  const verified = JSON.parse(await readFile(readbackPath, "utf8"));
  expect(verified).toMatchObject({ command: "verify", id: "article", publicUrl: publication.publicUrl,
    scope: { workflowRunId: target.id, stepRunId: readback.id, requestId: readback.lastDispatchRequestId } }); // 확인 회수 = 현재 실행·확인 스텝런·시도
  expect(readbackPath).toContain(path.join("missions", f.revision.id));
  expect(await readFile(f.content, "utf8")).toBe('{"blocks":[]}'); // 재사용된 원본 bytes 불변
});

it("[RED] 이전 검수 PASS 를 새 실행 통과로 복사하는 경로가 없다(기록·소비·회수 모두 거절)", async () => {
  const f = await world();
  const target = await f.admit();
  await mkdir(path.join(root, "missions", f.revision.id), { recursive: true });
  await executeWorkflowRun(db, target.id); // seed 물화 + 새 검수 dispatch(queued, 아직 실행 전)
  const qa = await stepRunOf(target.id, "revision-qa");
  expect(qa.status).toBe("running");
  // 1) 완료 기록 경로: 원본 실행 영수증을 이번 실행 통과로 제출하면 스코프 불일치로 거절된다
  await expect(completeWorkflowToolStepFromResult(db, { companyId: f.companyId, stepRunId: qa.id,
    requestId: qa.lastDispatchRequestId, workflowRunId: target.id, stepId: "revision-qa", toolName: "revision-qa",
    success: true, toolArtifactReceipt: f.sourceReceipt })).rejects.toThrow("qa_artifact_receipt_scope_mismatch");
  const after = await stepRunOf(target.id, "revision-qa");
  expect(after.status).toBe("running"); // 부분 통과 기록이 남지 않는다
  expect(meta(after).toolArtifactReceipt).toBeUndefined();
  // 2) 소비 경로: 게시자는 원본 실행의 검수 영수증 경로를 받지 않는다(게시물 없음)
  const [steal] = await db.insert(workflowStepRuns).values({ workflowRunId: target.id, stepId: "steal-publish",
    status: "running", lastDispatchRequestId: "steal-1", metadata: { artifactExecution: freezeArtifactAttempt({
      adapterConfig: { artifactContract: publishContract }, step: {}, executionGeneration: 0, requestId: "steal-1" }) } }).returning();
  const refused = await executeCoreWorkflowTool({ db, companyId: f.companyId, toolName: "revision-publish",
    workflowRunId: target.id, stepRunId: steal.id, stepId: "steal-publish", requestId: "steal-1",
    parameters: { review: f.sourceReceiptPath, source: f.content, entry: "article", day: "2026-10-01" } });
  expect(refused.status).toBe(500);
  expect(refused.body.error).toContain("qa_artifact_consumer_receipt_required");
  expect(refused.artifactPath).toBeUndefined();
  // 3) 회수 경로: 현재 실행 검수 단계에는 읽을 수 있는 영수증이 없고 게시 단계는 대기 중이다
  await expect(resolveQaReceiptPath(db, { companyId: f.companyId, workflowRunId: target.id, stepId: "revision-qa" }))
    .rejects.toThrow("qa_artifact_receipt_unavailable");
  expect((await stepRunOf(target.id, "revision-publish")).status).toBe("pending");
});
