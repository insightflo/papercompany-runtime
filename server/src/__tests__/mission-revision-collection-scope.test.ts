// server/src/__tests__/mission-revision-collection-scope.test.ts
//
// [슬라이스 Q5 — 수집 대상 추가의 일회/영구 구분] 변경지도 Q5: 수집 대상 추가를 이번 실행 1회 수집
//   (collectionScope:"oneShot" 또는 미지정) 과 정기 정의 영구 변경 요구(collectionScope:"permanentChange")
//   로 구분한다. 판정 근거는 문구가 아니라 record 결과·활성 plan refs(revisionSeparateScopeRequests)·
//   물화 정의·정기(기준) 템플릿 정의 행이다.
//   (a) 지원 도구 + oneShot 새 URL → 새 입력 단계가 이 수정 실행 정의에만 물화되고, 정기 정의(기준
//       템플릿 행 bytes·스냅샷 해시)와 정기 수집 상태 토큰(워터마크)은 불변이며 1회 수집 인자에 정기
//       상태 토큰이 묻어 들어가지 않는다.
//   (b) 미지원 수집원 → Q4 기계를 그대로 재사용해 구조화 기능 부족 결과(mission_revision_capability_gap,
//       실제 toolNames 지침)로 남고 해당 도구 물화·실행 기록 0건.
//   (c) permanentChange 요구 → 별도 범위 구조화 결과(mission_revision_permanent_change_separate_scope)로
//       만 남고 정기 정의·워터마크는 그대로이며 조용한 영구 적용·물화가 없다(별도 범위 단위는 배치
//       검사에서도 제외되어 미등록 도구로도 독립 작업을 막지 않는다). (c2) 진행 단위가 별도 범위 단위를
//       참조하면 조용히 끊지 않고 전체 거절.
//   (d) 미지정 → 기존 추가 단계 동작 유지(물화·별도 범위 결과 부재) + 계약 위반(추가/복제 외 단위의
//       collectionScope 선언)은 구조화 거절.
//   (g) 계획 안내는 새 unmapped 단계를 허용한다고 정확히 안내하고 수집 구분 사용법을 안내한다(기존
//       '새 unmapped 단계 금지' 문구와의 모순 제거).
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, missionPlanDecisionSubmissions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, diagnosticsOf, grantSlice1Tool, openPlanQaIssueIds, paqoDefinitionSteps, registerSlice1Tool,
  slice1Decision, slice1Unit, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { buildRevisionMissionPlanningDescription } from "../services/missions/mission-revision-planning.js";
import { computePaqoDefinitionHash } from "../services/workflow/paqo-definition-identity.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-collection-scope-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-collection-scope-")));
  // 실행 경계 스텁: 이 슬라이스는 시작 없이 검증/별도 범위/물화까지만 다룬다(실제 호출되면 안 된다).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision collection scope"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const noRevisionRuns = (missionId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));

// 정기 수집 템플릿(기준): 수집기가 정기 URL(A) 과 수집 상태 토큰(워터마크)을 toolArgs 로 가진다.
const periodicTemplate = (agentId: string) => [
  { id: "tpl-collect", name: "Collect periodic", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true,
    toolNames: ["collect-periodic"], toolArgs: { url: "https://youtu.be/A", stateToken: { watermarks: { "channel-a": "wm-1" } } } },
  { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: ["tpl-collect"], graphWorkProductRequired: true },
];
const sourceUnits = [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }];
type MaterializedArgs = { url?: string; stateToken?: { watermarks?: Record<string, string> } };
type ScopeWorld = Awaited<ReturnType<typeof slice1World>>;

// 정기 정의·워터마크 불변: 기준 템플릿 행 bytes·동결 해시, 그리고 수집 상태 토큰을 그대로 대조한다.
async function assertPeriodicDefinitionUnchanged(w: ScopeWorld) {
  const [row] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, w.currentTemplate.id));
  expect(row).toBeTruthy();
  expect(row!.stepsJson).toEqual(w.currentTemplate.stepsJson); // 정기 정의 행 bytes 불변
  expect(computePaqoDefinitionHash(row!.stepsJson as Parameters<typeof computePaqoDefinitionHash>[0])).toBe(w.snapshotHash); // 드리프트 0
  const periodicCollect = (row!.stepsJson as Array<{ id: string; toolArgs?: MaterializedArgs }>).find(s => s.id === "tpl-collect")!;
  expect(periodicCollect.toolArgs).toEqual({ url: "https://youtu.be/A", stateToken: { watermarks: { "channel-a": "wm-1" } } }); // 워터마크 불변
}

it("(a) supported tool + oneShot new URL materializes a new input step while the periodic definition and watermark stay unchanged", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  const collector = await registerSlice1Tool(db, w.companyId, "collect-periodic", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, collector.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectNew", "Collect new URL once", { toolNames: ["collect-periodic"], graphWorkProductRequired: true,
      toolArgs: { url: "https://youtu.be/B" }, dependencies: [] }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectNew", operation: "add", collectionScope: "oneShot" },
  ]));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  const refs = await activePlanRefs(db, w.companyId, w.revision.id);
  expect(refs.revisionDelta).toBeDefined(); // 요청 변경안 보존
  expect(refs.revisionSeparateScopeRequests).toBeUndefined(); // oneShot 은 별도 범위 요청이 아니다
  expect(refs.revisionBlockedUnits).toBeUndefined();
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const newStep = steps.find(s => (s.toolNames ?? []).includes("collect-periodic"));
  expect(newStep).toBeTruthy(); // 새 입력 단계가 이 수정 실행 정의에 물화되었다
  expect(newStep!.toolArgs as MaterializedArgs).toEqual({ url: "https://youtu.be/B" }); // 1회 수집 인자 — 정기 상태 토큰 없음
  expect(newStep!.sourceStepId).toBeUndefined(); // 원본에 없는 새 unmapped 단계
  expect(steps.some(s => s.sourceStepId === w.source[0]!.id)).toBe(true); // 형제 재사용 단위 진행
  await assertPeriodicDefinitionUnchanged(w); // 정기 정의·워터마크 불변
  expect(await noRevisionRuns(w.revision.id)).toEqual([]); // 시작 없음
}, 60000);

it("(b) unsupported collection source stays a structured capability-gap outcome via the Q4 machinery", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  const gapTool = await registerSlice1Tool(db, w.companyId, "collect-unsupported", {}); // 등록·활성·부여되었으나 기능 없음
  await grantSlice1Tool(db, w.companyId, w.agentId, gapTool.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectNew", "Collect unsupported source", { toolNames: ["collect-unsupported"], graphWorkProductRequired: true,
      toolArgs: { url: "https://example.test/feed" }, dependencies: [] }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectNew", operation: "blocked" },
  ], { capabilityRequirements: [{ unitId: "collectNew", requiredOutcomeId: "feed-collected", toolName: "collect-unsupported", capability: "web_collect" }] }));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 부분진행 — 전체 invalid 가 아니다
  const refs = await activePlanRefs(db, w.companyId, w.revision.id);
  expect(refs.revisionBlockedUnits).toEqual([expect.objectContaining({
    unitId: "collectNew", toolName: "collect-unsupported", code: "mission_revision_capability_gap",
    message: expect.stringContaining("web_collect"),
  })]); // Q4 기계 재사용 — 실제 toolName 지칭
  expect(refs.revisionSeparateScopeRequests).toBeUndefined();
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  expect(steps.every(s => !(s.toolNames ?? []).includes("collect-unsupported"))).toBe(true); // 미지원 도구 물화 0
  expect(steps.some(s => s.sourceStepId === w.source[0]!.id)).toBe(true); // 형제 진행
  await assertPeriodicDefinitionUnchanged(w);
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
}, 60000);

it("(c) permanentChange request stays a separate-scope outcome with no silent permanent edit", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  // 별도 범위 단위는 이 실행에 물화되지 않는다 — 도구를 등록하지 않아도 독립 작업을 막지 않는다.
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectPermanent", "Collect new URL permanently", { toolNames: ["collect-periodic"], graphWorkProductRequired: true,
      toolArgs: { url: "https://youtu.be/B" }, dependencies: [] }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectPermanent", operation: "add", collectionScope: "permanentChange" },
  ]));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 부분진행 — 별도 범위 요청은 전체 거절이 아니다
  const refs = await activePlanRefs(db, w.companyId, w.revision.id);
  expect(refs.revisionSeparateScopeRequests).toEqual([expect.objectContaining({
    unitId: "collectPermanent", collectionScope: "permanentChange",
    code: "mission_revision_permanent_change_separate_scope",
    message: expect.stringContaining("정기 정의"),
  })]);
  expect(refs.revisionBlockedUnits).toBeUndefined(); // 차단이 아니라 별도 범위다
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  expect(steps.every(s => !(s.toolNames ?? []).includes("collect-periodic"))).toBe(true); // 조용한 영구 적용·물화 0
  expect(steps.some(s => s.sourceStepId === w.source[0]!.id)).toBe(true); // 형제 진행
  await assertPeriodicDefinitionUnchanged(w); // 정기 정의·워터마크 불변
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("recorded"); // 거부 아닌 부분진행 승인 기록
  expect(rows[0]!.rejectionReason).toBeNull();
}, 60000);

it("(c2) a proceeding unit referencing a separate-scope unit is rejected instead of silently dropping the link", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  const verifyTool = await registerSlice1Tool(db, w.companyId, "verify-neutral", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectPermanent", "Collect new URL permanently", { toolNames: ["collect-periodic"], graphWorkProductRequired: true,
      toolArgs: { url: "https://youtu.be/B" }, dependencies: [] }),
    slice1Unit(w.agentId, "consume", "Consume collection", { toolNames: ["verify-neutral"], dependencies: ["collectPermanent"],
      toolArgs: { collected: "{$steps.collectPermanent.workProductPath}" } }),
  ];
  const rejected = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectPermanent", operation: "add", collectionScope: "permanentChange" },
    { unitId: "consume", operation: "add" },
  ])));
  expect(rejected.status).toBe("invalid");
  expect(diagnosticsOf(rejected)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_separate_scope_unit_dependency", message: expect.stringContaining("collectPermanent") })]));
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual([]);
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows.every(row => row.status === "rejected")).toBe(true);
}, 60000);

it("(d) unspecified scope keeps the existing add-unit behavior and misplaced collectionScope is rejected", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  const collector = await registerSlice1Tool(db, w.companyId, "collect-periodic", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, collector.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectPlain", "Collect new URL", { toolNames: ["collect-periodic"], graphWorkProductRequired: true,
      toolArgs: { url: "https://youtu.be/B" }, dependencies: [] }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectPlain", operation: "add" },
  ]));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 기존 추가 단계 경로
  const refs = await activePlanRefs(db, w.companyId, w.revision.id);
  expect(refs.revisionSeparateScopeRequests).toBeUndefined(); // 미지정은 별도 범위/차단 결과를 만들지 않는다
  expect(refs.revisionBlockedUnits).toBeUndefined();
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const newStep = steps.find(s => (s.toolNames ?? []).includes("collect-periodic"));
  expect(newStep).toBeTruthy(); // 기존 동작: 미지정 추가 단위는 이 실행 초안에 물화된다
  expect(newStep!.toolArgs as MaterializedArgs).toEqual({ url: "https://youtu.be/B" });
  await assertPeriodicDefinitionUnchanged(w);
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
  const planQaIssueIdsAfterRecord = await openPlanQaIssueIds(db, w.revision.id);
  // 계약 위반: 수집 범위 구분은 추가(add)/복제(clone) 단위에만 선언할 수 있다.
  const onReuse = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id, collectionScope: "oneShot" },
    { unitId: "collectPlain", operation: "add" },
  ])));
  expect(onReuse.status).toBe("invalid");
  expect(diagnosticsOf(onReuse)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_delta_invalid", message: expect.stringContaining("collectionScope") })]));
  const onBlocked = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectPlain", operation: "blocked", collectionScope: "oneShot" },
  ])));
  expect(onBlocked.status).toBe("invalid");
  expect(diagnosticsOf(onBlocked)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_delta_invalid", message: expect.stringContaining("collectionScope") })]));
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual(planQaIssueIdsAfterRecord); // 거부는 새 PLAN-QA 를 만들지 않는다
}, 60000);

it("(g) planning guidance allows new unmapped units and teaches the collection scope distinction", async () => {
  const w = await slice1World(db, root, sourceUnits, periodicTemplate);
  const description = await buildRevisionMissionPlanningDescription(db, { companyId: w.companyId, missionId: w.revision.id,
    title: w.revision.title, description: null, runnableRosterLines: [] });
  expect(description).toContain("must include sourceStepId naming its exact source execution step"); // 매핑 규칙 유지
  expect(description).toContain("New unmapped plan units"); // 새 unmapped 단계 허용 안내
  expect(description).not.toContain("are not supported in this revision mode"); // 모순 문구 제거
  expect(description).toContain('collectionScope: "oneShot"');
  expect(description).toContain('"permanentChange"');
}, 60000);
