// server/src/__tests__/mission-revision-template-apply.test.ts
//
// [슬라이스1 — 현재 템플릿 적용] 같은 유효한 현재 템플릿(tpl-* 좌표, report-current.md selector) 아래에서
//   (A) 대조군: 선택 유닛에 필요한 설정(dependencies/workProductSelectors/toolArgs 포함)을 모두 명시.
//   (B) 후보 RED: 각 delta unit 이 유일한 templateStepId 를 가리키고 publish 선택 유닛은 상속 대상인
//       dependencies/workProductSelectors/toolArgs 를 반복하지 않는다(담당자/type/toolNames/산출물 선언 유지).
// 두 it 모두 동일한 공개 경로(제출→PLAN-QA 승인→동일 decision 재제출→recorded→DB stepsJson)로 검증한다.
// 이어지는 두 회귀는 steps 대상 판정 계약(normalizer readDraftTargets/resolve 동일)을 같은 공개 경로로
//   검증한다: (C) 비어 있지 않은 units 배열이 대상 전부(id 등은 명시 대상이 아니므로 publish 생략 상속
//   유지), (D) canonical unit id 가 다른 유닛의 legacy 별칭보다 우선(별칭 소유 유닛의 생략 상속 보존).
// B 는 생성 publish 가 현재 템플릿의 write/check 연결·selector·native token 을 새 write ID 로 물화하는지
// 확인한다(실제 RED 여부는 호스트 실행 결과로 구분한다; 조기 invalid 여부도 받은 결과가 그대로 드러난다).
// 물화는 시작 승인이 아니므로 revision workflowRuns 는 없어야 한다. 도구 등록·definition-only executor
// 경계는 게시/auth 준비 증거가 아니고 sourceStepId 는 원본 대응이지 재사용 승인이 아니다.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, documentSelector, grantSlice1Tool, paqoDefinitionSteps, registerSlice1Tool, slice1Decision,
  slice1PublicationContract, slice1Unit, slice1VerifyContract, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-template-apply-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-template-apply-")));
  // 정의 전용 경계: 게시 시작 없이 검증/물화까지만 다룬다(실제 호출되면 안 된다).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision template apply"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

// 원본 frozen 그래프(collect→write→check→publish→verify, report.md 좌표). 커스텀 source 식별은
// w.source 의 실제 ID/w.sourceStep.stepId 로 한다(seedWorld 의 기본 f.steps 를 쓰지 않는다).
const sourceUnits = () => [
  { id: "collect", title: "Collect sources", dependencies: [] },
  { id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: ["collect"] },
  { id: "check", title: "Check report", type: "qa", dependencies: ["write"] },
  { id: "publish", title: "Publish report", graphWorkProductRequired: true, dependencies: ["check", "write"],
    toolNames: ["local-publish"], toolArgs: { content: "{$steps.write.workProductPath}" } },
  { id: "verify", title: "Verify publication", dependencies: ["publish"], toolNames: ["local-publish-verify"],
    toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } },
];
// 현재 템플릿은 원본과 구별되는 report-current.md selector 와 tpl-* 단계 ID 를 갖는다. publish 는
// [tpl-check, tpl-write] 에 의존하고 selector 생산자는 tpl-write, content token 은
// {$steps.tpl-write.workProductPath} 다(action/qa 역할 명시; native publication/verify artifactContract 는
// 같은 회사 담당자에게 grant 된 등록 도구가 제공한다 — 등록·경계 자체는 준비 증거가 아니다).
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

// 물화 결과 노드 식별: 원본 대응(sourceStepId)·게시 도구라는 고유 좌표로 찾는다(기대값 자체는 literal).
async function materialized(w: Awaited<ReturnType<typeof prepareWorld>>) {
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  return {
    steps,
    writeStep: steps.find(s => s.sourceStepId === w.source[1]!.id),
    checkStep: steps.find(s => s.sourceStepId === w.source[2]!.id),
    publishStep: steps.find(s => (s.toolNames ?? []).includes("local-publish")),
  };
}

it("explicit-config control: public submit → PLAN-QA approve → resubmit records remapped native wiring", async () => {
  const w = await prepareWorld();
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true,
      dependencies: ["check", "write"], workProductSelectors: { write: documentSelector("report-current.md") },
      toolArgs: { content: "{$steps.write.workProductPath}" } }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  const delta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id,
      instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id },
    { unitId: "publish", operation: "rerun" },
    { unitId: "verify", operation: "rerun" },
  ]);
  const decision = () => slice1Decision(w.revision.id, units, delta);
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const { writeStep, checkStep, publishStep } = await materialized(w);
  expect(writeStep).toBeTruthy();
  expect(checkStep?.type).toBe("qa");
  expect(publishStep).toBeTruthy();
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id])); // write/check 연결
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  await expectNoRevisionWorkflowRuns(w.revision.id);
});

it("uniquely mapped template config omitted on publish must be inherited from the current template", async () => {
  const w = await prepareWorld();
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    // 상속 검증 대상(dependencies/workProductSelectors/toolArgs)만 반복하지 않는다. 담당자/type/toolNames/
    // 산출물 선언 등 이번 상속 대상이 아닌 필수 계약은 유지한다.
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  // 각 delta unit 은 현재 템플릿의 유일한 단계를 가리킨다(templateStepId 는 좌표, 재사용 승인이 아니다).
  const delta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id, templateStepId: "tpl-collect" },
    { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, templateStepId: "tpl-write",
      instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id, templateStepId: "tpl-check" },
    { unitId: "publish", operation: "rerun", templateStepId: "tpl-publish" },
    { unitId: "verify", operation: "rerun", templateStepId: "tpl-verify" },
  ]);
  const decision = () => slice1Decision(w.revision.id, units, delta);
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 조기 invalid 면 받은 결과가 그대로 노출된다
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const { writeStep, checkStep, publishStep } = await materialized(w);
  expect(writeStep).toBeTruthy();
  expect(checkStep?.type).toBe("qa");
  expect(publishStep).toBeTruthy();
  // 생성 publish 는 현재 템플릿의 write/check 연결·selector·token 을 새 write ID 로 물화해야 한다.
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  await expectNoRevisionWorkflowRuns(w.revision.id);
});

// [대상 판정 회귀 1 — units 우선] 비어 있지 않은 steps.units 배열이 대상 전부다(normalizer readDraftTargets
//   동일): id:'publish' 는 명시 대상이 아니므로 publish 의 생략은 유지되고 템플릿 check/write 연결이
//   pending refs 와 승인 후 stepsJson 에 그대로 상속되어야 한다.
it("steps.units target keeps only collect explicit so omitted publish still inherits template dependencies", async () => {
  const w = await prepareWorld();
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  const delta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id, templateStepId: "tpl-collect" },
    { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, templateStepId: "tpl-write",
      instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id, templateStepId: "tpl-check" },
    { unitId: "publish", operation: "rerun", templateStepId: "tpl-publish" },
    { unitId: "verify", operation: "rerun", templateStepId: "tpl-verify" },
  ]);
  const decision = () => ({ ...slice1Decision(w.revision.id, units, delta),
    steps: [{ units: ["collect"], id: "publish", dependsOn: [] }] });
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  const pendingPublish = (((await activePlanRefs(db, w.companyId, w.revision.id)).selectedExecutionUnits as Record<string, unknown>[])
    .find(unit => unit.id === "publish"));
  expect(pendingPublish?.dependencies).toEqual(["check", "write"]); // collect 만 명시 — publish 생략은 상속
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const { writeStep, checkStep, publishStep } = await materialized(w);
  expect(writeStep).toBeTruthy();
  expect(checkStep?.type).toBe("qa");
  expect(publishStep).toBeTruthy();
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  await expectNoRevisionWorkflowRuns(w.revision.id);
});

// [대상 판정 회귀 2 — canonical 우선] 다른 유닛(write) 의 legacy 별칭(sourceRef.stepId 'publish') 이
//   canonical publish id 와 겹쳐도 steps 의 publish 대상은 canonical publish 에만 적용되고, write 의
//   생략된 dependencies 는 템플릿(tpl-write → collect) 에서 여전히 상속되어야 한다.
it("canonical publish id wins over another unit's legacy alias so its omitted dependencies still inherit", async () => {
  const w = await prepareWorld();
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    // dependencies 생략(상속 대상) + legacy 별칭 충돌: sourceRef.stepId 가 canonical publish id 와 같다.
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true,
      sourceRef: { type: "mission_plan_unit", id: "write", stepId: "publish" } }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  const delta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id, templateStepId: "tpl-collect" },
    { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, templateStepId: "tpl-write",
      instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id, templateStepId: "tpl-check" },
    { unitId: "publish", operation: "rerun", templateStepId: "tpl-publish" },
    { unitId: "verify", operation: "rerun", templateStepId: "tpl-verify" },
  ]);
  const decision = () => ({ ...slice1Decision(w.revision.id, units, delta),
    steps: [{ id: "publish", dependsOn: ["check", "write"] }] });
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  const pendingUnits = ((await activePlanRefs(db, w.companyId, w.revision.id)).selectedExecutionUnits as Record<string, unknown>[]);
  expect(pendingUnits.find(unit => unit.id === "write")?.dependencies).toEqual(["collect"]); // 별칭 소유자는 명시 대상이 아니다
  expect(pendingUnits.find(unit => unit.id === "publish")?.dependencies).toEqual(["check", "write"]); // canonical 에만 적용
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const { steps, writeStep, checkStep, publishStep } = await materialized(w);
  const collectStep = steps.find(s => s.sourceStepId === w.source[0]!.id);
  expect(writeStep).toBeTruthy();
  expect(checkStep).toBeTruthy();
  expect(publishStep).toBeTruthy();
  expect(writeStep!.dependencies).toEqual([collectStep!.id]); // 생략된 write 연결의 템플릿 상속 보존
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  await expectNoRevisionWorkflowRuns(w.revision.id);
});
