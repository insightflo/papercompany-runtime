// server/src/__tests__/mission-revision-scoped-block.test.ts
//
// [슬라이스 Q4 — 부분진행 + toolNames 결합 + 최소 UI 데이터] 변경지도 Q4: 기능 부족 단위 하나가 계획
//   전체를 invalid 로 만드는 기존 경로는 그대로 두고, 변경안(mission-revision-delta.v1) 이 그 단위를
//   operation:"blocked" 로 명시적으로 선언했을 때의 행동만 추가한다.
//   (a) 차단 단위는 구조화 결과(revisionBlockedUnits — 실제 toolNames 진단)로 남고 실행 그래프에서
//       제외되며, 독립 형제 단위는 제출→PLAN-QA→승인→물화를 그대로 진행한다.
//   (b) 기능 진단은 단위가 실제 사용하는 toolNames 와 결합된다(요구 도구≠실제 도구 → 계약 위반 거절,
//       blocked 미선언 기능 부족 → 기존 전체 거절 유지, 차단 결과는 실제 도구 이름 지침).
//   (c) 부정: 차단 도구의 물화 스텝/실행(대체 게시)·전체완료 실행 기록 0건.
//   (d) 진행 단위가 차단 단위를 의존/실행인자로 참조하면 조용히 끊지 않고 전체 거절.
// 판정 근거는 문구가 아니라 record 결과·mission_plan_decision_submissions·활성 plan refs·물화 정의다.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, missionPlanDecisionSubmissions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, diagnosticsOf, grantSlice1Tool, openPlanQaIssueIds, paqoDefinitionSteps, registerSlice1Tool,
  slice1Decision, slice1Unit, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-scoped-block-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-scoped-block-")));
  // 실행 경계 스텁: 이 슬라이스는 게시 시작 없이 검증/차단/물화까지만 다룬다(실제 호출되면 안 된다).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision scoped block"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

const noRevisionRuns = (missionId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));

// 현재 템플릿: tpl-write + 게시 계열 tpl 단계(도구 이름만 다름). 원본은 write 1단계 완료.
const publishTemplate = (agentId: string, toolNames: string[]) => [
  { id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
  ...toolNames.map((toolName, index) => ({ id: `tpl-publish-${index + 1}`, name: `Publish ${index + 1}`, type: "agent",
    agentId, dependencies: ["tpl-write"], graphWorkProductRequired: true, toolNames: [toolName],
    toolArgs: { content: "{$steps.tpl-write.workProductPath}" } })),
];
const sourceUnits = [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }];

it("(a) declared-blocked capability gap unit stays durably blocked while the independent sibling proceeds", async () => {
  const w = await slice1World(db, root, sourceUnits, agentId => publishTemplate(agentId, ["tistory-publish"]));
  // 도구는 등록·활성·담당자 부여되어 있으나 blog_publish 기능을 제공하지 않는다(기능 부족).
  const tool = await registerSlice1Tool(db, w.companyId, "tistory-publish", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, tool.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "publishBlog", "Publish to blog", { toolNames: ["tistory-publish"], graphWorkProductRequired: true,
      dependencies: ["write"], toolArgs: { content: "{$steps.write.workProductPath}" } }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "publishBlog", operation: "blocked" },
  ], { capabilityRequirements: [{ unitId: "publishBlog", requiredOutcomeId: "blog-published", toolName: "tistory-publish", capability: "blog_publish" }] }));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 부분진행 — 전체 invalid 가 아니다
  const refs = await activePlanRefs(db, w.companyId, w.revision.id);
  expect(refs.revisionDelta).toBeDefined(); // 요청 변경안 보존
  expect(refs.revisionBlockedUnits).toEqual([expect.objectContaining({
    unitId: "publishBlog", toolName: "tistory-publish", code: "mission_revision_capability_gap",
    message: expect.stringContaining("blog_publish"),
  })]); // (b) 구조화 gap 은 실제 toolName(tistory-publish) 을 정확히 지칭한다
  expect((refs.revisionBlockedUnits as Array<{ message: string }>)[0]!.message).toContain("tistory-publish");
  await w.approve(first);
  expect(await w.submit(decision())).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  expect(steps.some(s => s.sourceStepId === w.source[0]!.id)).toBe(true); // 형제 단위는 진행(부당 차단 아님)
  expect(steps.some(s => s.type === "qa" && s.sourceStepId === undefined)).toBe(true); // 미션 최종 QA 는 새로 실행
  expect(steps.every(s => !(s.toolNames ?? []).includes("tistory-publish"))).toBe(true); // 금지 도구 물화 0
  expect(await noRevisionRuns(w.revision.id)).toEqual([]); // (c) 대체 게시/전체완료 실행 기록 없음
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("recorded"); // (c) 거부 아닌 부분진행 승인 기록
  expect(rows[0]!.rejectionReason).toBeNull();
  // 내구성·표시 데이터: 승인·물화 뒤에도 활성 계획 refs 차단 결과가 시작 옵션에 표시 행으로 노출된다.
  const options = await revisionStartOptions(db, w.companyId, w.revision.id);
  expect(options).not.toBeNull();
  expect(options!.blockedUnits).toEqual([expect.objectContaining({
    unitId: "publishBlog", code: "mission_revision_capability_gap", toolName: "tistory-publish",
  })]);
});

it("(b) capability diagnostics bind to the unit's actual toolNames; undeclared gaps keep rejecting the whole plan", async () => {
  const w = await slice1World(db, root, sourceUnits, agentId => publishTemplate(agentId, ["tistory-publish"]));
  const gapTool = await registerSlice1Tool(db, w.companyId, "tistory-publish", {});
  const neutralTool = await registerSlice1Tool(db, w.companyId, "local-neutral", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, gapTool.id);
  await grantSlice1Tool(db, w.companyId, w.agentId, neutralTool.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "publishBlog", "Publish to blog", { toolNames: ["local-neutral"], graphWorkProductRequired: true, dependencies: ["write"] }),
  ];
  // 요구 도구(tistory-publish) 가 단위의 실제 toolNames(local-neutral) 에 없으면 계약 위반 거절.
  const mismatch = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "publishBlog", operation: "add" },
  ], { capabilityRequirements: [{ unitId: "publishBlog", requiredOutcomeId: "blog-published", toolName: "tistory-publish", capability: "blog_publish" }] })));
  expect(mismatch.status).toBe("invalid");
  expect(diagnosticsOf(mismatch)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_delta_invalid", message: expect.stringContaining("local-neutral") })]));
  // blocked 미선언 단위의 기능 부족은 기존 전체 거절을 그대로 유지한다(진단은 실제 도구 이름 지침).
  const gap = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "publishBlog", operation: "add" },
  ], { capabilityRequirements: [{ unitId: "publishBlog", requiredOutcomeId: "blog-published", toolName: "local-neutral", capability: "blog_publish" }] })));
  expect(gap.status).toBe("invalid");
  expect(diagnosticsOf(gap)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_capability_gap", message: expect.stringContaining("local-neutral") })]));
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual([]); // 거부는 PLAN-QA 를 만들지 않는다
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
});

it("(b) blocked-unit tool diagnostics are structured per actual toolName: missing/disabled/no-permission", async () => {
  const w = await slice1World(db, root, sourceUnits,
    agentId => publishTemplate(agentId, ["tistory-missing", "tistory-disabled", "tistory-ungranted"]));
  await registerSlice1Tool(db, w.companyId, "tistory-disabled", {}, false); // 등록·비활성
  await registerSlice1Tool(db, w.companyId, "tistory-ungranted", {}); // 등록·활성·미부여
  // tistory-missing 은 미등록 — 기존 경로라면 배치 검사에서 전체 거절이었다.
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "pubMissing", "Publish missing", { toolNames: ["tistory-missing"], dependencies: ["write"] }),
    slice1Unit(w.agentId, "pubDisabled", "Publish disabled", { toolNames: ["tistory-disabled"], dependencies: ["write"] }),
    slice1Unit(w.agentId, "pubUngranted", "Publish ungranted", { toolNames: ["tistory-ungranted"], dependencies: ["write"] }),
  ];
  const decision = () => slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "pubMissing", operation: "blocked" },
    { unitId: "pubDisabled", operation: "blocked" },
    { unitId: "pubUngranted", operation: "blocked" },
  ]));
  const first = await w.submit(decision());
  expect(first).toMatchObject({ status: "plan_qa_pending" }); // 차단 선언 단위는 사전 거절 대상이 아니다
  const outcomes = (await activePlanRefs(db, w.companyId, w.revision.id)).revisionBlockedUnits as Array<Record<string, unknown>>;
  const byCode = new Map<string, Record<string, unknown>>(outcomes.map(outcome => [outcome.code as string, outcome]));
  expect(byCode.get("workflow_tool_unavailable")).toMatchObject({ unitId: "pubMissing", toolName: "tistory-missing" });
  expect(byCode.get("workflow_tool_disabled")).toMatchObject({ unitId: "pubDisabled", toolName: "tistory-disabled" });
  expect(byCode.get("workflow_tool_not_granted_to_assignee")).toMatchObject({ unitId: "pubUngranted", toolName: "tistory-ungranted" });
  await w.approve(first);
  await w.submit(decision());
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  expect(steps.some(s => s.sourceStepId === w.source[0]!.id)).toBe(true); // 형제 진행
  expect(steps.every(s => (s.toolNames ?? []).every(name => !name.startsWith("tistory-")))).toBe(true); // 금지 도구 0
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
});

it("(d) a proceeding unit referencing a blocked unit is rejected instead of silently dropping the link", async () => {
  const w = await slice1World(db, root, sourceUnits, agentId => publishTemplate(agentId, ["tistory-missing"]));
  const verifyTool = await registerSlice1Tool(db, w.companyId, "verify-neutral", {});
  await grantSlice1Tool(db, w.companyId, w.agentId, verifyTool.id);
  const units = [
    slice1Unit(w.agentId, "write", "Write report", { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "publishBlog", "Publish to blog", { toolNames: ["tistory-missing"], dependencies: ["write"] }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["verify-neutral"], dependencies: ["publishBlog"],
      toolArgs: { qaResultPath: "{$steps.publishBlog.workProductPath}" } }),
  ];
  const rejected = await w.submit(slice1Decision(w.revision.id, units, w.delta([
    { unitId: "write", operation: "reuse", sourceStepId: w.source[0]!.id },
    { unitId: "publishBlog", operation: "blocked" },
    { unitId: "verify", operation: "add" },
  ])));
  expect(rejected.status).toBe("invalid");
  expect(diagnosticsOf(rejected)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "mission_revision_blocked_unit_dependency", message: expect.stringContaining("publishBlog") })]));
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual([]);
  expect(await noRevisionRuns(w.revision.id)).toEqual([]);
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows.every(row => row.status === "rejected")).toBe(true);
});
