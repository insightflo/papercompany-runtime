// server/src/__tests__/mission-revision-slice1.test.ts
//
// [슬라이스1 RED] 승인된 변경지도(2026-10-03-revision-mission-change-map) 1단계
// (R1/R2/R3/R5)의 세 수정 유형을 계획 제출→검증→물화 그래프 소비부로 검증한다.
// 판정 근거는 프롬프트 문구/소스 문자열이 아니라 revisionPlanDiagnostics(제출 검증)
// 와 buildPaqoWorkflowSteps(물화 그래프)의 구조화 결과다. 아래 세 진단 코드는
// 현재 구현에 없는 의도된 RED(실패)이며 후속 구현 work가 통과시킨다.
//  - mission_revision_reuse_producer_unsupported: 소스 QA 영수증 재사용 매핑 거부(유형1)
//  - mission_revision_workproduct_selector_conflict: 동일 파일명 이중 소비 진단(유형2)
//  - workflow_tool_unavailable: 미등록 게시 도구 유닛 단위 기능부족(유형3)

import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, issues, toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { legacyHtmlManualPublicationContract } from "./helpers/legacy-html-manual.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { revisionPlanDiagnostics } from "../services/missions/revision-plan-validation.js";
import { listCompanyPlanningArtifactTools } from "../services/missions/mission-plan-publication-contract.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-slice1-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-slice1-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const selector = (title: string) => ({ type: "document" as const, title });
const draft = (units: Record<string, unknown>[], steps?: Record<string, unknown>[]) => ({ missionGoal: "report",
  successCriteria: [], steps: steps ?? units.map((unit, i) => ({ unitId: unit.id, dependencies: i ? [units[i - 1].id] : [] })),
  refs: { selectedExecutionUnits: units } });
const diagnose = (f: Awaited<ReturnType<typeof seedWorld>>, plan: ReturnType<typeof draft>,
  tools: Awaited<ReturnType<typeof listCompanyPlanningArtifactTools>>) =>
  revisionPlanDiagnostics(db, f.companyId, f.revision.id, plan.refs.selectedExecutionUnits,
    mission => buildPaqoWorkflowSteps(plan as never, mission, { tools }));

it("type1 content+publish change reuses only the unrelated upstream and never the source QA receipt", async () => {
  const source = draft([{ id: "write", title: "Write", graphWorkProductRequired: true }]);
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(source as never, mission));
  const sourceQaStepId = f.steps[f.steps.length - 1]!.id;
  const [qaIssue] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.sourceMission.id,
    title: "QA", status: "done" }).returning();
  await db.insert(workflowStepRuns).values({ workflowRunId: f.sourceRun.id, stepId: sourceQaStepId,
    issueId: qaIssue.id, status: "completed", completedAt: new Date() });
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "local-publish", adapterType: "builtin",
    adapterConfig: { artifactContract: legacyHtmlManualPublicationContract("publish.mjs") } });
  const tools = await listCompanyPlanningArtifactTools(db, f.companyId);
  const write = { id: "write", title: "Write", graphWorkProductRequired: true, sourceStepId: f.steps[0].id };
  const publish = { id: "publish", title: "Publish", toolNames: ["local-publish"],
    workProductSelectors: { write: selector("content.json") }, toolArgs: { content: "{$steps.write.workProductPath}" } };
  const plan = draft([write, publish]);
  const steps = buildPaqoWorkflowSteps(plan as never, f.revision, { tools });
  const writeStep = steps.find(s => s.sourceStepId === f.steps[0].id)!;
  const publishStep = steps.find(s => s.toolNames?.includes("local-publish"))!;
  expect(writeStep).toBeTruthy();
  expect(publishStep).toBeTruthy();
  expect(publishStep).not.toHaveProperty("sourceStepId");
  expect(publishStep.workProductSelectors).toEqual({ [writeStep.id]: selector("content.json") });
  expect(publishStep.toolArgs).toEqual({ content: `{$steps.${writeStep.id}.workProductPath}` });
  const freshQa = steps.filter(s => s.type === "qa");
  expect(freshQa).toHaveLength(1);
  expect(freshQa[0]).not.toHaveProperty("sourceStepId");
  await expect(diagnose(f, plan, tools)).resolves.toEqual([]);
  const receiptReuse = draft([write, publish,
    { id: "finalQa", title: "Final QA", type: "qa", sourceStepId: sourceQaStepId }]);
  await expect(diagnose(f, receiptReuse, tools)).resolves.toEqual([expect.objectContaining({
    code: "mission_revision_reuse_producer_unsupported", severity: "invalid",
    details: expect.objectContaining({ unitId: "finalQa", sourceStepId: sourceQaStepId }) })]);
});

it("type2 youtube A+B revision consumes both remapped inputs and rejects the same-filename conflict", async () => {
  const source = draft([{ id: "collect", title: "Collect A", toolNames: ["youtube-collect"],
    toolArgs: { url: "https://youtu.test/A" }, graphWorkProductRequired: true }]);
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(source as never, mission));
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "youtube-collect",
    adapterType: "builtin", adapterConfig: { command: "collect" } });
  const tools = await listCompanyPlanningArtifactTools(db, f.companyId);
  const collectA = { id: "collectA", title: "Collect A", toolNames: ["youtube-collect"],
    toolArgs: { url: "https://youtu.test/A" }, graphWorkProductRequired: true, sourceStepId: f.steps[0].id };
  const collectB = { id: "collectB", title: "Collect B", toolNames: ["youtube-collect"],
    toolArgs: { url: "https://youtu.test/B" }, graphWorkProductRequired: true };
  const synth = (titleA: string, titleB: string) => ({ id: "synth", title: "Synthesize", graphWorkProductRequired: true,
    workProductSelectors: { collectA: selector(titleA), collectB: selector(titleB) },
    toolArgs: { reportA: "{$steps.collectA.workProductPath}", reportB: "{$steps.collectB.workProductPath}" } });
  const topology = [{ unitId: "collectA", dependencies: [] }, { unitId: "collectB", dependencies: [] },
    { unitId: "synth", dependencies: ["collectA", "collectB"] }];
  const plan = draft([collectA, collectB, synth("report-a.json", "report-b.json")], topology);
  const built = buildPaqoWorkflowSteps(plan as never, f.revision, { tools });
  const aStep = built.find(s => s.sourceStepId === f.steps[0].id)!;
  const bStep = built.find(s => (s.toolArgs as { url?: string } | undefined)?.url === "https://youtu.test/B")!;
  const synthStep = built.find(s => (s.toolArgs as { reportA?: string } | undefined)?.reportA !== undefined)!;
  expect(aStep).toBeTruthy();
  expect(bStep).toBeTruthy();
  expect(bStep).not.toHaveProperty("sourceStepId");
  expect(synthStep).toBeTruthy();
  expect(synthStep.workProductSelectors).toEqual({ [aStep.id]: selector("report-a.json"), [bStep.id]: selector("report-b.json") });
  expect(synthStep.toolArgs).toEqual({ reportA: `{$steps.${aStep.id}.workProductPath}`, reportB: `{$steps.${bStep.id}.workProductPath}` });
  await expect(diagnose(f, plan, tools)).resolves.toEqual([]);
  const conflicting = draft([collectA, collectB, synth("report-a.json", "report-a.json")], topology);
  await expect(diagnose(f, conflicting, tools)).resolves.toEqual([expect.objectContaining({
    code: "mission_revision_workproduct_selector_conflict", severity: "invalid",
    details: expect.objectContaining({ unitId: "synth", selector: selector("report-a.json") }) })]);
});

it("type3 missing publish tool is a unit-scoped capability gap that keeps other units materializable", async () => {
  const f = await seedWorld(db, root);
  const write = { id: "write", title: "Write", graphWorkProductRequired: true, sourceStepId: "write" };
  const publish = { id: "publish", title: "Publish to blog", toolNames: ["tistory-publish"],
    workProductSelectors: { write: selector("content.json") }, toolArgs: { content: "{$steps.write.workProductPath}" } };
  const plan = draft([write, publish]);
  await expect(diagnose(f, plan, await listCompanyPlanningArtifactTools(db, f.companyId))).resolves.toEqual([
    expect.objectContaining({ code: "workflow_tool_unavailable", severity: "invalid",
      message: expect.stringContaining("tistory-publish"),
      details: expect.objectContaining({ unitId: "publish", toolName: "tistory-publish" }) })]);
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "tistory-publish", adapterType: "builtin",
    adapterConfig: { artifactContract: legacyHtmlManualPublicationContract("publish.mjs") } });
  const tools = await listCompanyPlanningArtifactTools(db, f.companyId);
  const steps = buildPaqoWorkflowSteps(plan as never, f.revision, { tools });
  expect(steps.find(s => s.sourceStepId === "write")).toBeTruthy();
  expect(steps.find(s => s.toolNames?.includes("tistory-publish"))).toBeTruthy();
  await expect(diagnose(f, plan, tools)).resolves.toEqual([]);
  const independent = draft([write]);
  expect(buildPaqoWorkflowSteps(independent as never, f.revision, { tools })
    .find(s => s.sourceStepId === "write")).toBeTruthy();
  await expect(diagnose(f, independent, tools)).resolves.toEqual([]);
});
