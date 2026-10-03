// server/src/__tests__/mission-revision-template-inheritance-safety.test.ts
//
// [슬라이스1 — 현재 템플릿 상속 안전성] 유일한 templateStepId 대응 상속의 실패 폐쇄·좌표 충돌·명시
//   우선 규칙을 실제 공개 제출 경로로 확인한다(기대값은 literal, fixture 알고리즘 없음). 거부 계열은
//   조기 invalid + 거부 원장 진단 + PLAN-QA·revision run 부재를, 성공 계열은 pending refs → 실제
//   PLAN-QA 승인 → recorded 그래프 일치 → 동일 decision 재제출 noop/동일 정의를 독립 it 로 증명한다.
//   정의 전용 executor 경계(실제 실행 없음)와 기존 template-apply 두 it 는 그대로다.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, missionPlanDecisionSubmissions, workflowRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, diagnosticsOf, documentSelector, grantSlice1Tool, openPlanQaIssueIds, paqoDefinitionSteps,
  registerSlice1Tool, slice1Decision, slice1PublicationContract, slice1Unit, slice1VerifyContract, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-template-safety-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-template-safety-")));
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision template safety"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const sourceUnits = () => [
  { id: "collect", title: "Collect sources", dependencies: [] },
  { id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: ["collect"] },
  { id: "check", title: "Check report", type: "qa", dependencies: ["write"] },
  { id: "publish", title: "Publish report", graphWorkProductRequired: true, dependencies: ["check", "write"],
    toolNames: ["local-publish"], toolArgs: { content: "{$steps.write.workProductPath}" } },
  { id: "verify", title: "Verify publication", dependencies: ["publish"], toolNames: ["local-publish-verify"],
    toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } },
];
// 기준 템플릿(각 it 가 변형 지점만 교체한다). tpl-publish 는 [tpl-check, tpl-write] 에 의존하고 selector
// 생산자는 tpl-write, content token 은 {$steps.tpl-write.workProductPath} 다.
const templateSteps = (agentId: string, publishOverride: Record<string, unknown> = {}, extra: unknown[] = []) => [
  { id: "tpl-collect", name: "Collect", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
  { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: ["tpl-collect"], graphWorkProductRequired: true },
  { id: "tpl-check", name: "Check", type: "qa", agentId, dependencies: ["tpl-write"],
    workProductSelectors: { "tpl-write": documentSelector("report-current.md") } },
  { id: "tpl-publish", name: "Publish", type: "agent", agentId, dependencies: ["tpl-check", "tpl-write"],
    graphWorkProductRequired: true, toolNames: ["local-publish"],
    workProductSelectors: { "tpl-write": documentSelector("report-current.md") },
    toolArgs: { content: "{$steps.tpl-write.workProductPath}" }, ...publishOverride },
  { id: "tpl-verify", name: "Verify", type: "agent", agentId, dependencies: ["tpl-publish"],
    toolNames: ["local-publish-verify"], toolArgs: { qaResultPath: "{$steps.tpl-publish.workProductPath}" } },
  ...extra,
];
const templateUnits = (w: World, publishExtra: Record<string, unknown> = {}, extraUnits: Record<string, unknown>[] = []) => [
  slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
  slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
  slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
  // 상속 검증 대상(dependencies/workProductSelectors/toolArgs)만 생략. 담당자/type/toolNames/산출물 선언 유지.
  slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true, ...publishExtra }),
  slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
    toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ...extraUnits,
];
const templateDelta = (w: World, publishExtra: Record<string, unknown> = {}, extraUnits: Record<string, unknown>[] = []) => w.delta([
  { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id, templateStepId: "tpl-collect" },
  { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, templateStepId: "tpl-write",
    instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
  { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id, templateStepId: "tpl-check" },
  { unitId: "publish", operation: "rerun", templateStepId: "tpl-publish", ...publishExtra },
  { unitId: "verify", operation: "rerun", templateStepId: "tpl-verify" },
  ...extraUnits,
]);
type World = Awaited<ReturnType<typeof prepareWorld>>;
async function prepareWorld(templateStepsForAgent: (agentId: string) => unknown[], withTools = true) {
  const w = await slice1World(db, root, sourceUnits(), templateStepsForAgent);
  if (!withTools) return w;
  const publishTool = await registerSlice1Tool(db, w.companyId, "local-publish", { artifactContract: slice1PublicationContract() });
  const verifyTool = await registerSlice1Tool(db, w.companyId, "local-publish-verify", { artifactContract: slice1VerifyContract() });
  await grantSlice1Tool(db, w.companyId, w.agentId, publishTool.id);
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  return w;
}
// 거부 계열 공개 경로 증거: 조기 invalid + 거부 원장(rejectionReason/진단) + PLAN-QA·revision run 부재.
async function expectStructuredRejection(w: World, decision: Record<string, unknown>, expectedReason: string) {
  const result = await w.submit(decision);
  expect(result).toMatchObject({ status: "invalid", reason: expectedReason });
  const [ledger] = await db.select().from(missionPlanDecisionSubmissions)
    .where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(ledger?.status).toBe("rejected");
  expect(ledger?.rejectionReason).toBe(expectedReason);
  expect((ledger?.diagnostics ?? []).length).toBeGreaterThan(0);
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual([]);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).toEqual([]);
  return diagnosticsOf(result);
}
// 성공 계열 공개 경로 증거: pending refs → 실제 PLAN-QA 승인 → recorded 그래프 → 재제출 noop·동일 정의.
async function expectRecordedSteps(w: World, decision: () => Record<string, unknown>) {
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  expect(await w.submit(decision())).toMatchObject({ status: "noop", reason: "already_recorded" });
  expect(await paqoDefinitionSteps(db, w.companyId, w.revision.id)).toEqual(steps); // 재제출은 정의를 바꾸지 않는다
  return {
    steps, writeStep: steps.find(s => s.sourceStepId === w.source[1]!.id),
    checkStep: steps.find(s => s.sourceStepId === w.source[2]!.id),
    publishStep: steps.find(s => (s.toolNames ?? []).includes("local-publish")),
  };
}

it("unknown template toolArgs producer token is rejected before PLAN-QA with ledger diagnostics", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId, { toolArgs: { content: "{$steps.ghost.workProductPath}" } }));
  const diagnostics = await expectStructuredRejection(w,
    slice1Decision(w.revision.id, templateUnits(w), templateDelta(w)), "mission_revision_delta_invalid");
  expect(diagnostics.some(d => d.message.includes("ghost"))).toBe(true);
});

it("template dependency on an existing but unselected producer step is rejected", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId, { dependencies: ["tpl-check", "tpl-write", "tpl-notes"] },
    [{ id: "tpl-notes", name: "Notes", type: "agent", agentId, dependencies: ["tpl-collect"] }]));
  const diagnostics = await expectStructuredRejection(w,
    slice1Decision(w.revision.id, templateUnits(w), templateDelta(w)), "mission_revision_delta_invalid");
  expect(diagnostics.some(d => d.message.includes("tpl-notes"))).toBe(true);
});

it("two units claiming one templateStepId are rejected as ambiguous without inventing a producer", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId));
  const diagnostics = await expectStructuredRejection(w, slice1Decision(w.revision.id,
    templateUnits(w, {}, [slice1Unit(w.agentId, "publish-extra", "Extra publisher", {})]),
    templateDelta(w, {}, [{ unitId: "publish-extra", operation: "add", templateStepId: "tpl-publish" }])),
    "mission_revision_unit_reference_ambiguous");
  expect(diagnostics.some(d => d.message.includes("tpl-publish"))).toBe(true);
});

it("unit id colliding with an unselected template step id still remaps native wiring normally", async () => {
  // 선택 유닛 id "write" 는 미선택 템플릿 단계 id "write" 와 같다: 재작성된 선택 좌표를 다시 템플릿 좌표로
  // 읽으면 정상 대응을 오거절한다. 원본 좌표 검증 + 한 번의 재작성은 이 충돌을 통과해야 한다.
  const w = await prepareWorld(agentId => templateSteps(agentId, {},
    [{ id: "write", name: "Legacy write alias", type: "agent", agentId, dependencies: [] }]));
  const { writeStep, checkStep, publishStep } = await expectRecordedSteps(w,
    () => slice1Decision(w.revision.id, templateUnits(w), templateDelta(w)));
  expect(writeStep).toBeTruthy();
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
});

it("requiredInputs declared on an omitted-config unit are satisfied by the inherited selector", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId));
  const { writeStep, checkStep, publishStep } = await expectRecordedSteps(w, () => slice1Decision(w.revision.id,
    templateUnits(w), templateDelta(w, { requiredInputs: [{ fromUnitId: "write", selector: documentSelector("report-current.md") }] })));
  expect(publishStep!.dependencies).toHaveLength(2);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
});

it("explicitly empty workProductSelectors cannot silently drop declared requiredInputs", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId));
  const diagnostics = await expectStructuredRejection(w, slice1Decision(w.revision.id,
    templateUnits(w, { workProductSelectors: {} }),
    templateDelta(w, { requiredInputs: [{ fromUnitId: "write", selector: documentSelector("report-current.md") }] })),
    "mission_revision_delta_invalid");
  expect(diagnostics.some(d => d.message.includes("소비되지 않습니다"))).toBe(true);
});

it("structured decision.steps dependency declaration overrides template dependency inheritance", async () => {
  const w = await prepareWorld(agentId => templateSteps(agentId));
  const decision = () => ({ ...slice1Decision(w.revision.id, templateUnits(w), templateDelta(w)),
    steps: [{ id: "publish", dependsOn: ["check", "write", "collect"] }] });
  const { steps, writeStep, checkStep, publishStep } = await expectRecordedSteps(w, decision);
  const collectStep = steps.find(s => s.sourceStepId === w.source[0]!.id);
  // steps 선언 연결이 그대로 유지된다(템플릿 [check, write] 로 교체·축소되지 않는다). selectors/toolArgs 는
  // 생략됐으므로 여전히 상속된다.
  expect(publishStep!.dependencies).toHaveLength(3);
  expect(publishStep!.dependencies).toEqual(expect.arrayContaining([collectStep!.id, checkStep!.id, writeStep!.id]));
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report-current.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
});

it("explicitly empty steps dependency declaration stays empty while omitted wiring is inherited", async () => {
  // 게시 도구가 없는 세계: steps 의 빈 dependsOn 선언(publish dependencies [])이 템플릿 [check, write]
  // 로 채워지지 않고, 생략된 selectors/toolArgs 만 상속되는지 pending refs 로 확인한다(물화 전 단계 증거).
  const w = await prepareWorld(agentId => templateSteps(agentId), false);
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { graphWorkProductRequired: true }),
    slice1Unit(w.agentId, "verify", "Verify publication", { dependencies: ["publish"] }),
  ];
  const decision = { ...slice1Decision(w.revision.id, units, templateDelta(w)), steps: [{ id: "publish", dependsOn: [] }] };
  expect(await w.submit(decision)).toMatchObject({ status: "plan_qa_pending" });
  const persisted = ((await activePlanRefs(db, w.companyId, w.revision.id)).selectedExecutionUnits as Record<string, unknown>[])
    .find(unit => unit.id === "publish");
  expect(persisted?.dependencies).toEqual([]); // 명시적 빈 선언 보존 — 템플릿 의존성 미상속
  expect(persisted?.workProductSelectors).toEqual({ write: documentSelector("report-current.md") }); // 생략은 상속
  expect(persisted?.toolArgs).toEqual({ content: "{$steps.write.workProductPath}" });
});
