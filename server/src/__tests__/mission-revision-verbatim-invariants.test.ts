// [수정 재사용 원문 복사 — Task 3 부분집합] 불변식 검증:
//   (1) 타회사/알 수 없는 원본 실행 거부, (2) 위조/미지 복사 투영 거부(신원 전용 위반·스냅샷 부재·미완료),
//   (3) 변경된 단위에 마커를 쓰면 복사되지 않는다(modify 는 B), (4) 변경된 B 는 후보에서 제외,
//   (5) 마커 없는 일반 계획은 기존 동작 그대로(복사 없음·refs 에 재사용 지도 없음),
//   (6) seed 입장 강화 없음(산출물 bytes 변조 여전히 거부 — 입장/해시 구현은 무변).
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowStepRuns, createDb } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { verbatimWorld } from "./helpers/revision-verbatim-world.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("rev-verbatim-inv-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rev-verbatim-inv-")));
  // 정의 생성 준비 검사가 executor 구성을 요구한다(실제 실행이 일어나면 크게 실패 — 슬라이스1 패턴).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in verbatim invariants"); });
}, 60000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await temp?.cleanup();
  try { execFileSync("chmod", ["-R", "u+w", root]); } catch { /* best effort */ }
  await rm(root, { recursive: true, force: true });
});

type World = Awaited<ReturnType<typeof verbatimWorld>>;
const diagnostics = (result: Record<string, unknown>) =>
  (Array.isArray(result.diagnostics) ? result.diagnostics : []) as Array<{ code: string; message: string }>;

async function paqoSteps(w: World) {
  const [row] = await db.select().from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, w.companyId), eq(workflowDefinitions.missionId, w.revision.id),
      eq(workflowDefinitions.sourceKind, "paqo"))).limit(1);
  return (row?.stepsJson ?? []) as Array<Record<string, unknown>>;
}

it("[외부 출처] 타회사 원본 실행을 재사용 출처로 주장하면 구조화 거부된다", async () => {
  const w = await verbatimWorld(db, root);
  const foreign = await seedWorld(db, path.join(root, "foreign")); // 다른 회사의 실제 실행
  const result = await w.submit(w.decision(w.authoredUnits(), {
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: foreign.sourceRun.id,
    base: { workflowDefinitionId: w.definition.id, snapshotHash: w.snapshotHash },
    units: w.deltaUnits(),
  }));
  expect(result).toMatchObject({ status: "invalid" });
  expect(diagnostics(result).some(d => d.code === "mission_revision_reuse_invalid")).toBe(true);
  // 이 미션에는 아무 PLAN-QA/정의 물화도 일어나지 않는다(부분 재사용 없음).
  expect(await paqoSteps(w)).toEqual([]);
}, 60000);

it("[위조/미지 투영] 저작 구성을 실은 A 항목·스냅샷에 없는 루트·미완료 루트는 모두 거부된다", async () => {
  const w = await verbatimWorld(db, root);
  // (a) A 항목에 에이전트가 toolArgs 를 실으면(위조 투영 시도) 신원 전용 위반.
  const forged = await w.submit(w.decision([
    { id: "a2", sourceStepId: "a2", toolArgs: { content: "tampered" } },
    ...w.authoredUnits().slice(1),
  ]));
  expect(forged).toMatchObject({ status: "invalid", reason: "mission_revision_reuse_invalid" });
  expect(diagnostics(forged)[0]!.message).toContain("신원");

  // (b) 원본 스냅샷에 없는 단계를 재사용 루트로 주장하면 거부.
  const unknown = await w.submit(w.decision(w.authoredUnits().map(u => u.id === "a2" ? { id: "a2", sourceStepId: "a2" } : u),
    { schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w.sourceRun.id,
      base: { workflowDefinitionId: w.definition.id, snapshotHash: w.snapshotHash },
      units: [{ unitId: "no-such-step", operation: "reuse", sourceStepId: "no-such-step" }, ...w.deltaUnits().slice(1)] }));
  expect(unknown).toMatchObject({ status: "invalid" });
  expect(diagnostics(unknown).some(d => d.code === "mission_revision_reuse_invalid")).toBe(true);

  // (c) 원본 실행에서 완료되지 않은 QA 단계는 복사할 수 없다(성공 단계만).
  const incomplete = await w.submit(w.decision(
    [...w.authoredUnits().slice(2), { id: "qa-inter", sourceStepId: "qa-inter" }],
    { schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w.sourceRun.id,
      base: { workflowDefinitionId: w.definition.id, snapshotHash: w.snapshotHash },
      units: w.deltaUnits().map(u => u.unitId === "a2" ? { unitId: "qa-inter", operation: "reuse", sourceStepId: "qa-inter" } : u) }));
  expect(incomplete).toMatchObject({ status: "invalid" });
  expect(diagnostics(incomplete).some(d => d.code === "mission_revision_reuse_source_incomplete"
    || d.code === "mission_revision_reuse_unsupported_step")).toBe(true);
  expect(await paqoSteps(w)).toEqual([]);
}, 60000);

it("[변경 단위] modify 로 제출된 단위는 복사되지 않고 후보에도 없다(변경 B 는 신규 실행)", async () => {
  const w = await verbatimWorld(db, root);
  const changedUnits = [
    ...w.authoredUnits().slice(1),
    { id: "a2", title: "Write report (changed)", selectionState: "selected", reason: "changed body",
      assigneeAgentId: w.agentId, sourceRef: { type: "mission_plan_unit", id: "a2" },
      sourceStepId: "a2", dependencies: [], instructions: "요약 톤을 간결하게" },
  ];
  const decision = w.decision(changedUnits, {
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w.sourceRun.id,
    base: { workflowDefinitionId: w.definition.id, snapshotHash: w.snapshotHash },
    units: [
      { unitId: "a2", operation: "modify", sourceStepId: "a2", instructions: "요약 톤을 간결하게" },
      ...w.deltaUnits().slice(1),
    ],
  });
  const first = await w.submit(decision);
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit(decision)).toMatchObject({ status: "recorded" });
  const steps = await paqoSteps(w);
  // 복사 없음: a1/a2 원본 ID 를 가진 단계가 물화되지 않았다(변경/미표시 단위는 재저작).
  expect(steps.find(s => s.id === "a1")).toBeUndefined();
  expect(steps.find(s => s.id === "a2")).toBeUndefined();
  expect(steps.find(s => (s.sourceStepId as string | undefined) === "a2")).toBeTruthy(); // 대응은 유지
  // 후보도 비어 있다 — 마커가 없으면 어떤 단계도 복사 후보가 아니다.
  const options = await revisionStartOptions(db, w.companyId, w.revision.id);
  expect((options?.candidates as unknown[] | undefined) ?? []).toEqual([]);
}, 60000);

it("[일반 계획] 마커 없는 제출(변경안 없음·재사용 없는 변경안)은 기존 동작 그대로다", async () => {
  const w = await verbatimWorld(db, root);
  // (a) 변경안 없는 일반 제출(B 만 있는 자립 계획 — 마커/A 참조 없음).
  const plainUnits = [
    { ...w.authoredUnits()[1]!, dependencies: [] },
    { ...w.authoredUnits()[2]!, dependencies: ["qa-inter"], workProductSelectors: undefined, toolArgs: undefined },
    { ...w.authoredUnits()[3]! },
  ];
  const plain = w.decision(plainUnits, null);
  const first = await w.submit(plain);
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit(plain)).toMatchObject({ status: "recorded" });
  const steps = await paqoSteps(w);
  expect(steps.find(s => s.id === "a1")).toBeUndefined();
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.revision.id });
  expect((plan!.refs as Record<string, unknown>).revisionReusePlan).toBeUndefined();

  // (b) 재사용 단위가 없는 변경안(rerun/add 만)도 복사 없이 기존 경로.
  const w2 = await verbatimWorld(db, root);
  const authoredA2 = { id: "a2", title: "Write report", selectionState: "selected", reason: "rerun body",
    assigneeAgentId: w2.agentId, sourceRef: { type: "mission_plan_unit", id: "a2" },
    sourceStepId: "a2", dependencies: [], graphWorkProductRequired: true };
  const noReuse = w2.decision([
    { ...w2.authoredUnits()[1]!, dependencies: ["a2"] },
    { ...w2.authoredUnits()[2]!, dependencies: ["qa-inter", "a2"], workProductSelectors: undefined },
    { ...w2.authoredUnits()[3]! },
    authoredA2,
  ], {
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w2.sourceRun.id,
    base: { workflowDefinitionId: w2.definition.id, snapshotHash: w2.snapshotHash },
    units: [
      { unitId: "a2", operation: "rerun", sourceStepId: "a2" },
      ...w2.deltaUnits().slice(1),
    ],
  });
  const first2 = await w2.submit(noReuse);
  expect(first2).toMatchObject({ status: "plan_qa_pending" });
  await w2.approve(first2);
  expect(await w2.submit(noReuse)).toMatchObject({ status: "recorded" });
  expect((await paqoSteps(w2)).find(s => s.id === "a1")).toBeUndefined();
}, 60000);

it("[입장 무변] 복사 A 라도 산출물 bytes 변조 후 입장은 여전히 거부된다(완화 없음)", async () => {
  const w = await verbatimWorld(db, root);
  const first = await w.submit();
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit()).toMatchObject({ status: "recorded" });
  const [paqoDef] = await db.select().from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, w.companyId), eq(workflowDefinitions.missionId, w.revision.id),
      eq(workflowDefinitions.sourceKind, "paqo"))).limit(1);
  // 승인 후 원본 a1 산출물 bytes 변조 — 입장 재검(생산 시점 digest 대조)이 거부해야 한다.
  await writeFile(w.a1File.target, '{"sources":["tampered"]}');
  await expect(createAdmittedWorkflowRun(db, { companyId: w.companyId, workflowId: paqoDef!.id,
    missionId: w.revision.id, triggeredBy: "board",
    seedFromRun: { sourceWorkflowRunId: w.sourceRun.id, stepIds: [...w.admitStepIds] } }, w.board))
    .rejects.toThrow(/workflow_seed_/);
  // 거부는 부분 실행을 남기지 않는다(트랜잭션 롤백 — 이 미션에 새 run/스텝런 없음).
  const { workflowRuns } = await import("@paperclipai/db");
  const newRuns = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, w.companyId), eq(workflowRuns.missionId, w.revision.id)));
  expect(newRuns).toEqual([]);
}, 60000);

it("[변경 B 보호] 암묵적 조상을 modify 로 저작한 제출은 최초 단계에서 거부된다(조용한 원문 복사 없음)", async () => {
  const w = await verbatimWorld(db, root);
  // a2 만 reuse 로 표시 → a1 은 클로저로 서버가 복사한다. 그 a1 을 modify 로 저작하면 충돌.
  const authored = [
    { id: "a1", title: "Collect sources (changed)", selectionState: "selected", reason: "changed collection",
      assigneeAgentId: w.agentId, sourceRef: { type: "mission_plan_unit", id: "a1" },
      sourceStepId: "a1", dependencies: [], instructions: "수집 대상 변경", toolNames: ["rv-collect"] },
    { id: "a2", sourceStepId: "a2" },
    ...w.authoredUnits().slice(1),
  ];
  const decision = w.decision(authored, {
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w.sourceRun.id,
    base: { workflowDefinitionId: w.definition.id, snapshotHash: w.snapshotHash },
    units: [
      { unitId: "a1", operation: "modify", sourceStepId: "a1", instructions: "수집 대상 변경" },
      { unitId: "a2", operation: "reuse", sourceStepId: "a2" },
      ...w.deltaUnits().slice(1),
    ],
  });
  const result = await w.submit(decision);
  expect(result).toMatchObject({ status: "invalid" });
  expect(diagnostics(result).some(d => d.code === "mission_revision_reuse_dependency_invalid")).toBe(true);
  // 거부는 물화를 만들지 않는다 — 변경한 B 가 원본 재사용으로 조용히 바뀌는 경로가 없다.
  expect(await paqoSteps(w)).toEqual([]);
}, 60000);
