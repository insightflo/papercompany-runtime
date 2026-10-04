// server/src/__tests__/mission-revision-seed-interpreted-input.test.ts
//
// [수정 변경맵 Q11 — TEST FIRST] 같은 토큰 설정이라도 "실제 해석 입력"이 다르면 seed 재사용을 거절하고,
// 서버가 의존관계로 유도한 영향 집합만 무효화한다(독립 분기 제외). 공개 경로(createAdmittedWorkflowRun
// → bindSeedInterpretedInputs → verifySeedEvidence)와 실제 DB+파일 fixture만 사용한다(모형 stub 없음).
// (a) 같은 토큰·같은 실제 값 → 재사용 승인 + 실제 해석값 바인딩·물화 재검증 통과
// (b) 같은 토큰, 생산자 실제 기록 교체(원본 산출물 보관 처리 + 동일 selector 신규 산출물) 또는 run metadata
//     실제 값 변경 → workflow_seed_interpreted_input_mismatch 거절 + 내구 run/seed 미생성
// (c) 영향 집합은 서버 계산(use 하류 publish 만), 독립 분기(solo)·변경 없는 생산자(write) 재사용 유지
import "./helpers/workflow-control-node-boundary.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueWorkProducts, issues, missions, workflowDefinitions, workflowRunSeeds, workflowRuns, workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { board } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { verifySeedEvidence } from "../services/workflow/workflow-seed-evidence.js";
import { workProductService } from "../services/work-products.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-seed-interpreted-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-seed-interpreted-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const selector = { type: "document" as const, title: "content.json" };
const stepsJson = (agentId: string) => [
  { id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
  { id: "use", name: "Use", type: "agent", agentId, dependencies: ["write"], workProductSelectors: { write: selector },
    toolArgs: { content: "{$steps.write.workProductPath}", label: "{$runMetadata.topic}" } },
  { id: "publish", name: "Publish", type: "agent", agentId, dependencies: ["use"], graphWorkProductRequired: true },
  { id: "solo", name: "Solo", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
];

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

async function seedInputWorld(db: Db, topic: string) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seed", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "operator", adapterType: "process" });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Seed", stepsJson: stepsJson(agentId) }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id,
    triggeredBy: "board", metadata: { topic } });
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
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board", metadata: { topic },
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

it("(a) 같은 토큰 설정·같은 실제 값이면 재사용이 승인되고 실제 해석값이 바인딩·재검증된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const target = await f.admit();
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seeds.map(s => s.targetStepId).sort()).toEqual(["publish", "solo", "use", "write"]);
  const useSeed = seeds.find(s => s.targetStepId === "use")!;
  expect(useSeed.evidence).toMatchObject({ schemaVersion: "workflow.seed.v1",
    interpretedInputs: { schemaVersion: "workflow.seed.interpreted-inputs.v1",
      references: [{ stepId: "write", workProductId: f.write.product.id, path: f.write.file }],
      metadataValues: { "runMetadata:topic": "alpha" } } });
  expect((useSeed.evidence as { interpretedInputs: { argsDigest: string } }).interpretedInputs.argsDigest).toMatch(/^[a-f0-9]{64}$/);
  for (const seed of seeds) await expect(verifySeedEvidence(db, seed)).resolves.toBeTruthy(); // 물화 재검증 통과
});

it("(b) 같은 토큰인데 생산자 실제 기록이 교체되면 구조적 사유로 거절되고 내구 상태가 남지 않는다", async () => {
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
  const changed = await createAdmittedWorkflowRun(db, { ...g.input, metadata: { topic: "beta" } }, board)
    .then(() => null, (error: unknown) => error);
  expect(String(changed)).toContain("workflow_seed_interpreted_input_mismatch");
});

it("(c) 영향은 선택적이다 — 교체 뒤에도 write·solo 재사용 승인은 유지된다", async () => {
  const f = await seedInputWorld(db, "alpha");
  const replacement = await replaceWriteProduct(f);
  const target = await f.admit(["write", "solo"]); // 영향받지 않은 재사용만 요청
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seeds.map(s => s.targetStepId).sort()).toEqual(["solo", "write"]);
  expect((seeds.find(s => s.targetStepId === "write")!.evidence as { products: Array<{ id: string }> }).products)
    .toEqual([expect.objectContaining({ id: replacement.id })]); // 검증된 현재 산출물로 승인(기록 위조 아님)
  for (const seed of seeds) await expect(verifySeedEvidence(db, seed)).resolves.toBeTruthy(); // 독립 분기 재검증 통과
});
