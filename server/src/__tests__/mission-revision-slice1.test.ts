// server/src/__tests__/mission-revision-slice1.test.ts
//
// [슬라이스1 RED — 유형1/유형3] 승인된 변경지도(2026-10-03) 1단계의 R1/R2/R3(유형1), R5(유형3)를
// 공개 제출(submitMissionOwnerPlanDecision → record → 검증/PLAN-QA → 물화)의 실제 결과로 검증한다.
// 판정 근거는 문구/소스 문자열이 아니라 record 결과, mission_plan_decision_submissions 원장,
// active plan refs, 서버가 생성한 paqo workflow definition 이다.
// 의도된 RED(현재 구현이 놓치는 계약, 후속 구현 work가 통과시킴):
//  - decision.revisionDelta 가 active plan refs 에 버전 보존되지 않고 조용히 버려진다.
//  - unknown schemaVersion / 모순된 operation 이 공개 제출에서 구조화 거절되지 않는다.
//  - capability 불충족이 unit 단위 구조화 gap(mission_revision_capability_gap)으로 남지 않는다.
// 회귀 보호(오늘 green이어야 함): 도구 미등록/비활성/무권한 거절, PLAN-QA 대기·승인 경계,
// 현재 템플릿 연결 기반 재매핑, QA sourceStepId 대응 허용, 계획 판정≠실행 승인.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, missionPlanDecisionSubmissions, toolDefinitions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, diagnosticsOf, documentSelector, findPaqoDefinition, grantSlice1Tool, openPlanQaIssueIds,
  paqoDefinitionSteps, registerSlice1Tool, slice1Decision, slice1PublicationContract, slice1Unit,
  slice1VerifyContract, slice1World,
} from "./helpers/mission-revision-slice1-world.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-slice1-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-slice1-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it("type1 typed delta keeps impact sets durable, publish-only keeps body reuse, unknown/contradictory deltas are rejected", async () => {
  const sourceUnits = [
    { id: "collect", title: "Collect sources", dependencies: [] },
    { id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: ["collect"] },
    { id: "check", title: "Check report", type: "qa", dependencies: ["write"] },
    { id: "publish", title: "Publish report", graphWorkProductRequired: true, dependencies: ["check", "write"],
      toolNames: ["local-publish"], toolArgs: { content: "{$steps.write.workProductPath}" } },
    { id: "verify", title: "Verify publication", dependencies: ["publish"], toolNames: ["local-publish-verify"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } },
  ];
  // 현재 템플릿은 원본 frozen 그래프와 다르다(selector title report.md, tpl-* 단계).
  const w = await slice1World(db, root, sourceUnits, agentId => [
    { id: "tpl-collect", name: "Collect", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
    { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: ["tpl-collect"], graphWorkProductRequired: true },
    { id: "tpl-check", name: "Check", type: "qa", agentId, dependencies: ["tpl-write"],
      workProductSelectors: { "tpl-write": documentSelector("report.md") } },
    { id: "tpl-publish", name: "Publish", type: "agent", agentId, dependencies: ["tpl-check"], graphWorkProductRequired: true,
      toolNames: ["local-publish"], workProductSelectors: { "tpl-write": documentSelector("report.md") },
      toolArgs: { content: "{$steps.tpl-write.workProductPath}" } },
    { id: "tpl-verify", name: "Verify", type: "agent", agentId, dependencies: ["tpl-publish"],
      toolNames: ["local-publish-verify"], toolArgs: { qaResultPath: "{$steps.tpl-publish.workProductPath}" } },
  ]);
  expect(w.sourceStep.stepId).toBe(w.source[0]!.id);
  const publishTool = await registerSlice1Tool(db, w.companyId, "local-publish", { artifactContract: slice1PublicationContract() });
  const verifyTool = await registerSlice1Tool(db, w.companyId, "local-publish-verify", { artifactContract: slice1VerifyContract() });
  await grantSlice1Tool(db, w.companyId, w.agentId, publishTool.id);
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  const units = [
    slice1Unit(w.agentId, "collect", "Collect sources", { sourceStepId: w.source[0]!.id, dependencies: [] }),
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[1]!.id, graphWorkProductRequired: true, dependencies: ["collect"] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", sourceStepId: w.source[2]!.id, dependencies: ["write"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true,
      dependencies: ["check", "write"], workProductSelectors: { write: documentSelector("report.md") },
      toolArgs: { content: "{$steps.write.workProductPath}" } }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  // 유형1 내용 수정: 지시/해석 입력만 바뀐 write 는 modify, 무관 collect 는 재사용 후보,
  // 필요한 새 QA/publish/readback 은 재실행 대상으로 남는다(계획 기록, seed 승인 아님).
  const contentDelta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "write", operation: "modify", sourceStepId: w.source[1]!.id, instructions: "요약 톤을 간결하게", interpretedInputs: { tone: "concise" } },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id },
    { unitId: "publish", operation: "rerun" },
    { unitId: "verify", operation: "rerun" },
  ]);
  const first = await w.submit(slice1Decision(w.revision.id, units, contentDelta));
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  expect(await activePlanRefs(db, w.companyId, w.revision.id)).toEqual(expect.objectContaining({ revisionDelta: contentDelta })); // RED
  await w.approve(first);
  expect(await w.submit(slice1Decision(w.revision.id, units, contentDelta))).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const writeStep = steps.find(s => s.sourceStepId === w.source[1]!.id);
  const checkStep = steps.find(s => s.sourceStepId === w.source[2]!.id);
  const publishStep = steps.find(s => (s.toolNames ?? []).includes("local-publish"));
  expect(writeStep).toBeTruthy();
  expect(checkStep?.type).toBe("qa"); // QA 의 sourceStepId 대응은 정상 경로다.
  expect(publishStep).toBeTruthy();
  // 물화는 현재 템플릿 연결(report.md selector, native token)을 새 단계 ID 로 재매핑한다.
  expect(publishStep!.workProductSelectors).toEqual({ [writeStep!.id]: documentSelector("report.md") });
  expect(publishStep!.toolArgs).toEqual({ content: `{$steps.${writeStep!.id}.workProductPath}` });
  expect(steps.some(s => s.type === "qa" && s.sourceStepId === undefined)).toBe(true); // 미션 최종 QA 는 새로 실행
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).toEqual([]); // 게시 시작은 별도 승인
  // 유형1 게시 조건만 변경: 본문(collect/write)은 재사용 후보로 유지된다.
  const publishOnlyDelta = w.delta([
    { unitId: "collect", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "write", operation: "reuse", sourceStepId: w.source[1]!.id },
    { unitId: "check", operation: "rerun", sourceStepId: w.source[2]!.id },
    { unitId: "publish", operation: "modify", interpretedInputs: { visibility: "private" } },
    { unitId: "verify", operation: "rerun" },
  ]);
  expect(await w.submit(slice1Decision(w.revision.id, units, publishOnlyDelta))).toMatchObject({ status: "plan_qa_pending" });
  expect(await activePlanRefs(db, w.companyId, w.revision.id)).toEqual(expect.objectContaining({ revisionDelta: publishOnlyDelta })); // RED
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).toEqual([]);
  const planQaBefore = await openPlanQaIssueIds(db, w.revision.id);
  const unknown = await w.submit(slice1Decision(w.revision.id, units, { ...contentDelta, schemaVersion: "mission-revision-delta.v999" }));
  expect(unknown.status).toBe("invalid"); // RED: 오늘은 무시되고 대기로 들어간다
  expect(diagnosticsOf(unknown)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mission_revision_delta_invalid" })])); // RED
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual(planQaBefore); // RED: 거부는 PLAN-QA 를 만들지 않는다
  const contradictoryDelta = { ...contentDelta,
    units: contentDelta.units.map(u => (u.unitId === "write" ? { ...u, operation: "reuse" } : u)) }; // 재사용 후보인데 해석 입력이 변경됨
  const contradictory = await w.submit(slice1Decision(w.revision.id, units, contradictoryDelta));
  expect(contradictory.status).toBe("invalid"); // RED
  expect(diagnosticsOf(contradictory)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mission_revision_delta_invalid" })])); // RED
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual(planQaBefore); // RED
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  const rejected = rows.filter(r => r.status === "rejected");
  expect(rejected).toHaveLength(2); // RED: 거부된 원장 행
  expect(rejected.every(r => (r.diagnostics as Array<{ code: string }>).some(d => d.code === "mission_revision_delta_invalid"))).toBe(true); // RED
});

it("type3 capability gap: registration alone is never success and an unsatisfied capability blocks the plan durably", async () => {
  const w = await slice1World(db, root, [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }],
    agentId => [
      { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: "tpl-publish", name: "Publish", type: "agent", agentId, dependencies: ["tpl-write"], graphWorkProductRequired: true,
        toolNames: ["tistory-publish"], toolArgs: { content: "{$steps.tpl-write.workProductPath}" } },
      { id: "tpl-verify", name: "Verify", type: "agent", agentId, dependencies: ["tpl-publish"],
        toolNames: ["local-publish-verify"], toolArgs: { qaResultPath: "{$steps.tpl-publish.workProductPath}" } },
    ]);
  const verifyTool = await registerSlice1Tool(db, w.companyId, "local-publish-verify", { artifactContract: slice1VerifyContract() });
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  const capabilityRequirements = [{ unitId: "publishBlog", requiredOutcomeId: "blog-published", toolName: "tistory-publish", capability: "blog_publish" }];
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", dependencies: ["write"] }),
    slice1Unit(w.agentId, "publishBlog", "Publish to blog", { toolNames: ["tistory-publish"], graphWorkProductRequired: true,
      dependencies: ["check"], workProductSelectors: { write: documentSelector("report.md") }, toolArgs: { content: "{$steps.write.workProductPath}" } }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publishBlog"],
      toolArgs: { qaResultPath: "{$steps.publishBlog.workProductPath}" } }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "check", operation: "rerun" },
    { unitId: "publishBlog", operation: "add" },
    { unitId: "verify", operation: "add" },
  ], { capabilityRequirements }));
  const missing = await w.submit(decision());
  expect(missing.status).toBe("invalid"); // 회귀 보호(기존 진단)
  expect(diagnosticsOf(missing)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "workflow_tool_unavailable" })]));
  const tool = await registerSlice1Tool(db, w.companyId, "tistory-publish", { artifactContract: slice1PublicationContract() }, false);
  const disabled = await w.submit(decision());
  expect(disabled.status).toBe("invalid");
  expect(diagnosticsOf(disabled)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "workflow_tool_disabled" })]));
  await db.update(toolDefinitions).set({ enabled: true }).where(eq(toolDefinitions.id, tool.id));
  const ungranted = await w.submit(decision());
  expect(ungranted.status).toBe("invalid");
  expect(diagnosticsOf(ungranted)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "workflow_tool_not_granted_to_assignee" })]));
  await grantSlice1Tool(db, w.companyId, w.agentId, tool.id);
  const gap = await w.submit(decision());
  expect(gap.status).toBe("invalid"); // RED: 요구 capability 불충족이 구조화 거절로 남지 않는다
  expect(diagnosticsOf(gap)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_capability_gap", message: expect.stringContaining("blog_publish") })])); // RED
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows).toHaveLength(1); // 같은 decision hash → 단일 원장 행
  expect(rows[0]!.status).toBe("rejected"); // RED: 오늘은 plan_qa_pending
  expect((rows[0]!.decision as { revisionDelta?: { capabilityRequirements?: unknown[] } }).revisionDelta?.capabilityRequirements)
    .toEqual(capabilityRequirements); // 요청 결과는 차단되어도 지워지지 않는다
  expect(await findPaqoDefinition(db, w.companyId, w.revision.id)).toBeNull(); // 부분 물화 없음
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).toEqual([]);
  const [sourceDefinition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, w.definition.id));
  expect(sourceDefinition!.stepsJson).toEqual(w.source); // 원본 정의 snapshot 불변
  await db.update(toolDefinitions)
    .set({ adapterConfig: { artifactContract: slice1PublicationContract(), capabilities: ["blog_publish"] } })
    .where(eq(toolDefinitions.id, tool.id));
  expect(await w.submit(decision())).toMatchObject({ status: "plan_qa_pending" }); // 정상 대조군
});

