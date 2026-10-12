// server/src/__tests__/mission-owner-plan-execution.integration.test.ts
//
// [Stage 5 — revise_plan 실제 파이프라인] 오너의 revise_plan 요청이 기존 native 계획 체인 전체를
//   통해 실제 실행까지 이어지는 것을 증명한다: 오너 intent(실제 builtin 도구 호출) → 구조적 제출
//   (submitMissionOwnerPlanDecision → 검증/PLAN-QA 게이트) → 독립 PLAN-QA verdict 제출(별도 actor,
//   실제 verdict API) → materialization → native run 생성·실행 → 실제 로컬 도구 실행
//   (processQueuedWorkflowToolStepRuns → executor → 실제 command) → 등록 영수증/readback.
//   손으로 definition을 seed해서 통과하는 테스트가 아니다. 거부: QA 누락/old hash/반려 → run 0건,
//   다른 owner → 사전 거부, sourceMissionId → board_revision_start, QA와 시작 사이 intent 변경 → 시작 없음.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, heartbeatRuns, issues, missionPlanDecisionSubmissions,
  missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { slice1Decision, slice1Unit, slice1World } from "./helpers/mission-revision-slice1-world.js";
import { workProductService } from "../services/work-products.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-plan-exec-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-plan-exec-")));
  // 모형 검수 도구: stdin 봉투의 콘텐츠 다이제스트를 확인하고 fd4 기계 채널로만 결과를 쓴다.
  await writeFile(path.join(root, "qa.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`);
  // app.ts 운영 executor 와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록.
  setWorkflowToolStepExecutor(async (request) => {
    const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId,
      agentName: request.agentName, toolName: request.toolName, parameters: request.args ?? {},
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId,
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepId: request.stepId,
      toolName: request.toolName, success: coreResult.status === 200, stdout: coreResult.body.content ?? "",
      data: coreResult.body.data, stderr: coreResult.body.stderr ?? "", exitCode: coreResult.status === 200 ? 0 : 1,
      artifactPath: coreResult.artifactPath, toolArtifactReceipt: coreResult.toolArtifactReceipt,
      error: coreResult.body.error });
    return { accepted: true as const };
  });
}, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const qaContract: ArtifactContract = { role: "qa", resultFileName: "inspection.json", resultAdapter: "generic",
  resultSchemaVersion: "workflow.qa-result.v1", inputParams: { content: "document" }, deploymentFiles: ["qa.mjs"],
  inputEnvelopeVersion: "workflow.artifact-input.v1" };
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// 독립 PLAN-QA verdict 제출(별도 actor): 실제 verdict API 경로를 그대로 쓴다.
const qaVerdict = (companyId: string, missionId: string, planQaIssueId: string, verdict: "pass" | "request_changes" = "pass") =>
  submitMissionPlanQaVerdict({ db, issue: { id: planQaIssueId, companyId, missionId, originKind: "mission_plan_qa" },
    actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null }, data: { verdict, diagnostics: [] } });

async function world() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "OwnerPlan", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
  const tools = await db.insert(toolDefinitions).values([
    { companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId, name: "plan-qa-check", adapterType: "builtin", description: "Mock artifact tool",
      adapterConfig: { command: `${process.execPath} ${path.join(root, "qa.mjs")}`, workingDirectory: root,
        capabilities: ["structural_validation_v1"], artifactContract: qaContract } },
  ]).returning();
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId, agentId, toolId: tool.id, grantedBy: "test" })));
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Owner plan", status: "active" }).returning();
  const [planning] = await db.insert(issues).values({ companyId, missionId: mission.id, title: "PLAN",
    originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: agentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId: mission.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId: planning.id, status: "succeeded" });
  await mkdir(path.join(root, "missions", mission.id), { recursive: true });
  const decision = (goal = "Owner revised plan") => ({ missionId: mission.id, missionGoal: goal, selectedPlanTemplateIds: [],
    selectedExecutionUnits: [
      { id: "write", title: "Write", selectionState: "selected", reason: "unit", assigneeAgentId: agentId,
        sourceRef: { type: "mission_plan_unit", id: "write" }, graphWorkProductRequired: true, dependencies: [] },
      { id: "check", title: "Check", selectionState: "selected", reason: "unit", assigneeAgentId: agentId,
        sourceRef: { type: "mission_plan_unit", id: "check" }, type: "tool", qaType: "structural",
        toolNames: ["plan-qa-check"], toolArgs: { document: "{$steps.write.workProductPath}" },
        workProductSelectors: { write: { type: "document", title: "content.json" } },
        toolArtifactContract: { schemaVersion: "workflow.qa-result.v1", role: "qa", inputStepId: "write" },
        dependencies: ["write"] },
    ], ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    assessment: { objectiveRestatement: "Owner plan", availableAssetsReviewed: [], assetEvaluation: [], gaps: [], researchPerformed: [] } });
  const body = (d = decision()) => ({ schemaVersion: 1 as const, missionId: mission.id, ownerActionIssueId: planning.id,
    actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "revise_plan" as const, plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision: d } } });
  const call = (b: unknown, caller?: { agentId: string; heartbeatRunId: string }) =>
    executeCoreWorkflowTool({ db, companyId, agentId: caller?.agentId ?? agentId,
      heartbeatRunId: caller?.heartbeatRunId ?? heartbeatRunId, toolName: "mission_owner_execute",
      parameters: b, requestId: randomUUID() });
  const runs = () => db.select().from(workflowRuns).where(eq(workflowRuns.missionId, mission.id));
  return { companyId, agentId, mission, planning, heartbeatRunId, decision, body, call, runs };
}
const pending = (response: { body: { data?: unknown } }) => record(record(response.body).data) as unknown as {
  actionId: string; state: string; reasonCode: string; requiredAction: { kind: string; targetId: string } };

it("[GREEN] owner revise_plan runs the real chain: submission → independent PLAN-QA → native run → real tool → resolved readback", async () => {
  const w = await world();
  const body = w.body();
  const first = await w.call(body);
  expect(first.status).toBe(200);
  const action = pending(first);
  expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending", requiredAction: { kind: "submit_qa_verdict" } });
  expect(await w.runs()).toEqual([]); // QA 누락 → run 시작 없음
  // raw 제출 원문과 canonical projection: 원장은 raw 를 보존하고 활성 refs 는 같은 decisionHash 에 고정한다.
  const [ledger] = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.mission.id));
  expect(ledger.decision).toEqual(w.decision());
  const refs = record((await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.mission.id }))?.refs);
  expect(record(refs.planQa).decisionHash).toBe(ledger.decisionHash);
  // 독립 PLAN-QA pass(별도 actor, 실제 verdict API) → materialization → native run 생성·실행
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId);
  const [run] = await w.runs();
  expect(run).toBeTruthy();
  expect(run!.metadata).toMatchObject({ ownerPlanExecution: { decisionHash: ledger.decisionHash } }); // action correlation 저장
  // 물화된 정의의 생성 step id(action-N-<hash>, qa-<hash>)로 스텝런을 식별한다.
  const rows = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.mission.id));
  const defSteps = (definition!.stepsJson ?? []) as Array<{ id: string; toolNames?: string[] }>;
  const toolStepId = defSteps.find((st) => (st.toolNames ?? []).includes("plan-qa-check"))!.id;
  // agent 생산 단계: 이번 실행이 발사한 실제 이슈 → 승인 생산자 → 산출물 등록 → 완료
  const completeAgentStep = async (step: typeof workflowStepRuns.$inferSelect, name: string) => {
    if (!step.issueId) throw new Error(`${name} was not dispatched as this run's own work item`);
    const heartbeat = randomUUID();
    await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, step.id));
    await admittedProducer(db, { companyId: w.companyId, agentId: w.agentId, issueId: step.issueId, stepRunId: step.id, heartbeatId: heartbeat });
    const file = path.join(root, "missions", w.mission.id, name, "content.json"), bytes = Buffer.from(`{"blocks":["${name}"]}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await workProductService(db).createForIssue(step.issueId, w.companyId, { provider: "local_file", type: "document",
      title: "content.json", status: "active", createdByRunId: heartbeat, metadata: { path: file, sha256: sha(bytes) } });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, step.issueId));
    // QA 성격 이슈는 구조적 검증 판정 원장(workflow_api pass)이 완료를 소유한다. 생산(action) 이슈에는 no-op 다.
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, step.issueId));
    await recordWorkflowValidationVerdict({ db, issue: qaIssue!, verdict: "pass", source: "workflow_api",
      actorAgentId: w.agentId, heartbeatRunId: heartbeat });
    // 스텝 완료는 엔진의 이슈-상태 동기화(syncStepRunsFromIssueState)가 소유한다 — 수동 완료 기록은
    // 구조 게이트의 producer 토큰/세대 기록과 어긋나 재큐 루프를 만든다.
  };
  const write = (await rows()).find((r) => r.issueId !== null && r.stepId !== toolStepId)!;
  await completeAgentStep(write, "write");
  await syncWorkflowRunState(db, run.id); // 생산자 완료(이슈 done) 동기화 → 게이트 발사·큐잉
  const dispatch = await processQueuedWorkflowToolStepRuns(db);
  expect(dispatch.executedCount).toBeGreaterThanOrEqual(1); // 실제 로컬 도구 실행
  const check = (await rows()).find((r) => r.stepId === toolStepId)!;
  expect(check.status).toBe("completed");
  const receipt = record(record(check.metadata).toolArtifactReceipt);
  expect(receipt).toMatchObject({ role: "qa", workflowRunId: run.id, stepRunId: check.id, missionId: w.mission.id,
    requestId: check.lastDispatchRequestId }); // 등록 영수증 = 현재 실행/시도에 결합
  // 미션 마지막 QA 이슈 스텝도 같은 실제 생산자 경로로 마감한다(전체 스텝 완료 → run 완료).
  await syncWorkflowRunState(db, run.id); // 게이트 완료 동기화 → 마지막 QA 이슈를 발사한다
  const finalQa = (await rows()).find((r) => r.issueId !== null && r.id !== write.id)!;
  await completeAgentStep(finalQa, "final-qa");
  await syncWorkflowRunState(db, run.id);
  const resolved = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId },
    { schemaVersion: 1, missionId: w.mission.id, actionId: action.actionId });
  expect(resolved).toMatchObject({ state: "resolved", operation: "revise_plan" });
  expect(resolved.evidence).toContainEqual(expect.objectContaining({ kind: "plan", recordId: ledger.decisionHash, workflowRunId: run.id }));
}, 60000);

it("[RED] request_changes PLAN-QA never starts a run and demands a corrected plan", async () => {
  const w = await world();
  const body = w.body();
  const action = pending(await w.call(body));
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId, "request_changes");
  expect(await w.runs()).toEqual([]);
  const projected = await w.call(body); // 같은 요청 재전송 → 투영만
  expect(projected.status).toBe(200);
  expect(pending(projected)).toMatchObject({ actionId: action.actionId, state: "blocked",
    reasonCode: "plan_qa_changes_requested", requiredAction: { kind: "submit_corrected_plan" } });
  expect(await w.runs()).toEqual([]);
}, 60000);

it("[RED] a stale PLAN-QA verdict for a superseded decision hash is refused without starting a run", async () => {
  const w = await world();
  const first = pending(await w.call(w.body()));
  const second = await w.call(w.body(w.decision("Owner revised plan v2")));
  expect(pending(second)).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending" });
  await expect(qaVerdict(w.companyId, w.mission.id, first.requiredAction.targetId)).rejects.toThrow(); // old hash 는 활성 planQa 가 아니다
  expect(await w.runs()).toEqual([]);
  const superseded = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId },
    { schemaVersion: 1, missionId: w.mission.id, actionId: first.actionId });
  expect(superseded).toMatchObject({ state: "superseded" });
}, 60000);

it("[RED] an owner intent change between PLAN-QA and run start blocks the start", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  // 같은 오너 이슈에 더 최신 intent 가 기록됐다(구조적으로 facade 가 쓰는 것과 같은 형태의 행).
  await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.mission.id, issueId: w.planning.id,
    heartbeatRunId: w.heartbeatRunId, eventType: "owner_execute_intent_v1", layer: "mission_owner_authority",
    reason: "mission_owner_execute", reasonCode: "mission_owner_execute",
    idempotencyKey: `mission-owner-execute:v1:${w.companyId}:${w.mission.id}:${w.planning.id}:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: w.mission.id, ownerActionIssueId: w.planning.id,
      actionRequestId: randomUUID(), heartbeatRunId: w.heartbeatRunId, agentId: w.agentId,
      action: { operation: "retry_step", target: { kind: "tool_step", workflowRunId: randomUUID(), stepRunId: randomUUID(),
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } }, bodyFingerprint: randomUUID() } });
  await expect(qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId)).rejects.toThrow("owner_plan_start_intent_stale");
  expect(await w.runs()).toEqual([]); // QA와 실제 시작 사이 intent 변경 → 시작 없음
}, 60000);

it("[RED] a non-owner caller is refused before any submission", async () => {
  const w = await world();
  const otherAgentId = randomUUID();
  await db.insert(agents).values({ id: otherAgentId, companyId: w.companyId, name: "Not Owner", role: "operator",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  const tools = await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, w.companyId));
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId: w.companyId, agentId: otherAgentId, toolId: tool.id, grantedBy: "test" })));
  const otherHeartbeat = randomUUID();
  await db.insert(heartbeatRuns).values({ id: otherHeartbeat, companyId: w.companyId, agentId: otherAgentId, issueId: w.planning.id, status: "succeeded" });
  const refused = await w.call(w.body(), { agentId: otherAgentId, heartbeatRunId: otherHeartbeat });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("not_mission_owner");
  const otherCompany = await executeCoreWorkflowTool({ db, companyId: randomUUID(), agentId: w.agentId,
    heartbeatRunId: w.heartbeatRunId, toolName: "mission_owner_execute", parameters: w.body(), requestId: randomUUID() });
  expect(otherCompany.status).toBe(404); // 다른 회사 스코프에는 이 도구가 없다 — 사전 거부
  expect((await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.mission.id))).length).toBe(0);
  expect(await w.runs()).toEqual([]);
}, 60000);

it("[GREEN] a revision mission (sourceMissionId) keeps the board fresh/seed boundary", async () => {
  const w = await slice1World(db, root, [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }],
    (agentId) => [{ id: "tpl-write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true }]);
  const [ownerTool] = await db.insert(toolDefinitions).values({ companyId: w.companyId, name: "mission_owner_execute",
    adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }).returning();
  await db.insert(agentToolGrants).values({ companyId: w.companyId, agentId: w.agentId, toolId: ownerTool.id, grantedBy: "test" });
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: w.companyId, agentId: w.agentId, issueId: w.planning.id, status: "succeeded" });
  const decision = slice1Decision(w.revision.id, [slice1Unit(w.agentId, "write", "Write report",
    { sourceStepId: w.source[0].id, graphWorkProductRequired: true, dependencies: [] })],
    w.delta([{ unitId: "write", operation: "rerun", sourceStepId: w.source[0].id }]));
  const first = await executeCoreWorkflowTool({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId,
    toolName: "mission_owner_execute", parameters: { schemaVersion: 1, missionId: w.revision.id, ownerActionIssueId: w.planning.id,
      actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
      action: { operation: "revise_plan", plan: { planningIssueId: w.planning.id, expectedDecisionHash: null, decision } } }, requestId: randomUUID() });
  expect(first.status).toBe(200);
  const action = pending(first);
  expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending" });
  const [planQaIssue] = await db.select().from(issues).where(and(eq(issues.missionId, w.revision.id), eq(issues.originKind, "mission_plan_qa")));
  await qaVerdict(w.companyId, w.revision.id, planQaIssue.id); // 독립 QA pass → materialization 은 board 경계에서 멈춘다
  const projected = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId },
    { schemaVersion: 1, missionId: w.revision.id, actionId: action.actionId });
  expect(projected).toMatchObject({ state: "blocked", reasonCode: "board_revision_start_required",
    requiredAction: { kind: "board_revision_start" } });
  expect((await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.revision.id))).length).toBe(0);
}, 60000);
