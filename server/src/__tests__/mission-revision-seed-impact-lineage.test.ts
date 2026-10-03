// server/src/__tests__/mission-revision-seed-impact-lineage.test.ts
//
// [수정 변경맵 — TEST-FIRST RED] native seed 의 (1) 실행 지시 변경 무효화(R1/Q9 전제), (2) 반복 개정
// lineage(Q9). 공개 경로(createAdmittedWorkflowRun → executeWorkflowRun → selectOfficialWorkProduct /
// resolveWorkflowToolStepArgs)와 실제 DB+파일 fixture(helpers/workflow-seed-world.ts · admitted-producer.ts)
// 만 사용하고 이번 패치에는 product 코드 변경이 없다.
//
// RED-1) 원본 producer 가 실행 지시(description)를 갖고 완료된 경우, 대상 정의가 같은 tools/
//   dependencies 로 지시(description)만 바꾸면 그 producer 의 기존 출력 seed 승인은 거부되어야 하고
//   거부 후 내구 run/seed 가 남지 않는다. description 은 실제 dispatch 입력이다(dag-engine 이
//   step.description 을 렌더해 dispatch issue description 으로 주입). 현재 revision-step-config.ts 가
//   seed hash 계산에서 description 을 제외해 승인이 통과한다. 단순 hash 불일치 비교가 아니라 실제
//   공개 승인 경로의 거부로 증명한다. prose 는 입력 bytes 로만 취급하고 제어 판정으로 파싱하지
//   않는다(규칙 8). 대조: interpretedInputs(구조화 기계 입력) 변경은 이미 거부된다. 지시 bytes 불변
//   renamed(sourceStepId mapping) 재사용은 계속 승인되어 원본 product/lineage 를 실제 소비자가 해석한다.
//
// RED-2) 1차 개정 run 이 원본 producer 를 seed 하면 그 write 스텝은 설계상 completed + issueId:null 로
//   물화된다(workflow-run-seeds.test.ts 녹색 경로). 2차 개정 미션이 그 1차 run 을 source 로 지정하고
//   명시 sourceStepId mapping 으로 seed 승인하면 실제 소비자 selector/toolArgs 는 원본 producer lineage
//   (원본 source run)와 원본 hash 의 검증 파일을 해석해야 한다(복사 영수증·phantom issue·최신 output·
//   원본 기록 위조 불가). 현재 workflow-seed-admission.ts 가 issueId 없는 completed source step 을
//   workflow_seed_source_incomplete 로 거부해 2차 seed 승인 자체가 불가능하다. 이것은 Q11 전체(서버
//   도출 impact·독립 분기·backedge 안전)가 아니라 그 전제인 native 자격/Q9 lineage 증명이다.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issues, missions, workflowDefinitions, workflowRunSeeds, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-seed-lineage-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-seed-lineage-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const ORIGINAL_INSTRUCTION = "원본 작성 지시: 뉴스레터 초안을 한국어로 작성한다";
const ORIGINAL_BYTES = '{"blocks":[]}'; // helpers/workflow-seed-world.ts 가 기록하는 원본 산출물 bytes
const documentSelector = { type: "document" as const, title: "content.json" };
type DeltaStep = { id: string; sourceStepId?: string; name: string; type: string; agentId: string; dependencies: string[];
  graphWorkProductRequired?: boolean; description?: string; interpretedInputs?: Record<string, unknown>;
  workProductSelectors?: Record<string, typeof documentSelector>; toolArgs?: Record<string, string> };

// 원본 producer 스텝이 실제 실행 지시(description)를 갖는 원본 그래프(seedWorld 기본형과 동일 구조).
const instructedSteps = (agentId: string, description: string): DeltaStep[] => [
  { id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true, description },
  { id: "use", name: "Use", type: "agent", agentId, dependencies: ["write"], workProductSelectors: { write: documentSelector },
    toolArgs: { content: "{$steps.write.workProductPath}" } },
];
// 구조화 기계 입력(interpretedInputs)을 갖는 원본 그래프(지시 문구 없음 — 입력 형태 대조용).
const inputBackedSteps = (agentId: string, interpretedInputs: Record<string, unknown>): DeltaStep[] => [
  { id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true, interpretedInputs },
  { id: "use", name: "Use", type: "agent", agentId, dependencies: ["write"], workProductSelectors: { write: documentSelector },
    toolArgs: { content: "{$steps.write.workProductPath}" } },
];
// 개정 대상 그래프: 명시 sourceStepId mapping 으로 식별자만 바꾼 동일 설정.
const renamedSteps = (agentId: string, description?: string): DeltaStep[] => [
  { id: "write2", sourceStepId: "write", name: "Write v2", type: "agent", agentId, dependencies: [],
    graphWorkProductRequired: true, ...(description === undefined ? {} : { description }) },
  { id: "use2", sourceStepId: "use", name: "Use v2", type: "agent", agentId, dependencies: ["write2"],
    workProductSelectors: { write2: documentSelector }, toolArgs: { content: "{$steps.write2.workProductPath}" } },
];

it("[RED-1] 실행 지시(description)만 바뀐 대상 정의는 seed 승인이 거부되고 내구 run/seed 가 남지 않는다", async () => {
  const f = await seedWorld(db, root, mission => instructedSteps(mission.ownerAgentId!, ORIGINAL_INSTRUCTION));
  // 원본 run 스냅샷은 동결 — 새로 만들 대상 run 스냅샷만 현재 정의(수정 지시, 같은 tools/dependencies)를 본다.
  await db.update(workflowDefinitions)
    .set({ stepsJson: instructedSteps(f.agentId, "수정 지시: 요약 뉴스레터로 재작성한다") })
    .where(eq(workflowDefinitions.id, f.definition.id));
  const failure = await f.admit().then(() => null, (error: unknown) => error);
  expect(failure, "변경된 실행 지시는 그 producer 의 seed 재사용 승인을 무효화해야 한다").toBeTruthy();
  expect(String(failure)).toContain("workflow_seed"); // 실제 공개 승인 거부(단순 hash 비교가 아님)
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, f.companyId))).toEqual([]);
});

it("[대조] interpretedInputs 변경은 거부하고, 지시 불변 renamed mapping 재사용은 원본 출력을 소비한다", async () => {
  const a = await seedWorld(db, root, mission => inputBackedSteps(mission.ownerAgentId!, { tone: "neutral" }));
  await db.update(workflowDefinitions).set({ stepsJson: inputBackedSteps(a.agentId, { tone: "concise" }) })
    .where(eq(workflowDefinitions.id, a.definition.id));
  await expect(a.admit()).rejects.toThrow("workflow_seed_incompatible_definition"); // 기계 입력 변경은 이미 무효화됨
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, a.revision.id))).toEqual([]);
  const b = await seedWorld(db, root, mission => instructedSteps(mission.ownerAgentId!, ORIGINAL_INSTRUCTION));
  const steps = renamedSteps(b.agentId, ORIGINAL_INSTRUCTION); // 지시 bytes 불변 — 식별자 mapping 만 변경
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, b.definition.id));
  b.input.seedFromRun.stepIds = ["write2"];
  const target = await b.admit();
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write2")).toMatchObject({ status: "completed", issueId: null }); // 재사용 승인 경로 유지
  const selected = await selectOfficialWorkProduct(db, { companyId: b.companyId, workflowRunId: target.id,
    stepId: "write2", selector: documentSelector });
  expect(selected.product.id).toBe(b.product.id); // 원본 product
  expect(selected.producer.workflowRunId).toBe(b.sourceRun.id); // 원본 producer lineage
  const use2 = rows.find(s => s.stepId === "use2")!;
  expect(await resolveWorkflowToolStepArgs({ db, run: target, step: steps[1], workflowSteps: steps, consumerStepRunId: use2.id }))
    .toEqual({ content: b.file }); // 실제 소비자 해석 = 원본 검증 파일
});

it("[RED-2] 1차 개정 run 의 seed 물화 producer(issueId:null)를 2차 개정이 다시 seed 하면 원본 lineage/hash 로 소비된다", async () => {
  const f = await seedWorld(db, root); // 기본 그래프(write/use) — 1차 개정은 기존 녹색 경로
  const first = await f.admit();
  await executeWorkflowRun(db, first.id);
  const seededWrite = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, first.id)))
    .find(s => s.stepId === "write")!;
  expect(seededWrite).toMatchObject({ status: "completed", issueId: null }); // 전제(현재 녹색): 설계상 정상 물화
  await db.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, first.id));
  const [second] = await db.insert(missions).values({ companyId: f.companyId, ownerAgentId: f.agentId, title: "Revision 2",
    status: "active", sourceMissionId: f.revision.id, sourceWorkflowRunId: first.id }).returning();
  const steps = renamedSteps(f.agentId); // 명시 sourceStepId mapping(write2→write, use2→use)
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, f.definition.id));
  const secondAdmit = () => createAdmittedWorkflowRun(db, { companyId: f.companyId, workflowId: f.definition.id,
    missionId: second.id, triggeredBy: "board", seedFromRun: { sourceWorkflowRunId: first.id, stepIds: ["write2"] } }, board);
  // [RED] 현재: completed + issueId:null 인 source step → workflow_seed_source_incomplete 거부.
  const target = await secondAdmit().catch((error: unknown) => {
    throw new Error(`2차 개정 seed 승인이 거부되었다(성공해야 함): ${String(error)}`);
  });
  const [seed2] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seed2).toMatchObject({ sourceRunId: first.id, sourceStepRunId: seededWrite.id, sourceStepId: "write", // 승인 즉시 source 는 1차 run
    targetStepId: "write2", approvedByUserId: "local-board" }); // 내구 승인 증거
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write2")).toMatchObject({ status: "completed", issueId: null }); // phantom issue 없음
  const use2 = rows.find(s => s.stepId === "use2")!;
  expect(use2.issueId).toBeTruthy(); // 소비자는 실제 dispatch
  const [use2Issue] = await db.select().from(issues).where(eq(issues.id, use2.issueId!));
  expect(use2Issue.description).toContain(f.file); // 원본 검증 파일이 실제 소비 입력으로 전달
  const selected = await selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id,
    stepId: "write2", selector: documentSelector });
  expect(selected.product.id).toBe(f.product.id); // 원본 product — 복사 영수증/최신 output 아님
  expect(selected.producer.workflowRunId).toBe(f.sourceRun.id); // 원본 producer lineage(1차 run 이 아님)
  expect(selected.product.metadata?.sha256).toBe(createHash("sha256").update(ORIGINAL_BYTES).digest("hex")); // 원본 hash
  expect(await resolveWorkflowToolStepArgs({ db, run: target, step: steps[1], workflowSteps: steps, consumerStepRunId: use2.id }))
    .toEqual({ content: f.file });
  const [sourceStepNow] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.sourceStep.id));
  expect(sourceStepNow).toMatchObject({ status: "completed", issueId: f.sourceStep.issueId }); // 원본 기록은 fresh producer 로 위조되지 않음
});
