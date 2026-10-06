// server/src/__tests__/mission-revision-delta-materialization.test.ts
//
// [수정 변경안 첫 연결 — TEST-FIRST RED] 검증을 통과한 revisionDelta(mission-revision-delta.v1) 가
// (1) 물화 실행 데이터(paqo 정의 stepsJson), (2) PLAN-QA 고정 명세 입력(manifest.input.refs) 에 실제로
// 반영되는지를 공개 경로(제출→PLAN-QA 승인→동일 decision 재제출→recorded)로만 검증한다. fixture·경로는
// mission-revision-template-apply.test.ts 와 동일(slice1World/도구 등록·grant/정의 전용 executor 경계)이고
// RED 단언은 expect.soft 로 실행해 같은 it 의 대조(reuse 유닛·명시 wiring·무-delta) 단언도 함께 관찰된다.
// [경계 고지] executor 는 throw 를 유지하므로 이 테스트들은 물화(stepsJson)·명세 고정 증거일 뿐 실제
// executor 실행 증거가 아니다(실제 재사용→소비→새 QA 증명은 이후 별도 작업). 물화는 시작 승인이
// 아니므로 revision workflowRuns 는 없어야 한다.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, issues, workflowRuns } from "@paperclipai/db";
import type { ArtifactRef } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  documentSelector, grantSlice1Tool, openPlanQaIssueIds, paqoDefinitionSteps, registerSlice1Tool,
  slice1Decision, slice1PublicationContract, slice1Unit, slice1VerifyContract, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { readPlanQaManifestForIssue } from "../services/missions/plan-qa-addendum-manifest.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-delta-materialization-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-delta-materialization-")));
  // 정의 전용 경계: 게시 시작 없이 검증/물화/명세 고정까지만 다룬다(실제 호출되면 안 된다).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision delta materialization"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

type World = Awaited<ReturnType<typeof slice1World>>;
// 물화 스텝 관찰 형태(description 은 물화기가 항상 만들고, interpretedInputs 는 delta 반영의 즤표).
type MatStep = { id: string; type?: string; sourceStepId?: string; description?: string; interpretedInputs?: unknown;
  toolNames?: string[]; toolArgs?: unknown; workProductSelectors?: Record<string, unknown>; dependencies?: string[] };

// 원본 frozen 그래프(collect→write→check→publish→verify, report.md 좌표) — template-apply fixture 와 동일.
// 커스텀 source 식별은 w.source 의 실제 ID/w.sourceStep.stepId 로 한다(seedWorld 기본 f.steps 를 쓰지 않는다).
const sourceUnits = () => [
  { id: "collect", title: "Collect sources", dependencies: [] },
  { id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: ["collect"] },
  { id: "check", title: "Check report", type: "qa", dependencies: ["write"] },
  { id: "publish", title: "Publish report", graphWorkProductRequired: true, dependencies: ["check", "write"],
    toolNames: ["local-publish"], toolArgs: { content: "{$steps.write.workProductPath}" } },
  { id: "verify", title: "Verify publication", dependencies: ["publish"], toolNames: ["local-publish-verify"],
    toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } },
];
// 현재 템플릿은 원본과 구별되는 report-current.md selector·tpl-* 단계 ID 를 갖는다(template-apply 와 동일).
const currentTemplateSteps = (agentId: string) => [
  { id: "tpl-collect", name: "Collect", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
  { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: ["tpl-collect"], graphWorkProductRequired: true },
  { id: "tpl-check", name: "Check", type: "qa", agentId, dependencies: ["tpl-write"],
    workProductSelectors: { "tpl-write": documentSelector("report-current.md") } },
  { id: "tpl-publish", name: "Publish", type: "agent", agentId, dependencies: ["tpl-check", "tpl-write"],
    graphWorkProductRequired: true, toolNames: ["local-publish"],
    workProductSelectors: { "tpl-write": documentSelector("report-current.md") },
    toolArgs: { content: "{$steps.tpl-write.workProductPath}" } },
  { id: "tpl-verify", name: "Verify", type: "agent", agentId, dependencies: ["tpl-publish"],
    toolNames: ["local-publish-verify"], toolArgs: { qaResultPath: "{$steps.tpl-publish.workProductPath}" } },
];

async function prepareWorld() {
  const w = await slice1World(db, root, sourceUnits(), currentTemplateSteps);
  expect(w.sourceStep.stepId).toBe(w.source[0]!.id); // 재빌드된 실제 원본 그래프로 식별한다.
  const publishTool = await registerSlice1Tool(db, w.companyId, "local-publish", { artifactContract: slice1PublicationContract() });
  const verifyTool = await registerSlice1Tool(db, w.companyId, "local-publish-verify", { artifactContract: slice1VerifyContract() });
  await grantSlice1Tool(db, w.companyId, w.agentId, publishTool.id);
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  return w;
}

const expectNoRevisionWorkflowRuns = async (missionId: string) =>
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId))).toEqual([]); // 물화≠시작 승인

// template-apply A형(명시 wiring) 유닛 — 이 제출이 오늘 녹색 경로임이 그 테스트로 증명되어 있다.
const explicitUnits = (w: World) => [
  slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
  slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
  slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
  slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true,
    dependencies: ["check", "write"], workProductSelectors: { write: documentSelector("report-current.md") },
    toolArgs: { content: "{$steps.write.workProductPath}" } }),
  slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
    toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
];
// write 만 modify(templateStepId tpl-write + 지시·해석 입력), 나머지 유닛은 reuse/rerun.
const deltaWithModify = (w: World) => w.delta([
  { unitId: "collect", operation: "rerun", sourceStepId: w.source[0]!.id },
  { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, templateStepId: "tpl-write",
    instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
  { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id },
  { unitId: "publish", operation: "rerun" },
  { unitId: "verify", operation: "rerun" },
]);

// openPlanQaIssueIds 로 찾은 mission_plan_qa 이슈의 고정 마커(qualityPlanQaBinding.manifestRef)에서
// 검증된 원본 bytes(readPlanQaManifestForIssue — 첨부 연결·문서 계약·해시 검증 포함)로 동결 명세를 복원한다.
async function pinnedManifest(companyId: string, missionId: string) {
  const issueIds = await openPlanQaIssueIds(db, missionId);
  expect(issueIds.length).toBeGreaterThan(0);
  const rows = await db.select({ id: issues.id, marker: issues.qualityPlanQaBinding })
    .from(issues).where(inArray(issues.id, issueIds));
  const bound = rows.find(row => {
    const marker = (row.marker ?? {}) as { manifestRef?: ArtifactRef; supersededAt?: string | null };
    return marker.manifestRef !== undefined && marker.supersededAt == null;
  });
  expect(bound).toBeTruthy();
  const { manifestRef } = (bound!.marker ?? {}) as { manifestRef: ArtifactRef };
  return readPlanQaManifestForIssue(db, companyId, bound!.id, manifestRef);
}

it("modify delta instructions/interpretedInputs must reach the materialized write step (reuse·explicit wiring intact)", async () => {
  const w = await prepareWorld();
  const delta = deltaWithModify(w);
  const decision = () => slice1Decision(w.revision.id, explicitUnits(w), delta);
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 조기 invalid 면 받은 결과가 그대로 노출된다
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps: MatStep[] = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const writeStep = steps.find(s => s.sourceStepId === w.source[1]!.id);
  const collectStep = steps.find(s => s.sourceStepId === w.source[0]!.id);
  const checkStep = steps.find(s => s.sourceStepId === w.source[2]!.id);
  const publishStep = steps.find(s => (s.toolNames ?? []).includes("local-publish"));
  expect(writeStep).toBeTruthy();
  // [RED-1] 검증 통과 modify 유닛의 지시·해석 입력이 물화 실행 데이터(stepsJson)에 반영되어야 한다.
  expect.soft(writeStep!.description).toContain("요약 톤을 간결하게");
  expect.soft(writeStep!.interpretedInputs).toEqual({ tone: "concise" });
  // 대조: reuse 유닛(collect) 스텝에는 interpretedInputs 키와 지시 문구가 없다.
  expect(collectStep).toBeTruthy();
  expect("interpretedInputs" in collectStep!).toBe(false);
  expect(collectStep!.description ?? "").not.toContain("요약 톤을 간결하게");
  // 대조: 명시 wiring 유닛(publish)의 dependencies/workProductSelectors/toolArgs 는 template-apply A형 그대로.
  expect(checkStep).toBeTruthy();
  expect(publishStep).toBeTruthy();
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  await expectNoRevisionWorkflowRuns(w.revision.id);
});

it("pinned PLAN-QA manifest must freeze the full revisionDelta and stay delta-free without one", async () => {
  const w = await prepareWorld();
  const delta = deltaWithModify(w);
  const decision = () => slice1Decision(w.revision.id, explicitUnits(w), delta);
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first); // 명세는 제출 시점에 고정(pin)되고 승인은 그 원문을 그대로 둔다.
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const manifest = await pinnedManifest(w.companyId, w.revision.id);
  // [RED-2] 고정 명세 입력 refs 가 제출한 delta 전체와 deep-equal — schemaVersion·sourceWorkflowRunId·
  // modify 지시/해석 입력·base(회사 실제 정의 id·64-hex 스냅샷 해시)가 동결 문서에 존재해야 한다.
  expect.soft(manifest.input.refs.revisionDelta).toEqual(delta);
  expect.soft(manifest.input.refs.revisionDelta).toEqual(expect.objectContaining({
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: w.sourceRun.id,
    base: { workflowDefinitionId: w.currentTemplate.id, snapshotHash: w.snapshotHash },
  }));
  // 무-delta 보존: 같은 공개 경로의 revisionDelta 없는 decision 명세 입력 refs 에는 그 키가 없다.
  const control = await prepareWorld();
  const plain = () => slice1Decision(control.revision.id, explicitUnits(control));
  const controlFirst = await control.submit(plain());
  expect(controlFirst).toMatchObject({ status: "plan_qa_pending" });
  await control.approve(controlFirst);
  expect(await control.submit(plain())).toMatchObject({ status: "recorded" });
  const controlManifest = await pinnedManifest(control.companyId, control.revision.id);
  expect("revisionDelta" in controlManifest.input.refs).toBe(false);
  await expectNoRevisionWorkflowRuns(w.revision.id);
  await expectNoRevisionWorkflowRuns(control.revision.id);
});
