// server/src/__tests__/workflow-seed-tool-output.test.ts
//
// [수정 변경맵 — TEST-FIRST RED→GREEN] native tool step 산출물의 seed 재사용(Q1/Q8/Q9 전제).
// agent action 산출물로 한정되던 seed 승인/검증/소비를 issue 없는 tool 스텝의 기록된
// artifact(toolResult)로 확장한다. 실제 공개 경로(createAdmittedWorkflowRun → executeWorkflowRun
// → resolveWorkflowToolStepArgs / dependencyToolEvidence / readSeededToolArtifact)와 실제 DB+파일
// fixture 만 사용한다(소스 문자열 검사 아님).
//
// GREEN-1) 동일 실행(run)에서 완료된 native tool 스텝의 기록 artifact 는 bytes/SHA·회사/시도 스코프
//   검증을 거쳐 seed evidence 로 승인되고, 대상 run 에 물화(completed+issueId:null)되어 소비자
//   toolArgs/dispatch 표현이 원본 검증 파일 경로를 해석한다(복사 영수증·최신 output 아님).
// RED-2) 기록 훼손(승인 거절) / 파일 유실 / 회사 불일치 / stale attempt 가 각각 구조화 이유로
//   보수적 거절되고 부분 재사용이 남지 않는다.
// 대조-3) agent action seed 경로는 그대로 동작한다(회귀 방지).
import "./helpers/workflow-control-node-boundary.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, missions, workflowDefinitions, workflowRunSeeds, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { executeWorkflowRun, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { dependencyToolEvidence } from "../services/workflow/dependency-tool-evidence.js";
import { parseToolSeedEvidence, readSeededToolArtifact } from "../services/workflow/workflow-seed-tool-output.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("seed-tool-output-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "seed-tool-output-")));
  setWorkflowToolStepExecutor(async () => ({ accepted: true })); // 엔진 tool 준비성 게이트 통과용 test double
}, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type ToolStep = { id: string; sourceStepId?: string; name: string; type: string; agentId: string;
  dependencies: string[]; toolNames?: string[]; toolArgs?: Record<string, string> };
const toolSteps = (agentId: string): ToolStep[] => [
  { id: "render", name: "Render", type: "tool", agentId: "", toolNames: ["render-tool"], dependencies: [] },
  { id: "use", name: "Use", type: "agent", agentId, dependencies: ["render"], toolArgs: { content: "{$steps.render.workProductPath}" } },
];
const renamedToolSteps = (agentId: string): ToolStep[] => [
  { id: "render2", sourceStepId: "render", name: "Render v2", type: "tool", agentId: "", toolNames: ["render-tool"], dependencies: [] },
  { id: "use2", sourceStepId: "use", name: "Use v2", type: "agent", agentId, dependencies: ["render2"], toolArgs: { content: "{$steps.render2.workProductPath}" } },
];

// seedWorld 과 동일 구조이되 producer 가 issue 없는 native tool 스텝: 완료 기록은 metadata.toolResult
// (성공+절대 artifactPath+현재 requestId)이고 산출물은 회사 미션 출력 루트 아래 파일이다.
async function toolWorld(toolResult?: Record<string, unknown>) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seed", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Renderer", role: "operator", adapterType: "process" });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Seed", stepsJson: toolSteps(agentId) }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id, triggeredBy: "board" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const requestId = randomUUID();
  const [renderStep] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "render",
    issueId: null, status: "running", startedAt: new Date(), lastDispatchRequestId: requestId }).returning();
  const dir = path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "render");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "result.json"), bytes = Buffer.from('{"rendered":true}');
  await writeFile(file, bytes);
  const recorded = toolResult === undefined
    ? { requestId, toolName: "render-tool", success: true, artifactPath: file, stdout: null, stderr: null,
      exitCode: 0, error: null, completedAt: new Date().toISOString() }
    : toolResult;
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(),
    metadata: { toolResult: recorded } }).where(eq(workflowStepRuns.id, renderStep.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const steps = renamedToolSteps(agentId);
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition.id));
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board" as const,
    seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["render2"] } };
  return { companyId, agentId, sourceRun, renderStep, revision, steps, input,
    admit: () => createAdmittedWorkflowRun(db, input, board), file, bytes };
}
const readToolSeed = (f: { companyId: string }, runId: string) =>
  readSeededToolArtifact(db, { companyId: f.companyId, workflowRunId: runId, stepId: "render2" });

it("[GREEN-1] 동일 실행 native tool 산출물 seed 는 승인·물화되어 원본 검증 파일로 소비된다", async () => {
  const f = await toolWorld();
  const target = await f.admit();
  const [seed] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seed).toMatchObject({ companyId: f.companyId, sourceRunId: f.sourceRun.id, sourceStepRunId: f.renderStep.id,
    sourceStepId: "render", targetStepId: "render2", approvedByUserId: "local-board" }); // 내구 승인 증거
  expect(parseToolSeedEvidence(seed.evidence)?.artifact).toMatchObject({ stepRunId: f.renderStep.id, path: f.file,
    sha256: sha(f.bytes), byteSize: f.bytes.length, executionGeneration: 0, retryCount: 0, iterationIndex: 0 });
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const render2 = rows.find(s => s.stepId === "render2")!;
  expect(render2).toMatchObject({ status: "completed", issueId: null }); // phantom issue 없는 물화
  const use2 = rows.find(s => s.stepId === "use2")!;
  expect(use2.issueId).toBeTruthy(); // 소비자는 실제 dispatch
  const [use2Issue] = await db.select().from(issues).where(eq(issues.id, use2.issueId!));
  expect(use2Issue.description).toContain(f.file); // dispatch 표현도 검증된 원본 경로
  expect(await resolveWorkflowToolStepArgs({ db, run: target, step: f.steps[1], workflowSteps: f.steps, consumerStepRunId: use2.id }))
    .toEqual({ content: f.file }); // 실제 소비자 해석 = 원본 검증 파일(복사/최신 output 아님)
  expect(await dependencyToolEvidence(db, { companyId: f.companyId, runId: target.id, stepIds: ["render2"] }))
    .toEqual([{ type: "dependency_tool_artifact", id: render2.id, path: f.file,
      description: "Board-approved tool artifact for step render2" }]);
});

it("[RED-2a] 훼손된 기록은 승인 단계에서 구조화 이유로 거절되고 seed/run 이 남지 않는다", async () => {
  const failed = await toolWorld({ requestId: "dispatched", toolName: "render-tool", success: false }); // 성공 기록 아님
  await expect(failed.admit()).rejects.toThrow("workflow_seed_tool_output_record_missing");
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, failed.companyId))).toEqual([]);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, failed.revision.id))).toEqual([]);
  const pathless = await toolWorld({ requestId: "dispatched", success: true }); // 절대 artifactPath 부재
  await expect(pathless.admit()).rejects.toThrow("workflow_seed_tool_output_record_invalid");
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, pathless.companyId))).toEqual([]);
});

it("[RED-2b] 승인 후 원본 파일이 유실되면 소비가 구조화 이유로 거절되고 부분 재사용이 없다", async () => {
  // 물화 전 유실: 엔진 초기화 재검증이 구조화 이유로 거절하고 스텝 삽입도 롤백된다.
  const f = await toolWorld();
  const target = await f.admit();
  await rm(f.file);
  await expect(executeWorkflowRun(db, target.id)).rejects.toThrow("workflow_seed_artifact_unreadable");
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id)))
    .find(s => s.stepId === "render2" && s.status === "completed")).toBeUndefined(); // 부분 물화 없음
  // 물화 후 유실: 소비자 읽기는 물화 행을 신뢰하지 않고 매번 원본 바이트를 재검증한다.
  const consumed = await toolWorld();
  const consumedTarget = await consumed.admit();
  await executeWorkflowRun(db, consumedTarget.id); // 원본이 살아있을 때 정상 물화+소비
  await rm(consumed.file);
  await expect(readToolSeed(consumed, consumedTarget.id)).rejects.toThrow("workflow_seed_artifact_unreadable");
});

it("[RED-2c] 회사/실행 스코프 불일치와 stale attempt 는 구조화 이유로 거절된다", async () => {
  // 회사 불일치: 승인 증거가 다른 회사 run 의 step run 을 가리키면 same-run/회사 스코프가 어긋난다.
  // 소비자 읽기는 물화된 대상 스텝 행을 먼저 확인하므로 정상 물화 후에 증거를 훼손한다.
  const other = await toolWorld();
  const f = await toolWorld();
  const target = await f.admit();
  await executeWorkflowRun(db, target.id); // 원본이 살아있을 때 정상 물화+소비
  const [seed] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  const evidence = parseToolSeedEvidence(seed.evidence)!;
  await db.update(workflowRunSeeds).set({ evidence: { ...evidence, artifact: { ...evidence.artifact, stepRunId: other.renderStep.id } } })
    .where(eq(workflowRunSeeds.id, seed.id));
  await expect(readToolSeed(f, target.id)).rejects.toThrow("workflow_seed_tool_output_scope_mismatch");
  // stale attempt: 원본 step 의 재시도 카운터가 오르면 기록된 시도가 현재 시도가 아니다.
  const stale = await toolWorld();
  const staleTarget = await stale.admit();
  await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, stale.renderStep.id));
  await expect(executeWorkflowRun(db, staleTarget.id)).rejects.toThrow("workflow_seed_source_attempt_changed");
  expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, staleTarget.id)))
    .filter(s => s.status === "completed")).toEqual([]); // 부분 재사용 없음
  // 물화된 seed 도 원본 재시도 상승 즉시 권한을 잃는다(소비자 재검증, 복사본 대체 없음).
  const staleConsumed = await toolWorld();
  const staleConsumedTarget = await staleConsumed.admit();
  await executeWorkflowRun(db, staleConsumedTarget.id);
  await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, staleConsumed.renderStep.id));
  await expect(readToolSeed(staleConsumed, staleConsumedTarget.id)).rejects.toThrow("workflow_seed_source_attempt_changed");
});

it("[대조-3] agent action seed 경로는 그대로 승인·물화·소비된다", async () => {
  const f = await seedWorld(db, root);
  const target = await f.admit();
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write")).toMatchObject({ status: "completed", issueId: null });
  const selected = await selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id,
    stepId: "write", selector: { type: "document", title: "content.json" } });
  expect(selected.product.id).toBe(f.product.id); // 원본 product
  expect(selected.producer.workflowRunId).toBe(f.sourceRun.id); // 원본 producer lineage
});
