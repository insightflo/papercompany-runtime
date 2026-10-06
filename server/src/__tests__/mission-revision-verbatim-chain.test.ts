// [수정 재사용 원문 복사 — Task 1] 조인 체인(C1–C3): 구조화 제출 → 검증/PLAN-QA → 물화(A 원문 복사+B 저작)
//   → revision-start 후보 → 게시판 seed 승인 → 실행(A 재발사 없음, B 실제 소비).
//   검증은 실제 공개 경로와 실제 DB 기록만으로 한다(모의 물화기/검증기 없음).
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { heartbeatRuns, workflowDefinitions, workflowRunSeeds, workflowStepRuns, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { executeWorkflowRun, validateDag } from "../services/workflow/dag-engine.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { verbatimWorld } from "./helpers/revision-verbatim-world.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("rev-verbatim-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rev-verbatim-")));
  // 정의 생성 준비 검사가 executor 구성을 요구한다 — 실제 실행이 일어나면 크게 실패한다(슬라이스1 패턴).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in verbatim chain"); });
}, 60000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await temp?.cleanup();
  try { execFileSync("chmod", ["-R", "u+w", root]); } catch { /* best effort */ }
  await rm(root, { recursive: true, force: true });
});

type World = Awaited<ReturnType<typeof verbatimWorld>>;

async function paqoDefinitionSteps(w: World) {
  const [row] = await db.select().from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, w.companyId), eq(workflowDefinitions.missionId, w.revision.id),
      eq(workflowDefinitions.sourceKind, "paqo")))
    .limit(1);
  return { row: row!, steps: (row?.stepsJson ?? []) as Array<Record<string, unknown>> };
}

it("[joined chain] 복사 A 는 원문 그대로 물화되고 후보→승인→실행까지 이어진다", async () => {
  const w = await verbatimWorld(db, root);

  // C1: 제출 → 검증 통과 → PLAN-QA 대기(조기 invalid 아님).
  const first = await w.submit();
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);

  // C2: 재제출(판정 PASS 후 멱등 기록 경로) → 물화.
  const recorded = await w.submit();
  expect(recorded).toMatchObject({ status: "recorded" });

  const { row: paqoRow, steps } = await paqoDefinitionSteps(w);
  const sourceA1 = w.sourceSnapshot.find(s => s.id === "a1")!;
  const sourceA2 = w.sourceSnapshot.find(s => s.id === "a2")!;
  // A 원문 복사: 저장된 단계는 원본 스냅샷과 정확히 같고 sourceStepId 만 자기 ID 로 추가된다.
  //   (저장시점 정규화가 새 엣지를 A 에 추가했거나 구성을 바꿨다면 여기서 실패한다.)
  expect(steps.find(s => s.id === "a1")).toEqual({ ...sourceA1, sourceStepId: "a1" });
  expect(steps.find(s => s.id === "a2")).toEqual({ ...sourceA2, sourceStepId: "a2" });
  // 무이슈 native-tool A 에 허구 담당자가 발명되지 않았다.
  expect((steps.find(s => s.id === "a1")!.agentId as string) ?? "").toBe("");
  // 예약된 과거 QA ID 를 이어받은 새 QA 가 존재한다(중간=freshQA B, 최종=미션 최종 QA).
  const freshQa = steps.find(s => s.id === "qa-inter")!;
  expect(freshQa).toMatchObject({ type: "qa", qaType: "editorial", sourceStepId: "qa-inter" });
  expect(steps.find(s => s.id === "qa-final")).toMatchObject({ type: "qa" });
  expect(steps.find(s => s.id === "qa-final")!.sourceStepId).toBeUndefined(); // 최종 QA 는 새 실행(대응 없음)
  // B 는 생성 ID 를 쓰고 A 를 실제로 참조한다.
  const publish = steps.find(s => (s.toolNames as string[] | undefined)?.includes("rv-publish"))!;
  expect(publish.id).not.toBe("a2");
  expect(publish.dependencies).toEqual(expect.arrayContaining(["a2", "qa-inter"]));
  expect(publish.toolArgs).toEqual({ content: "{$steps.a2.workProductPath}" });
  // 저장 정의는 유효 DAG 이다.
  expect(validateDag(steps as never).valid).toBe(true);
  // 원본 정의는 결코 수정되지 않았다.
  const [sourceRow] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, w.definition.id)).limit(1);
  expect((sourceRow!.stepsJson as unknown[]).length).toBe(w.sourceSnapshot.length);

  // C3: 후보 → 승인 → 실행.
  const options = await revisionStartOptions(db, w.companyId, w.revision.id);
  expect(options).not.toBeNull();
  expect((options!.candidates as Array<{ stepId: string; sourceStepId: string }>).map(c => c.stepId).sort())
    .toEqual(["a1", "a2"]);

  const target = await createAdmittedWorkflowRun(db, { companyId: w.companyId, workflowId: paqoRow.id,
    missionId: w.revision.id, triggeredBy: "board",
    seedFromRun: { sourceWorkflowRunId: w.sourceRun.id, stepIds: [...w.admitStepIds] } }, w.board);

  await executeWorkflowRun(db, target.id);

  // A: seed 물화 — 완료 + 이슈 없음 + seed 행 + 새 하트비트 없음.
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const a1Row = rows.find(r => r.stepId === "a1");
  const a2Row = rows.find(r => r.stepId === "a2");
  expect(a1Row).toMatchObject({ status: "completed", issueId: null });
  expect(a2Row).toMatchObject({ status: "completed", issueId: null });
  const seeds = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  expect(seeds.map(s => s.sourceStepId).sort()).toEqual(["a1", "a2"]);
  expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, w.companyId),
    eq(heartbeatRuns.workflowStepRunId, a1Row!.id)))).toEqual([]);
  expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, w.companyId),
    eq(heartbeatRuns.workflowStepRunId, a2Row!.id)))).toEqual([]);

  // B: 발사(중간 freshQA 실행 중) — 과거 QA 결과/seed 는 없다.
  // B: 중간 freshQA 는 이번 실행 이슈로 발사되었다(과거 QA 결과/seed 는 없다).
  const freshQaRow = rows.find(r => r.stepId === "qa-inter");
  expect(freshQaRow?.issueId).toBeTruthy();
  expect(seeds.some(s => s.sourceStepId === "qa-inter")).toBe(false);

  // B 소비 결합: publish 인자의 {$steps.a2.workProductPath} 가 승인된 A 산출물로 실제 해석된다.
  const publishStep = (paqoRow.stepsJson as Array<Record<string, unknown>>).find(s => s.id === publish.id)!;
  const publishRow = rows.find(r => r.stepId === publish.id);
  const args = await resolveWorkflowToolStepArgs({ db, run: { ...target, companyId: w.companyId } as never,
    step: publishStep as never, workflowSteps: paqoRow.stepsJson as never, consumerStepRunId: publishRow!.id });
  expect((args as Record<string, unknown>).content).toBe(w.a2File.target);

  // 활성 계획 refs 에 기계 지도(roots/클로저/원본 실행)가 보존된다.
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.revision.id });
  expect((plan!.refs as Record<string, unknown>).revisionReusePlan).toMatchObject({
    schemaVersion: "mission-revision-reuse.v1", sourceWorkflowRunId: w.sourceRun.id,
    roots: ["a2"], closureUnitIds: ["a1", "a2"],
  });
}, 120000);
