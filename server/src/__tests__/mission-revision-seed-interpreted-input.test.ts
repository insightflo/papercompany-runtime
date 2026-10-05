// server/src/__tests__/mission-revision-seed-interpreted-input.test.ts
//
// [수정 변경맵 Q11 — TEST FIRST] 같은 토큰 설정이라도 "실제 해석 입력"이 다르면 seed 재사용을 거절하고,
// 서버가 의존관계로 유도한 영향 집합만 무효화한다(독립 분기 제외). 공개 경로(createAdmittedWorkflowRun
// → bindSeedInterpretedInputs → verifySeedEvidence/verifyToolSeedEvidence)와 실제 DB+파일 fixture만
// 사용한다(모형 stub 없음).
// (a) 같은 토큰·같은 실제 값({$steps.*}·{$runMetadata.*}/{$childInputs.*} namespace·{$runDate}/{$date}/
//     {$runMonth} run 좌표 모두 포함) → 재사용 승인 + 실제 해석값 바인딩·물화 재검증 통과
// (b) 같은 토큰인데 실제 값이 다른 경우 — 생산자 실제 기록 교체(원본 산출물 보관 처리 + 동일 selector
//     신규 산출물), run metadata 실제 값 변경, runDate 실제 값 변경, workflowRunId(실행마다 다른 run
//     좌표) — 각각 workflow_seed_interpreted_input_mismatch 거절 + 내구 run/seed 미생성
// (c) 영향 집합은 서버 계산(use 하류 publish 만), 독립 분기(solo)·변경 없는 생산자(write) 재사용 유지
// (d) run/child 같은 이름 키는 namespace 로 구분되어 독립 대조된다(한쪽만 바뀌어도 거절)
// (e) 승인 뒤 대상(현재 실행) run 레코드 실제값 drift → 물화 재검증에서 해당 seed 만 거절
// (f) native tool 스텝도 동일 게이트(!toolArtifact 예외 제거) — 같은 실제값이면 바인딩, 다르면 거절
import "./helpers/workflow-control-node-boundary.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueWorkProducts, issues, missions, toolDefinitions, workflowDefinitions, workflowRunSeeds, workflowRuns, workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { board } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { verifySeedEvidence } from "../services/workflow/workflow-seed-evidence.js";
import { verifyToolSeedEvidence } from "../services/workflow/workflow-seed-tool-output.js";
import { workProductService } from "../services/work-products.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-seed-interpreted-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-seed-interpreted-")));
  // [Q7 생성 시점 도구 재검사] (f) native tool 스텝 admission 이 engine 과 같은 준비성 검사를 지나므로
  // 프로세스에 tool executor 가 설정돼 있어야 한다(기존 workflow-seed-tool-output fixture 와 동일한 test double).
  setWorkflowToolStepExecutor(async () => ({ accepted: true })); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const RUN_DATE = "2026-10-03";
const selector = { type: "document" as const, title: "content.json" };
const stepsJson = (agentId: string, extraUseArgs: Record<string, string> = {}) => [
  { id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
  { id: "use", name: "Use", type: "agent", agentId, dependencies: ["write"], workProductSelectors: { write: selector },
    toolArgs: { content: "{$steps.write.workProductPath}", label: "{$runMetadata.topic}", tag: "{$runMetadata.tag}",
      childTag: "{$childInputs.tag}", day: "{$runDate}", stamp: "{$date}", month: "{$runMonth}", ...extraUseArgs } },
  { id: "publish", name: "Publish", type: "agent", agentId, dependencies: ["use"], graphWorkProductRequired: true },
  { id: "solo", name: "Solo", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
];
// run/child namespace 가 같은 이름 키(tag)를 가지는 run metadata — 충돌 은폐 대조용.
const runMetadata = (topic: string) => ({ topic, tag: "run-tag", workflowChildInputs: { tag: "child-tag" } });

type World = ReturnType<typeof seedInputWorld>;

async function completedProducerStep(db: Db, world: { companyId: string; agentId: string;
  sourceMission: typeof missions.$inferSelect; sourceRun: typeof workflowRuns.$inferSelect },
  stepId: string, fileName: string, bytes: string) {
  const [issue] = await db.insert(issues).values({ companyId: world.companyId, missionId: world.sourceMission.id,
    title: stepId, status: "done" }).returning();
  const [stepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: world.sourceRun.id, stepId,
    issueId: issue.id, status: "running", startedAt: new Date() }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId: world.companyId, agentId: world.agentId, issueId: issue.id,
    stepRunId: stepRun.id, heartbeatId });
  const dir = path.join(root, "missions", world.sourceMission.id, "runs", world.sourceRun.id, "steps", stepId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(issue.id, world.companyId, { provider: "local_file",
    type: "document", title: fileName, status: "active", createdByRunId: heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, stepRun.id));
  return { issue, stepRun, heartbeatId, file, product: product! };
}

async function seedInputWorld(db: Db, topic: string, extraUseArgs: Record<string, string> = {}) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seed", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "operator", adapterType: "process" });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Seed", stepsJson: stepsJson(agentId, extraUseArgs) }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id,
    triggeredBy: "board", runDate: RUN_DATE, metadata: runMetadata(topic) });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const world = { companyId, agentId, sourceMission, definition, sourceRun };
  const write = await completedProducerStep(db, world, "write", "content.json", '{"blocks":[]}');
  const use = await completedProducerStep(db, world, "use", "used.json", '{"used":true}');
  const publish = await completedProducerStep(db, world, "publish", "published.json", '{"published":true}');
  const solo = await completedProducerStep(db, world, "solo", "solo.json", '{"solo":true}');
  // 실행 시점 실제 소비 기록: use 스텝런이 write 의 원본 산출물을 핀으로 남겼다(workflowStepOutputBindings).
  await db.insert(workflowStepOutputBindings).values({ companyId, workflowRunId: sourceRun.id,
    consumerStepRunId: use.stepRun.id, referencedStepId: "write", workProductId: write.product.id });
  await db.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board",
    runDate: RUN_DATE, metadata: runMetadata(topic),
    seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["write", "use", "publish", "solo"] } };
  return { ...world, write, use, publish, solo, revision, input,
    admit: (stepIds = input.seedFromRun.stepIds) => createAdmittedWorkflowRun(db, { ...input,
      seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds } }, board) };
}

// 생산자 실제 기록 교체: 원본 산출물 보관 처리 + 같은 selector(title)의 신규 산출물 — 선언 설정·토큰은 그대로.
async function replaceWriteProduct(f: World) {
  await db.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, f.write.product.id));
  const bytes = '{"blocks":[],"v2":true}';
  const file = path.join(path.dirname(f.write.file), "content.v2.json");
  await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(f.write.issue.id, f.companyId, { provider: "local_file",
    type: "document", title: "content.json", status: "active", createdByRunId: f.write.heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  expect(product).toBeTruthy();
  return product!;
}

// native tool 스텝 seed 세계: toolArgs 값 토큰({$runMetadata.topic}/{$runDate})을 가진 issue 없는 tool 스텝이
// 완료 기록(metadata.toolResult · 현재 requestId · 생산 시점 artifactSha256 · 회사 미션 출력 루트 안
// artifact)을 남겼다.
async function nativeToolWorld(db: Db, topic: string) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seed", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Renderer", role: "operator", adapterType: "process" });
  // [Q7 생성 시점 도구 재검사] admission 이 도구 카탈로그를 대조하므로 render-tool 을 회사에 실제 등록한다.
  await db.insert(toolDefinitions).values({ companyId, name: "render-tool", description: "Render fixture",
    adapterType: "builtin", adapterConfig: { command: "true" } });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Seed", stepsJson: [
    { id: "render", name: "Render", type: "tool", agentId: "", toolNames: ["render-tool"], dependencies: [],
      toolArgs: { label: "{$runMetadata.topic}", day: "{$runDate}" } }] }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id,
    triggeredBy: "board", runDate: RUN_DATE, metadata: { topic } });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const requestId = randomUUID();
  const [renderStep] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "render",
    issueId: null, status: "running", startedAt: new Date(), lastDispatchRequestId: requestId }).returning();
  const dir = path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "render");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "result.json"), bytes = '{"rendered":true}';
  await writeFile(file, bytes);
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(),
    metadata: { toolResult: { requestId, toolName: "render-tool", success: true, artifactPath: file,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"), stdout: null, stderr: null, exitCode: 0,
      error: null, completedAt: new Date().toISOString() } } }).where(eq(workflowStepRuns.id, renderStep.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board" as const,
    runDate: RUN_DATE, metadata: { topic },
    seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["render"] } };
  return { companyId, sourceRun, renderStep, revision, input,
    admit: () => createAdmittedWorkflowRun(db, input, board), file };
}

it("(a) 같은 토큰 설정·같은 실제 값이면 재사용이 승인되고 실제 해석값이 바인딩·재검증된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const target = await f.admit();
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seeds.map(s => s.targetStepId).sort()).toEqual(["publish", "solo", "use", "write"]);
  const useSeed = seeds.find(s => s.targetStepId === "use")!;
  expect(useSeed.evidence).toMatchObject({ schemaVersion: "workflow.seed.v1",
    interpretedInputs: { schemaVersion: "workflow.seed.interpreted-inputs.v1",
      references: [{ stepId: "write", workProductId: f.write.product.id, path: f.write.file }],
      metadataValues: { "runMetadata:topic": "alpha", "runMetadata:tag": "run-tag", "childInputs:tag": "child-tag" },
      runCoordinateValues: { runDate: RUN_DATE, date: RUN_DATE, runMonth: "202610" } } });
  expect((useSeed.evidence as { interpretedInputs: { argsDigest: string } }).interpretedInputs.argsDigest).toMatch(/^[a-f0-9]{64}$/);
  for (const seed of seeds) await expect(verifySeedEvidence(db, seed)).resolves.toBeTruthy(); // 물화 재검증 통과
}, 60000);

it("(b) 같은 토큰인데 실제 값이 다르면 구조적 사유로 거절되고 내구 상태가 남지 않는다", async () => {
  const f = await seedInputWorld(db, "alpha");
  await replaceWriteProduct(f);
  const failure = await f.admit().then(() => null, (error: unknown) => error);
  expect(failure, "같은 토큰 설정·다른 실제 값은 재사용 승인을 무효화해야 한다").toBeTruthy();
  expect(String(failure)).toContain("workflow_seed_interpreted_input_mismatch");
  const details = (failure as { details?: { stepId?: string; affectedStepIds?: string[] } }).details;
  expect(details?.stepId).toBe("use");
  expect(details?.affectedStepIds).toEqual(["publish", "use"]); // 서버 계산: use 와 그 하류만(write·solo 제외)
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, f.companyId))).toEqual([]);
  // 대조: run metadata 실제 값이 다른 경우도 같은 토큰·다른 실제 값으로 거절된다.
  const g = await seedInputWorld(db, "alpha");
  const changed = await createAdmittedWorkflowRun(db, { ...g.input, metadata: runMetadata("beta") }, board)
    .then(() => null, (error: unknown) => error);
  expect(String(changed)).toContain("workflow_seed_interpreted_input_mismatch");
  // 대조: runDate 실제 값이 다른 경우 — run 좌표 토큰 커버리지(같은 토큰·다른 실제 값 거절).
  const h = await seedInputWorld(db, "alpha");
  const changedDate = await createAdmittedWorkflowRun(db, { ...h.input, runDate: "2026-10-04" }, board)
    .then(() => null, (error: unknown) => error);
  expect(String(changedDate)).toContain("workflow_seed_interpreted_input_mismatch");
  const dateDetails = (changedDate as { details?: { phase?: string; stepId?: string; affectedStepIds?: string[] } }).details;
  expect(dateDetails?.phase).toBe("admission_run_coordinate");
  expect(dateDetails?.stepId).toBe("use");
  expect(dateDetails?.affectedStepIds).toEqual(["publish", "use"]);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, h.revision.id))).toEqual([]);
  // 대조: workflowRunId 토큰은 실행 run 좌표가 원본과 항상 다르므로 재사용이 항상 거절된다.
  const w = await seedInputWorld(db, "alpha", { runId: "{$workflowRunId}" });
  const runIdRefused = await w.admit().then(() => null, (error: unknown) => error);
  expect(String(runIdRefused)).toContain("workflow_seed_interpreted_input_mismatch");
}, 60000);

it("(c) 영향은 선택적이다 — 교체 뒤에도 write·solo 재사용 승인은 유지된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const replacement = await replaceWriteProduct(f);
  const target = await f.admit(["write", "solo"]); // 영향받지 않은 재사용만 요청
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seeds.map(s => s.targetStepId).sort()).toEqual(["solo", "write"]);
  expect((seeds.find(s => s.targetStepId === "write")!.evidence as { products: Array<{ id: string }> }).products)
    .toEqual([expect.objectContaining({ id: replacement.id })]); // 검증된 현재 산출물로 승인(기록 위조 아님)
  for (const seed of seeds) await expect(verifySeedEvidence(db, seed)).resolves.toBeTruthy(); // 독립 분기 재검증 통과
}, 60000);

it("(d) run 과 child 의 같은 이름 키는 namespace 로 구분되어 각각 독립 대조된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const target = await f.admit();
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  const useSeed = seeds.find(s => s.targetStepId === "use")!;
  expect((useSeed.evidence as { interpretedInputs: { metadataValues: Record<string, string> } }).interpretedInputs.metadataValues)
    .toMatchObject({ "runMetadata:tag": "run-tag", "childInputs:tag": "child-tag" }); // 같은 이름 키가 둘 다 바인딩
  await expect(verifySeedEvidence(db, useSeed)).resolves.toBeTruthy();
  // 한쪽 namespace 실제값만 바뀌어도 거절 — run 쪽(bare-key 충돌 시 놓치던 방향)과 child 쪽 모두.
  const g = await seedInputWorld(db, "alpha");
  const runDrift = await createAdmittedWorkflowRun(db, { ...g.input,
    metadata: { ...runMetadata("alpha"), tag: "run-drift" } }, board).then(() => null, (error: unknown) => error);
  expect(String(runDrift)).toContain("workflow_seed_interpreted_input_mismatch");
  const h = await seedInputWorld(db, "alpha");
  const childDrift = await createAdmittedWorkflowRun(db, { ...h.input,
    metadata: { ...runMetadata("alpha"), workflowChildInputs: { tag: "child-drift" } } }, board)
    .then(() => null, (error: unknown) => error);
  expect(String(childDrift)).toContain("workflow_seed_interpreted_input_mismatch");
}, 60000);

it("(e) 승인 뒤 대상(현재 실행) 실제값이 물화 재검증에서 어긋나면 해당 seed 만 거절된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const target = await f.admit();
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  const [targetRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id));
  // 승인 이후 대상 run 레코드의 실제값 drift — 원본측 재렌더만으로는 잡히지 않는 변화.
  await db.update(workflowRuns).set({ metadata: runMetadata("beta") }).where(eq(workflowRuns.id, targetRun.id));
  await expect(verifySeedEvidence(db, seeds.find(s => s.targetStepId === "use")!))
    .rejects.toThrow("workflow_seed_interpreted_input_mismatch");
  for (const seed of seeds.filter(s => s.targetStepId !== "use")) {
    await expect(verifySeedEvidence(db, seed)).resolves.toBeTruthy(); // 토큰 없는 스텝의 재검증은 유지
  }
  // 대조: 대상 runDate drift 도 물화 재검증에서 거절된다.
  const g = await seedInputWorld(db, "alpha");
  const target2 = await g.admit();
  const seeds2 = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target2.id));
  const [targetRun2] = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, g.revision.id));
  await db.update(workflowRuns).set({ runDate: "2026-10-05" }).where(eq(workflowRuns.id, targetRun2.id));
  await expect(verifySeedEvidence(db, seeds2.find(s => s.targetStepId === "use")!))
    .rejects.toThrow("workflow_seed_interpreted_input_mismatch");
}, 60000);

it("(f) native tool 스텝도 실제 해석 인자 비교를 통과한다 — 같은 실제값은 바인딩, 다른 값은 거절", async () => {
  const f = await nativeToolWorld(db, "alpha");
  const target = await f.admit();
  const [seed] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seed.targetStepId).toBe("render");
  expect(seed.evidence).toMatchObject({ schemaVersion: "workflow.seed.tool-output.v1",
    interpretedInputs: { schemaVersion: "workflow.seed.interpreted-inputs.v1",
      metadataValues: { "runMetadata:topic": "alpha" }, runCoordinateValues: { runDate: RUN_DATE } } });
  await expect(verifyToolSeedEvidence(db, seed)).resolves.toBeTruthy(); // 물화 재검증 통과
  // 대조: 대상 run 의 metadata 실제값이 다르면 native tool 도 거절된다(토큰 없는 스텝은 기존 동작 유지).
  const g = await nativeToolWorld(db, "alpha");
  const refused = await createAdmittedWorkflowRun(db, { ...g.input, metadata: { topic: "beta" } }, board)
    .then(() => null, (error: unknown) => error);
  expect(String(refused)).toContain("workflow_seed_interpreted_input_mismatch");
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, g.companyId))).toEqual([]);
}, 60000);
