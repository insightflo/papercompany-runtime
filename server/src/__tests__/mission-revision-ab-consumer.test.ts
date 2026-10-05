// server/src/__tests__/mission-revision-ab-consumer.test.ts
//
// [수정 변경맵 — Q3 A+B 실제 소비] 유튜브 A(원본 실행 증거) 재사용 + B(신규 수집)를 같은 실행
// 계획 안에서 실제 후속 소비자에 결합한다. A는 검증된 seed/tool-output 증거로 승인·물화되고
// B는 이번 실행의 새 도구 실행(모형 수집 스크립트를 실제 tool runner 로 구동)으로 기록되며,
// 소비자 단계는 A+B 두 출력을 선언된 필수 입력(toolArgs 토큰)으로만 해석·발사된다. 실제 공개
// 경로(createAdmittedWorkflowRun → executeWorkflowRun → processQueuedWorkflowToolStepRuns →
// executeCoreWorkflowTool/completeWorkflowToolStepFromResult → resolveWorkflowToolStepArgs)과 실제
// DB+파일 fixture 만 사용한다(소스 문자열 검사 아님). 엔진 tool executor test double 은 app.ts
// 운영 executor 와 같은 결합(코어 도구 실행 → 결과 완료 기록)을 그대로 수행한다.
//
// GREEN-1) A seed 승인·물화와 B 신규 실행이 한 실행 계획에서 공존하고, 소비자 dispatch 표현과
//   toolArgs 해석이 A 원본 검증 파일 + B 새 산출물 두 값을 모두 받는다. B 는 독립 생산자(대상
//   run stepRun · 회사 미션 출력 루트 안 고유 경로)로 기록되어 A 파일을 덮지 않는다.
// RED-2) B 결과 미수령 / A 원본 시도 상향 / B 늦은 옛 결과·상대 경로·타회사 결과 / A 원본 파일
//   유실이 각각 구조화 이유로 거절되고 부분 실행·부분 소비가 남지 않는다.
// GREEN-3) [Q3 결합 완결] 종합(combine) 단계가 이번 실행의 실제 작업으로 A+B 해석 입력의 실제
//   bytes 에서 결합 산출물(combined.json · 승인 생산자 경로+공식 산출물 등록)을 만들고, 그 결합
//   bytes 에 대해 이번 실행 계약의 새 검수 → 게시 → 확인이 실제 tool executor 경로로 연결된다
//   (qa-publish-readback fixture 와 같은 모형 검수·게시·확인 도구 재사용). 검수 영수증·게시 결과·
//   확인 회수는 모두 현재 실행/시도에 결합되고 원본 A bytes·B 산출물은 불변이다. UI 는 범위 밖.
import "./helpers/workflow-control-node-boundary.js";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueWorkProducts, issues, missions, toolDefinitions, workflowDefinitions, workflowRunSeeds, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { board } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { executeCoreWorkflowTool, resolveWorkflowRunStepEnv } from "../services/workflow/core-tool-executor.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { workProductService } from "../services/work-products.js";
import { dependencyToolEvidence } from "../services/workflow/dependency-tool-evidence.js";
import { parseToolSeedEvidence } from "../services/workflow/workflow-seed-tool-output.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
let collectTools = false; // false: 엔진 dispatch 만 승인(외부 도구 결과 미수령 상태), true: 실제 도구 실행
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("ab-consumer-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ab-consumer-")));
  // [Q3 픽스처 교정] 원본 A 수집 모형 도구: A 산출도 B 와 같은 실제 완료 경로(코어 도구 실행 →
  // completeWorkflowToolStepFromResult)로 생산한다 — artifactPath·생산 시점 digest 기록은 생산 코드가 찍는다.
  await writeFile(path.join(root, "collect-a.mjs"), `import{mkdirSync,writeFileSync}from'node:fs';import path from'node:path';
const out=process.env.PAPERCLIP_STEP_OUTPUT_DIR;mkdirSync(out,{recursive:true});
const file=path.join(out,'result.json');
writeFileSync(file,'{"report":"A"}');
process.stdout.write(JSON.stringify({artifactPath:file}));`);
  // B 신규 수집 모형 도구: 자기 스텝 출력 디렉터리(PAPERCLIP_STEP_OUTPUT_DIR)에만 파일을 쓴다.
  await writeFile(path.join(root, "collect.mjs"), `import{mkdirSync,writeFileSync}from'node:fs';import path from'node:path';
const out=process.env.PAPERCLIP_STEP_OUTPUT_DIR;mkdirSync(out,{recursive:true});
const file=path.join(out,'collection.json');
writeFileSync(file,JSON.stringify({url:'https://youtu.be/B',items:['b-item']}));
process.stdout.write(JSON.stringify({artifactPath:file}));`);
  // [Q3 결합 완결] 결합 산출물의 새 검수→게시→확인 모형 도구 — qa-publish-readback fixture 의
  // 스크립트를 같은 패턴으로 재사용한다(검수: stdin 봉투 content digest + fd4 기계 채널,
  // 게시: 검수 봉투 소비 + toolArgs 대상/날짜, 확인: 게시 결과 bytes 회수).
  await writeFile(path.join(root, "qa.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`);
  await writeFile(path.join(root, "publish.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const a={};process.argv.slice(2).forEach((x,i,all)=>{if(x.startsWith('--'))a[x.slice(2)]=all[i+1];});
const entry=a.entry??'article',access=a.access,day=a.day??'2026-10-01';
const audience=access==='hidden'?'private':'public',url='https://example.org/'+entry;
const r={schemaVersion:'workflow.publication-result.v1',ok:true,command:'publish',mode:'content',section:'articles',
id:entry,date:day,title:null,publishedAt:day+'T00:00:00Z',publicUrl:url,
scope:JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE),
inputDigest:{mode:'content',sha256:v.content.sha256,qaSha256:v.qa.sha256,
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience,contentId:entry,slug:entry,publicUrl:url,liveStatus:200,blocks:1,assets:0,
commandKey:entry+':1',contentHash:'a'.repeat(64),contentBytes:123}};
fs.writeFileSync(4,JSON.stringify(r));`);
  await writeFile(path.join(root, "readback.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r=JSON.parse(Buffer.from(v.content.base64,'base64').toString('utf8'));
r.command='verify';r.scope=JSON.parse(process.env.PAPERCOMPANY_ARTIFACT_SCOPE);
fs.writeFileSync(4,JSON.stringify(r));`);
  // app.ts 운영 executor 와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록.
  setWorkflowToolStepExecutor(async (request) => {
    if (!collectTools) return { accepted: true };
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
// [Q3 결합 완결] 검수 영수증 산출물은 0o400 파일·0o500 디렉터리로 남는다 — 제거 전 쓰기 권한 회복(형제 fixture 패턴).
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const meta = (row: typeof workflowStepRuns.$inferSelect) => (row.metadata ?? {}) as Record<string, unknown>;
type Receipt = { outputRoot: string; relativePath: string } & Record<string, unknown>;
// [Q3 결합 완결] qa-publish-readback fixture 와 동일한 모형 검수·게시·확인 계약(스크립트 재사용).
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
type ToolStep = { id: string; sourceStepId?: string; name: string; type: string; agentId: string;
  dependencies: string[]; toolNames?: string[]; toolArgs?: Record<string, string>; graphWorkProductRequired?: boolean;
  workProductSelectors?: Record<string, { type: string; title: string }>;
  toolArtifactContract?: { schemaVersion: string; role: string; inputStepId: string } };

// 원본 실행: 유튜브 A 를 수집한 native tool 스텝이 완료 기록(metadata.toolResult · 현재 requestId ·
// 생산 시점 artifactSha256 · 회사 미션 출력 루트 안 artifact)을 남긴 채 실패 종료했다. 수정 실행 계획은 A 만 seed 로 재사용하고
// B(collect-b) 는 원본에 없는 신규 단계, 종합(combine) 은 A+B 를 모두 필수 입력으로 선언한다.
async function abWorld() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "AB", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Combiner", role: "operator", adapterType: "process" });
  // [Q3 픽스처 교정] 원본 A 수집 도구 등록 — A 는 이 도구의 실제 실행으로만 생산된다(손으로 찍은 기록 없음).
  await db.insert(toolDefinitions).values({ companyId, name: "youtube-collect", description: "Mock YouTube collection",
    adapterType: "builtin", adapterConfig: { command: `${process.execPath} ${path.join(root, "collect-a.mjs")}`,
      workingDirectory: root } });
  await db.insert(toolDefinitions).values({ companyId, name: "collect-b", description: "New B collection",
    adapterType: "builtin", adapterConfig: { command: `${process.execPath} ${path.join(root, "collect.mjs")}`,
      workingDirectory: root } });
  // [Q3 결합 완결] 결합 산출물의 새 검수·게시·확인 모형 도구(회사별 선언, artifact contract 결합).
  for (const [name, contract, script] of [["revision-qa", qaContract, "qa.mjs"], ["revision-publish", publishContract, "publish.mjs"],
    ["revision-readback", readbackContract, "readback.mjs"]] as const)
    await db.insert(toolDefinitions).values({ companyId, name, description: "Mock artifact tool", adapterType: "builtin",
      adapterConfig: { command: `${process.execPath} ${path.join(root, script)}`, workingDirectory: root, artifactContract: contract,
        ...(name === "revision-qa" ? { progress: { version: 1, idleTimeoutMs: 60000, maxDurationMs: 120000,
          stages: [{ key: "qa", unit: "items" }] } } : {}) } });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "active" }).returning();
  const sourceSteps: ToolStep[] = [
    { id: "collect-a", name: "Collect A", type: "tool", agentId: "", toolNames: ["youtube-collect"], dependencies: [] }];
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "AB", stepsJson: sourceSteps }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id, triggeredBy: "board" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  // [Q3 픽스처 교정] A 산출은 손으로 찍은 metadata.digest 나 손으로 만든 경로 대신 실제 완료 경로
  // (코어 도구 실행 → completeWorkflowToolStepFromResult)로 생산한다: artifactPath·생산 시점
  // artifactSha256·canonical 미션 출력 경로가 모두 생산 코드에서 기록된다(이전 2회 GREEN-3 불안정의
  // 픽스처 원인 제거 — B 는 큐 executor 가 같은 결합으로 실행한다).
  const aRequestId = randomUUID();
  const [aStep] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "collect-a",
    issueId: null, status: "running", startedAt: new Date(), lastDispatchRequestId: aRequestId }).returning();
  const aResult = await executeCoreWorkflowTool({ db, companyId, toolName: "youtube-collect", parameters: {},
    requestId: aRequestId, workflowRunId: sourceRun.id, stepRunId: aStep.id, stepId: "collect-a",
    stepEnv: await resolveWorkflowRunStepEnv(db, { companyId, workflowRunId: sourceRun.id, stepId: "collect-a" }) });
  if (aResult.status !== 200) throw new Error(`A source collect failed: ${aResult.body.error ?? aResult.status}`);
  await completeWorkflowToolStepFromResult(db, { companyId, stepRunId: aStep.id, requestId: aRequestId,
    workflowRunId: sourceRun.id, stepId: "collect-a", toolName: "youtube-collect", success: true,
    stdout: aResult.body.content, data: aResult.body.data, stderr: aResult.body.stderr ?? "", exitCode: 0 });
  const [aAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, aStep.id));
  const aRecord = (meta(aAfter!).toolResult ?? {}) as { artifactPath?: string; artifactSha256?: string };
  const aFile = aRecord.artifactPath!, aBytes = await readFile(aFile);
  expect(aFile).toBe(path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "collect-a", "result.json")); // canonical 미션 출력 경로
  expect(aRecord.artifactSha256).toBe(sha(aBytes)); // 완료 경로가 생산 시점 digest 를 기록했다(batch3 제품 수정)
  await db.update(missions).set({ status: "completed" }).where(eq(missions.id, sourceMission.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const steps: ToolStep[] = [
    { id: "collect-a2", sourceStepId: "collect-a", name: "Collect A", type: "tool", agentId: "", toolNames: ["youtube-collect"], dependencies: [] },
    { id: "collect-b", name: "Collect B", type: "tool", agentId: "", toolNames: ["collect-b"], dependencies: [] },
    { id: "combine", name: "Combine", type: "agent", agentId, dependencies: ["collect-a2", "collect-b"], graphWorkProductRequired: true,
      toolArgs: { reportA: "{$steps.collect-a2.workProductPath}", reportB: "{$steps.collect-b.workProductPath}" } },
    { id: "combine-qa", name: "QA", type: "tool", agentId: "", dependencies: ["combine"], toolNames: ["revision-qa"],
      workProductSelectors: { combine: { type: "document", title: "combined.json" } },
      toolArtifactContract: { schemaVersion: "workflow.qa-result.v1", role: "qa", inputStepId: "combine" },
      toolArgs: { document: "{$steps.combine.workProductPath}" } },
    { id: "combine-publish", name: "Publish", type: "tool", agentId: "", dependencies: ["combine-qa", "combine"],
      toolNames: ["revision-publish"], workProductSelectors: { combine: { type: "document", title: "combined.json" } },
      toolArgs: { review: "{$steps.combine-qa.workProductPath}", source: "{$steps.combine.workProductPath}", entry: "ab-report", day: "2026-10-01" } },
    { id: "combine-readback", name: "Readback", type: "tool", agentId: "", dependencies: ["combine-publish"],
      toolNames: ["revision-readback"], toolArgs: { publishResultPath: "{$steps.combine-publish.workProductPath}" } }];
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition.id));
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board" as const,
    seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["collect-a2"] } };
  return { companyId, agentId, sourceMission, sourceRun, aStep: aAfter!, aFile, aBytes, revision, steps,
    admit: () => createAdmittedWorkflowRun(db, input, board) };
}
type AbWorld = Awaited<ReturnType<typeof abWorld>>;
const stepRunOf = async (runId: string, stepId: string) =>
  (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find(s => s.stepId === stepId)!;
const combineArgs = (f: AbWorld, target: { id: string; companyId: string }, combine: { id: string }) =>
  resolveWorkflowToolStepArgs({ db, run: target, step: f.steps[2], workflowSteps: f.steps, consumerStepRunId: combine.id });
const noIssues = async (f: AbWorld) =>
  expect(await db.select().from(issues).where(eq(issues.missionId, f.revision.id))).toEqual([]);

it("[GREEN-1] A 재사용 + B 신규 수집이 소비자의 선언된 필수 입력 2개로 실제 결합된다", async () => {
  collectTools = true;
  const f = await abWorld();
  const target = await f.admit();
  const [seed] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seed).toMatchObject({ companyId: f.companyId, sourceRunId: f.sourceRun.id, sourceStepRunId: f.aStep.id,
    sourceStepId: "collect-a", targetStepId: "collect-a2", approvedByUserId: "local-board" }); // A 는 검증 seed 증거로만
  expect(parseToolSeedEvidence(seed.evidence)?.artifact).toMatchObject({ path: f.aFile, sha256: sha(f.aBytes),
    byteSize: f.aBytes.length, executionGeneration: 0, retryCount: 0, iterationIndex: 0 });
  await executeWorkflowRun(db, target.id); // A seed 물화 + B 엔진 dispatch(queued)
  await processQueuedWorkflowToolStepRuns(db); // B 실제 도구 실행 → 완료 sync 가 소비자를 발사한다
  await executeWorkflowRun(db, target.id);
  const a2 = await stepRunOf(target.id, "collect-a2"), b = await stepRunOf(target.id, "collect-b"),
    combine = await stepRunOf(target.id, "combine");
  expect(a2).toMatchObject({ status: "completed", issueId: null }); // A: 검증 seed 물화(phantom issue 없음)
  expect(b).toMatchObject({ status: "completed", issueId: null, workflowRunId: target.id }); // B: 이번 실행 신규 생산자
  const bToolResult = ((b.metadata ?? {}) as { toolResult?: { artifactPath?: string; requestId?: string | null; success?: boolean } }).toolResult!;
  expect(bToolResult).toMatchObject({ success: true, requestId: b.lastDispatchRequestId }); // 시도 스코프에 묶인 기록
  const bArtifact = bToolResult.artifactPath!;
  expect(bArtifact).toContain(path.join("missions", f.revision.id)); // 회사 미션 출력 루트 안
  expect(bArtifact).not.toBe(f.aFile); // A 파일과 충돌 없는 독립 경로
  expect(await readFile(f.aFile, "utf8")).toBe('{"report":"A"}'); // A 원본 bytes 불변(B 가 덮지 않음)
  expect(await readFile(bArtifact, "utf8")).toContain("youtu.be/B"); // B 새 산출물 실재
  expect(combine.issueId).toBeTruthy(); // 소비자 실제 dispatch
  const [combineIssue] = await db.select().from(issues).where(eq(issues.id, combine.issueId!));
  expect(combineIssue.description).toContain(f.aFile); // dispatch 표현 = A 원본 검증 파일
  expect(combineIssue.description).toContain(bArtifact); // dispatch 표현 = B 새 산출물
  expect(await combineArgs(f, target, combine)).toEqual({ reportA: f.aFile, reportB: bArtifact }); // 두 필수 입력 해석
  const evidence = await dependencyToolEvidence(db, { companyId: f.companyId, runId: target.id, stepIds: ["collect-a2", "collect-b"] });
  expect(evidence).toHaveLength(2);
  expect(evidence.find(e => e.path === f.aFile)).toMatchObject({ type: "dependency_tool_artifact", id: a2.id,
    description: "Board-approved tool artifact for step collect-a2" }); // A 계보 = board 승인 seed
  expect(evidence.find(e => e.path === bArtifact)).toMatchObject({ type: "dependency_tool_artifact", id: b.id,
    description: "Workflow tool artifact from step collect-b" }); // B 계보 = 이번 실행 도구 산출물
});

it("[RED-2a] B 결과 미수령이면 소비자 해석이 거절되고 발사·이슈가 없다(부분 실행 없음)", async () => {
  collectTools = false;
  const f = await abWorld();
  const target = await f.admit();
  await executeWorkflowRun(db, target.id); // A 만 물화, B 는 결과 없는 running
  expect(await stepRunOf(target.id, "collect-a2")).toMatchObject({ status: "completed", issueId: null });
  const combine = await stepRunOf(target.id, "combine");
  await expect(combineArgs(f, target, combine)).rejects.toThrow("collect-b"); // 필수 입력 B 누락 → 구조화 거절
  expect(combine.issueId).toBeNull();
  await noIssues(f);
});

it("[RED-2b] A 원본 시도가 상향되면 실행 시작 전체가 거절되고 부분 재사용이 없다", async () => {
  const f = await abWorld();
  const target = await f.admit();
  await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, f.aStep.id)); // 원본 재시도 상향
  await expect(executeWorkflowRun(db, target.id)).rejects.toThrow("workflow_seed_source_attempt_changed");
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id)))
    .filter(s => s.status === "completed")).toEqual([]); // A 물화도 남지 않는다(롤백)
  await noIssues(f);
});

it("[RED-2c] B 의 늦은 옛 결과·상대 경로·타회사 결과는 모두 거절되고 기록·소비가 없다", async () => {
  collectTools = false;
  const f = await abWorld();
  const target = await f.admit();
  await executeWorkflowRun(db, target.id);
  const b = await stepRunOf(target.id, "collect-b");
  const late = b.lastDispatchRequestId!;
  const current = randomUUID();
  await db.update(workflowStepRuns).set({ lastDispatchRequestId: current }).where(eq(workflowStepRuns.id, b.id)); // 재발급된 시도
  const complete = (patch: Partial<Parameters<typeof completeWorkflowToolStepFromResult>[1]>) =>
    completeWorkflowToolStepFromResult(db, { companyId: f.companyId, workflowRunId: target.id, stepRunId: b.id,
      stepId: "collect-b", toolName: "collect-b", success: true, ...patch });
  expect(await complete({ requestId: late, data: { artifactPath: path.join(root, "stale.json") } })).toBeNull(); // 옛 시도 = 0-쓰기 거절
  await expect(complete({ requestId: current, data: { artifactPath: "relative/out.json" } }))
    .rejects.toThrow("workflow_tool_result_rejected"); // 상대 경로 = 구조화 거절
  expect(await complete({ companyId: randomUUID(), requestId: current, data: { artifactPath: path.join(root, "x.json") } })).toBeNull(); // 타회사 = 0-쓰기 거절
  const after = await stepRunOf(target.id, "collect-b");
  expect((after.metadata ?? {}).toolResult).toBeUndefined(); // 어떤 결과도 기록되지 않았다
  expect(after.status).toBe("running");
  const combine = await stepRunOf(target.id, "combine");
  await expect(combineArgs(f, target, combine)).rejects.toThrow("collect-b"); // 소비자 여전히 거절
  await noIssues(f);
});

it("[RED-2d] A 원본 파일이 유실되면 소비자 해석이 복사본 대체 없이 거절된다", async () => {
  collectTools = false;
  const f = await abWorld();
  const target = await f.admit();
  await executeWorkflowRun(db, target.id); // A 물화는 살아있는 원본 검증으로 통과
  await rm(f.aFile); // 이후 원본 증거 유실
  const combine = await stepRunOf(target.id, "combine");
  await expect(combineArgs(f, target, combine)).rejects.toThrow("workflow_seed_artifact_unreadable"); // 매 읽기 원본 재검증
  expect(combine.issueId).toBeNull();
});

// [Q3 결합 완결] 결합 단계 완료: 이번 실행이 발사한 결합 이슈를 실제 승인 생산자 경로(웨이크+하트비트
// 승인+공식 산출물 등록)로 마감하고, 해석된 A+B 두 필수 입력의 실제 bytes 로 결합 산출물을 현재 실행
// 미션 출력 루트 안 결합 단계 디렉터리에 남긴다(원본 A 파일·B 산출물은 직접 건드리지 않는다).
async function completeCombinedOutput(f: AbWorld, target: { id: string }, combine: typeof workflowStepRuns.$inferSelect) {
  if (!combine.issueId) throw new Error("combine was not dispatched as this run's own work item");
  const args = await combineArgs(f, target, combine) as { reportA: string; reportB: string };
  const heartbeat = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, combine.id));
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: combine.issueId, stepRunId: combine.id, heartbeatId: heartbeat });
  const dir = path.join(root, "missions", f.revision.id, "runs", target.id, "steps", "combine");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "combined.json");
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: "ab.combined.v1",
    reportA: JSON.parse(await readFile(args.reportA, "utf8")), reportB: JSON.parse(await readFile(args.reportB, "utf8")) }));
  await writeFile(file, bytes);
  await workProductService(db).createForIssue(combine.issueId, f.companyId, { provider: "local_file", type: "document",
    title: "combined.json", status: "active", createdByRunId: heartbeat, metadata: { path: file, sha256: sha(bytes) } });
  await db.update(issues).set({ status: "done" }).where(eq(issues.id, combine.issueId));
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, combine.id));
  return { file, bytes };
}

it("[GREEN-3] A 재사용+B 신규의 결합 산출물에 새 검수→게시→확인이 현재 실행에 묶여 실행된다", async () => {
  collectTools = true;
  const f = await abWorld();
  const target = await f.admit();
  await mkdir(path.join(root, "missions", f.revision.id), { recursive: true });
  await executeWorkflowRun(db, target.id); // A seed 물화 + B 엔진 dispatch(queued)
  await processQueuedWorkflowToolStepRuns(db); // B 실제 도구 실행 → 완료 sync 가 결합(combine) 이슈를 발사한다
  const b = await stepRunOf(target.id, "collect-b");
  const bToolResult = ((b.metadata ?? {}) as { toolResult?: { artifactPath?: string; artifactSha256?: string } }).toolResult!;
  const bArtifact = bToolResult.artifactPath!, bBytes = await readFile(bArtifact);
  expect(bToolResult.artifactSha256).toBe(sha(bBytes)); // B 완료 기록도 실제 완료 경로의 생산 시점 digest
  const combine = await stepRunOf(target.id, "combine");
  if (!combine.issueId) throw new Error("combine was not dispatched as this run's own work item");
  const combined = await completeCombinedOutput(f, target, combine); // A+B 실제 bytes 결합 산출물(승인 생산자 경로)
  for (let round = 0; round < 6 && (await stepRunOf(target.id, "combine-readback")).status !== "completed"; round++) {
    // 수동 마감된 결합 이후의 파이프라인은 실제 공개 sync 경로로 발화한다(형제 fixture 패턴).
    await syncWorkflowRunState(db, target.id); await processQueuedWorkflowToolStepRuns(db); // 새 검수→게시→확인
  }
  const a2 = await stepRunOf(target.id, "collect-a2"), bAfter = await stepRunOf(target.id, "collect-b"),
    combineAfter = await stepRunOf(target.id, "combine"), qa = await stepRunOf(target.id, "combine-qa"),
    publish = await stepRunOf(target.id, "combine-publish"), readback = await stepRunOf(target.id, "combine-readback");
  expect([a2, bAfter, combineAfter, qa, publish, readback].map(s => s.status))
    .toEqual(["completed", "completed", "completed", "completed", "completed", "completed"]); // 사슬 전체 완결
  expect((await db.select({ stepId: workflowStepRuns.stepId }).from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, target.id))).map(r => r.stepId).sort())
    .toEqual(["collect-a2", "collect-b", "combine", "combine-publish", "combine-qa", "combine-readback"]); // 이 실행 계획의 6단계만
  expect(a2).toMatchObject({ issueId: null }); // A = 검증 seed 물화(실행 이슈 없음)
  expect(combineAfter.issueId).toBe(combine.issueId); // 결합 = 이번 실행의 실제 작업 이슈
  // 결합 산출물: 해석된 A+B 두 필수 입력의 실제 bytes 가 그대로 반영되고 공식 산출물로 등록되었다(저장 digest)
  expect(JSON.parse(await readFile(combined.file, "utf8"))).toEqual({ schemaVersion: "ab.combined.v1",
    reportA: { report: "A" }, reportB: { url: "https://youtu.be/B", items: ["b-item"] } });
  const combinedProduct = (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, f.companyId)))
    .find(p => p.title === "combined.json")!;
  expect(combinedProduct.metadata).toMatchObject({ path: combined.file, sha256: sha(combined.bytes) });
  expect((combinedProduct.metadata as { workflowProducer?: { workflowRunId?: string; stepRunId?: string } }).workflowProducer)
    .toMatchObject({ workflowRunId: target.id, stepRunId: combine.id }); // 결합 산출물 생산자 = 현재 실행 결합 단계
  // 새 검수 영수증 = 결합 bytes + 현재 실행 계약 + 이번 실행 결합 생산자 계보(원본 실행 기록 복제 아님)
  const receipt = meta(qa).toolArtifactReceipt as Receipt;
  expect(receipt).toMatchObject({ role: "qa", workflowRunId: target.id, stepRunId: qa.id, missionId: f.revision.id,
    requestId: qa.lastDispatchRequestId, executionGeneration: qa.executionGeneration, retryCount: 0, iterationIndex: 0,
    input: { path: combined.file, sha256: sha(combined.bytes),
      producer: { workflowRunId: target.id, stepRunId: combine.id } } });
  expect(receipt.outputRoot).toContain(path.join("missions", f.revision.id)); // 검수 결과 루트 = 현재 실행 미션
  // 게시 = 결합 bytes + 이번 실행 새 검수 소비, 결과 경로·스코프 = 현재 실행 미션·게시 스텝런·시도
  const publicationPath = (meta(publish).toolResult as { artifactPath: string }).artifactPath;
  expect(publicationPath).toContain(path.join("missions", f.revision.id));
  expect(publicationPath).not.toContain(path.join("missions", f.sourceMission.id)); // 원본 실행 미션 아님
  const publication = JSON.parse(await readFile(publicationPath, "utf8"));
  expect(publication).toMatchObject({ id: "ab-report", publicUrl: "https://example.org/ab-report" });
  expect(publication.scope).toMatchObject({ companyId: f.companyId, missionId: f.revision.id, workflowRunId: target.id,
    stepRunId: publish.id, requestId: publish.lastDispatchRequestId, executionGeneration: publish.executionGeneration });
  const freshQaBytes = await readFile(path.join(receipt.outputRoot, receipt.relativePath));
  expect(publication.inputDigest.sha256).toBe(sha(combined.bytes)); // 게시는 A+B 결합 bytes 를 소비했다
  expect(publication.inputDigest.qaSha256).toBe(sha(freshQaBytes)); // 게시는 이번 실행 새 검수 결과를 소비했다
  // 확인 회수 = 현재 실행·확인 스텝런·시도에 결합된 결합 산출물 게시물
  const readbackPath = (meta(readback).toolResult as { artifactPath: string }).artifactPath;
  const verified = JSON.parse(await readFile(readbackPath, "utf8"));
  expect(verified).toMatchObject({ command: "verify", id: "ab-report", publicUrl: publication.publicUrl,
    scope: { workflowRunId: target.id, stepRunId: readback.id, requestId: readback.lastDispatchRequestId } });
  expect(readbackPath).toContain(path.join("missions", f.revision.id));
  // 원본 A bytes · B 산출물 불변: 결합·검수·게시·확인 어느 경로도 덮지 않는다
  expect(await readFile(f.aFile, "utf8")).toBe('{"report":"A"}');
  expect(await readFile(bArtifact)).toEqual(bBytes);
  // 옛 소스 영수증·기록 미복제: 물화된 A 스텝런에는 영수증·toolResult 사본이 없고 seed 는 A 하나뿐이다
  expect(meta(a2).toolArtifactReceipt).toBeUndefined();
  expect(meta(a2).toolResult).toBeUndefined();
  const [sourceAAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.aStep.id));
  expect(meta(sourceAAfter!).toolArtifactReceipt).toBeUndefined(); // 원본 A 는 끝까지 영수증 없는 내구 toolResult
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id))).toHaveLength(1);
}, 60000);
