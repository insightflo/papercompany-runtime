// server/src/__tests__/mission-revision-slice1-io.test.ts
//
// [슬라이스1 RED — 유형2] 승인된 변경지도 1단계의 R2/R3/R5 중 입력/작업 추가(A 유지 + B 신규)를
// 공개 제출(submitMissionOwnerPlanDecision → record → 검증/PLAN-QA → 물화)의 실제 결과로 검증한다.
// A/B 타깃 식별·재매핑 판정은 서버가 생성한 paqo workflow definition(stepsJson)에서 literal 로 읽는다.
// 의도된 RED(후속 구현 work가 통과시킴):
//  - delta 가 선언한 필수 입력 연결(B)이 계획에서 누락돼도 구조화 거절되지 않는다.
//  - 서로 다른 alias 가 같은 생산자로 합쳐지는 모호성이 비구조 throw 로 새어나간다.
// 회귀 보호(오늘 green): A/B 서로 다른 타깃 ID + B URL 보존 + synth 의 selectors/native tokens
// 가 두 ID 를 정확히 가리킴, 같은 title 이라도 다른 생산자면 허용, 게시 확인 도구 누락 거절.
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, missionPlanDecisionSubmissions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  activePlanRefs, diagnosticsOf, documentSelector, grantSlice1Tool, openPlanQaIssueIds, paqoDefinitionSteps,
  registerSlice1Tool, slice1Decision, slice1PublicationContract, slice1Unit, slice1VerifyContract, slice1World,
} from "./helpers/mission-revision-slice1-world.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-slice1-io-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-slice1-io-")));
  // 외부 도구 실행 경계 스텁: 슬라이스1은 게시 시작 없이 검증/물화까지만 다룬다(실제 호출되면 안 된다).
  setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected workflow tool step execution in revision slice1"); }); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it("type2 A+B keeps distinct server targets wired; missing B link and alias merge are structured rejections", async () => {
  const urlA = "https://youtu.test/A", urlB = "https://youtu.test/B";
  const w = await slice1World(db, root, [
    { id: "collectA", title: "Collect A", toolNames: ["local-youtube"], toolArgs: { url: urlA }, graphWorkProductRequired: true, dependencies: [] },
  ], agentId => [
    { id: "tpl-collect", name: "Collect", type: "agent", agentId, dependencies: [], toolNames: ["local-youtube"],
      toolArgs: { url: urlA }, graphWorkProductRequired: true },
    { id: "tpl-synth", name: "Synthesize", type: "agent", agentId, dependencies: ["tpl-collect"], graphWorkProductRequired: true },
    { id: "tpl-check", name: "Check", type: "qa", agentId, dependencies: ["tpl-synth"] },
    { id: "tpl-publish", name: "Publish", type: "agent", agentId, dependencies: ["tpl-check"], graphWorkProductRequired: true,
      toolNames: ["local-publish"] },
    { id: "tpl-verify", name: "Verify", type: "agent", agentId, dependencies: ["tpl-publish"],
      toolNames: ["local-publish-verify"], toolArgs: { qaResultPath: "{$steps.tpl-publish.workProductPath}" } },
  ]);
  expect(w.sourceStep.stepId).toBe(w.source[0]!.id);
  const youtubeTool = await registerSlice1Tool(db, w.companyId, "local-youtube", { command: "collect" });
  const publishTool = await registerSlice1Tool(db, w.companyId, "local-publish", { artifactContract: slice1PublicationContract() });
  const verifyTool = await registerSlice1Tool(db, w.companyId, "local-publish-verify", { artifactContract: slice1VerifyContract() });
  for (const tool of [youtubeTool, publishTool, verifyTool]) await grantSlice1Tool(db, w.companyId, w.agentId, tool.id);
  const reportJson = documentSelector("report.json");
  const synth = (selectors: Record<string, unknown>, toolArgs: Record<string, unknown>, dependencies: string[]) =>
    slice1Unit(w.agentId, "synth", "Synthesize A+B", { graphWorkProductRequired: true, dependencies, workProductSelectors: selectors, toolArgs });
  const units = (synthUnit: Record<string, unknown>) => [
    slice1Unit(w.agentId, "collectA", "Collect A", { sourceStepId: w.source[0]!.id, toolNames: ["local-youtube"],
      toolArgs: { url: urlA }, graphWorkProductRequired: true, dependencies: [] }),
    slice1Unit(w.agentId, "collectB", "Collect B", { toolNames: ["local-youtube"], toolArgs: { url: urlB },
      graphWorkProductRequired: true, dependencies: [] }), // 동일 도구 템플릿에서 온 B clone; sourceStepId 없음
    synthUnit,
    slice1Unit(w.agentId, "check", "Check report", { type: "qa", dependencies: ["synth"] }),
    slice1Unit(w.agentId, "publish", "Publish report", { toolNames: ["local-publish"], graphWorkProductRequired: true,
      dependencies: ["check"], workProductSelectors: { synth: reportJson }, toolArgs: { content: "{$steps.synth.workProductPath}" } }),
    slice1Unit(w.agentId, "verify", "Verify publication", { toolNames: ["local-publish-verify"], dependencies: ["publish"],
      toolArgs: { qaResultPath: "{$steps.publish.workProductPath}" } }),
  ];
  const delta = w.delta([
    { unitId: "collectA", operation: "rerun", sourceStepId: w.source[0]!.id },
    { unitId: "collectB", operation: "clone", templateStepId: "tpl-collect", interpretedInputs: { url: urlB } },
    { unitId: "synth", operation: "add", requiredInputs: [{ fromUnitId: "collectA", selector: reportJson }, { fromUnitId: "collectB", selector: reportJson }] },
    { unitId: "check", operation: "add" },
    { unitId: "publish", operation: "add" },
    { unitId: "verify", operation: "add" },
  ]);
  const both = synth({ collectA: reportJson, collectB: reportJson },
    { sourceA: "{$steps.collectA.workProductPath}", sourceB: "{$steps.collectB.workProductPath}" }, ["collectA", "collectB"]);
  const first = await w.submit(slice1Decision(w.revision.id, units(both), delta));
  expect(first).toMatchObject({ status: "plan_qa_pending" });
  await w.approve(first);
  expect(await w.submit(slice1Decision(w.revision.id, units(both), delta))).toMatchObject({ status: "recorded" });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const aStep = steps.find(s => s.sourceStepId === w.source[0]!.id);
  const bStep = steps.find(s => s.sourceStepId === undefined && (s.toolArgs as { url?: string } | undefined)?.url === urlB);
  const synthStep = steps.find(s => (s.toolArgs as { sourceB?: string } | undefined)?.sourceB !== undefined);
  expect(aStep).toBeTruthy();
  expect(bStep).toBeTruthy();
  expect(synthStep).toBeTruthy();
  expect(aStep!.id).not.toBe(bStep!.id); // A/B 타깃 ID 는 다르다
  expect(bStep!.toolArgs).toEqual({ url: urlB }); // B URL 은 보존된다
  expect(synthStep!.workProductSelectors).toEqual({ [aStep!.id]: reportJson, [bStep!.id]: reportJson }); // 같은 title, 다른 생산자 허용
  expect(synthStep!.toolArgs).toEqual({ sourceA: `{$steps.${aStep!.id}.workProductPath}`, sourceB: `{$steps.${bStep!.id}.workProductPath}` });
  expect(synthStep!.dependencies).toEqual(expect.arrayContaining([aStep!.id, bStep!.id]));
  expect.soft(await activePlanRefs(db, w.companyId, w.revision.id)).toEqual(expect.objectContaining({ revisionDelta: delta })); // RED(soft: 이 누락 RED 가 이후 음성군 단언 실행을 중단시키지 않음)
  const planQaBefore = await openPlanQaIssueIds(db, w.revision.id);
  // 음성군: B 필수 입력 연결 삭제 — delta 는 B 를 요구하지만 계획이 소비하지 않는다.
  const dropped = synth({ collectA: reportJson }, { sourceA: "{$steps.collectA.workProductPath}" }, ["collectA"]);
  const droppedResult = await w.submit(slice1Decision(w.revision.id, units(dropped), delta));
  expect(droppedResult.status).toBe("invalid"); // RED
  expect(diagnosticsOf(droppedResult)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mission_revision_delta_invalid" })])); // RED
  // 음성군: 서로 다른 alias(unit id 와 원본 step id)가 같은 생산자로 합쳐지는 모호성.
  const aliased = synth({ collectA: reportJson, [w.source[0]!.id]: reportJson },
    { sourceA: "{$steps.collectA.workProductPath}", sourceB: `{$steps.${w.source[0]!.id}.workProductPath}` }, ["collectA"]);
  const aliasedResult = await w.submit(slice1Decision(w.revision.id, units(aliased), delta)).then(result => result, () => null);
  expect(aliasedResult).toMatchObject({ status: "invalid",
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "mission_revision_unit_reference_ambiguous" })]) }); // RED(오늘은 비구조 throw)
  // 회귀 보호: 필요한 게시 확인 도구 삭제는 기존 위상 검사가 거부한다.
  const noVerify = units(both).filter(u => u.id !== "verify");
  const topology = await w.submit(slice1Decision(w.revision.id, noVerify, { ...delta, units: delta.units.filter(u => u.unitId !== "verify") }));
  expect(topology.status).toBe("invalid");
  expect(diagnosticsOf(topology)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_publication_verify_tool" })]));
  expect(await openPlanQaIssueIds(db, w.revision.id)).toEqual(planQaBefore); // RED: 무효 계획은 PLAN-QA 를 만들지 않는다
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).toEqual([]);
  const rows = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(rows.some(r => r.status === "rejected"
    && (r.diagnostics as Array<{ code: string }>).some(d => d.code === "mission_revision_delta_invalid"))).toBe(true); // RED
  expect(rows.some(r => r.status === "rejected"
    && (r.diagnostics as Array<{ code: string }>).some(d => d.code === "mission_revision_unit_reference_ambiguous"))).toBe(true); // RED
});
