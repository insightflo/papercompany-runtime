// server/src/__tests__/mission-owner-recollect.integration.test.ts
//
// [Stage 6 — recollect 실제 연결] 오너 재수집이 두 경로로 실제 실행되는 것을 실DB+실경로로 검증한다.
//   ① same_configuration: 선언 sourceRefs 가 frozen typed args 와 정확 일치할 때만 stage 1 exact
//      재시도로 실제 재실행되고 현재 결과만 읽힌다(옛 자료·"수집 완료" 댓글은 resolved 근거 불가).
//   ② changed_collection: add oneShot 계획 unit 이 stage 5 체인(제출→독립 PLAN-QA→물화)을 지나
//      board 시작 후 실제 수집 실행까지 이어지고 원본 periodic 정의·watermark 는 불변이다.
//   ③④⑤ 사전 검증 거부(구성 불일치·plan 누락·oneShot 배치 위반·권한 부족)는 부작용 0 이다.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, heartbeatRuns, issueComments, issues,
  missionPlanDecisionSubmissions, missions, toolDefinitions, workflowDefinitions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board } from "./helpers/workflow-seed-world.js";
import { paqoDefinitionSteps, slice1Decision, slice1Unit, slice1World } from "./helpers/mission-revision-slice1-world.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";

// core executor 는 toolArgs 를 CLI 인자로 명령 뒤에 붙인다 — 끝의 "--" 로 node 가 인자를 스크립트 인자로만 받게 한다.
const TOOL_COMMAND = `node -e "console.log(JSON.stringify({status:'success',attempt:'recollect-stage6-current'}))" --`;
// 구조 게이트(step 2) 도구 계약: 결과 data 에 구조 판정(verdict) 이 있어야 완료가 인정된다.
const GATE_COMMAND = `node -e "console.log(JSON.stringify({verdict:'pass',attempt:'recollect-stage6-current'}))" --`;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pending = (response: { body: { data?: unknown } }) => record(record(response.body).data) as unknown as {
  actionId: string; state: string; reasonCode: string;
  requiredAction: { kind: string; targetId: string; reasonCode: string } };
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-recollect-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-recollect-")));
  // app.ts 운영 executor 와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록.
  setWorkflowToolStepExecutor(async (request) => {
    const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId,
      agentName: request.agentName, toolName: request.toolName, parameters: request.args ?? {},
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId,
      requestId: request.requestId, workflowRunId: request.workflowRunId, stepId: request.stepId,
      toolName: request.toolName, success: coreResult.status === 200, stdout: coreResult.body.content ?? "",
      data: coreResult.body.data, stderr: coreResult.body.stderr ?? "", exitCode: coreResult.status === 200 ? 0 : 1,
      error: coreResult.body.error });
    return { accepted: true as const };
  });
}, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

/** [same_configuration 세계] typed args(url) 를 가진 실패 collector — 옛 자료 파일·"수집 완료" 댓글 함정 포함. */
async function collectorWorld(options: { grantCollector?: boolean } = {}) {
  const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Recollect Co", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator",
    status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Recollect mission", status: "active" });
  const tools = await db.insert(toolDefinitions).values([
    { companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId, name: "collect-feed", adapterType: "builtin", adapterConfig: { command: TOOL_COMMAND } },
  ]).returning();
  await db.insert(agentToolGrants).values([{ companyId, agentId: ownerAgentId, toolId: tools[0]!.id, grantedBy: "test" },
    ...(options.grantCollector === false ? [] : [{ companyId, agentId: ownerAgentId, toolId: tools[1]!.id, grantedBy: "test" }])]);
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "collect-world", stepsJson: [
    { id: "collect-feed", name: "Collect feed", type: "tool", toolNames: ["collect-feed"],
      toolArgs: { url: "https://example.test/feed" }, dependencies: [] }] }).returning();
  const workflowRunId = randomUUID(), stepRunId = randomUUID(), ownerActionIssueId = randomUUID();
  await db.insert(workflowRuns).values({ id: workflowRunId, workflowId: definition!.id, companyId, missionId,
    triggeredBy: "test", status: "failed", startedAt: new Date(), completedAt: new Date() });
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "collect-feed", issueId: null,
    status: "failed", startedAt: new Date(), completedAt: new Date(), lastDispatchErrorSummary: "feed unavailable",
    metadata: { toolInvocation: { toolName: "collect-feed", args: { url: "https://example.test/feed" } },
      toolResult: { toolName: "collect-feed", success: false, error: "feed unavailable" } } });
  await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId, decidedAuthorityVersion: 0,
    decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" });
  await db.insert(issues).values({ id: ownerActionIssueId, companyId, missionId, assigneeAgentId: ownerAgentId,
    originKind: "mission_main_executor_unblock", status: "todo", title: "[Owner Action] Recollect feed" });
  const artifactPath = path.join(root, "stale-feed.json"); // 옛 자료 함정: 재실행 전 해결 근거가 아니다
  await writeFile(artifactPath, JSON.stringify({ status: "success", stale: true }));
  await db.insert(issueComments).values({ companyId, issueId: ownerActionIssueId, authorAgentId: ownerAgentId,
    body: `### Native tool step recovery result\nStatus: success\nExit code: 0\nArtifact: ${artifactPath}` });
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: ownerAgentId,
    issueId: ownerActionIssueId, status: "succeeded" });
  const call = (action: Record<string, unknown>, actionRequestId = randomUUID()) => executeCoreWorkflowTool({ db, companyId,
    agentId: ownerAgentId, heartbeatRunId, toolName: "mission_owner_execute", parameters: {
      schemaVersion: 1, missionId, ownerActionIssueId, actionRequestId,
      expectedIntentEventId: null, ownerDecisionEventId: null, action }, requestId: randomUUID() });
  const stepRow = async () => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!;
  const authorities = () => db.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.workflowRunId, workflowRunId));
  const target = { kind: "tool_step" as const, workflowRunId, stepRunId,
    expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null };
  return { companyId, ownerAgentId, missionId, heartbeatRunId, call, stepRow, authorities, target };
}

it("[GREEN] same_configuration recollect re-executes the exact collector and reads back only the current result", async () => {
  const w = await collectorWorld();
  const firstRequestId = randomUUID();
  const first = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://example.test/feed"], mode: "same_configuration" }, firstRequestId);
  expect(first.status).toBe(200);
  const action = pending(first);
  expect(action.state).toBe("executing");
  const [authority] = await w.authorities();
  expect(authority.requestReference).toBe(`mission-owner-execute:${action.actionId}`);
  // 옛 자료 파일·"수집 완료" 댓글은 재실행 전 해결 근거가 아니다 — 실행 중 상태로 정확히 읽힌다.
  const before = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.ownerAgentId,
    heartbeatRunId: w.heartbeatRunId }, { schemaVersion: 1, missionId: w.missionId, actionId: action.actionId });
  expect(before).toMatchObject({ state: "executing", operation: "recollect" });
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBeGreaterThanOrEqual(1);
  const completed = await w.stepRow();
  expect(completed.status).toBe("completed"); // 실제 재실행 — 새 시도의 현재 결과
  expect(record(record(completed.metadata).toolResult)).toMatchObject(
    { success: true, data: { attempt: "recollect-stage6-current" } });
  const resolved = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.ownerAgentId,
    heartbeatRunId: w.heartbeatRunId }, { schemaVersion: 1, missionId: w.missionId, actionId: action.actionId });
  expect(resolved).toMatchObject({ state: "resolved", operation: "recollect" });
  expect(resolved.evidence).toContainEqual(expect.objectContaining(
    { kind: "dispatch", requestId: completed.lastDispatchRequestId, executionGeneration: 1 }));
  const replay = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://example.test/feed"], mode: "same_configuration" }, firstRequestId); // 같은 요청 재전송 → 투영만
  expect(pending(replay)).toMatchObject({ actionId: action.actionId, state: "resolved" });
  expect(await w.authorities()).toHaveLength(1);
}, 60000);

it("[RED] same_configuration with a different actual configuration is refused with zero side effects", async () => {
  const w = await collectorWorld();
  const before = JSON.stringify({ step: await w.stepRow(), authorities: await w.authorities() });
  const refused = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://other.test/feed"], mode: "same_configuration" });
  expect(refused.status).toBe(422);
  expect(refused.body.error).toBe("collector_configuration_changed");
  expect(JSON.stringify({ step: await w.stepRow(), authorities: await w.authorities() })).toBe(before);
  expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId))).toEqual([]);
}, 60000);

it("[RED] changed_collection requires a plan and rejects oneShot outside add/clone delta units", async () => {
  const w = await collectorWorld();
  const noPlan = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://example.test/feed"], mode: "changed_collection" });
  expect(noPlan.status).toBe(422);
  expect(noPlan.body.error).toBe("plan_required");
  const misplaced = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://example.test/feed"], mode: "changed_collection",
    plan: { planningIssueId: randomUUID(), expectedDecisionHash: null, decision: { revisionDelta: {
      schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: randomUUID(),
      base: { workflowDefinitionId: randomUUID(), snapshotHash: "0".repeat(64) },
      units: [{ unitId: "feed", operation: "modify", collectionScope: "oneShot" }] } } } });
  expect(misplaced.status).toBe(422);
  expect(misplaced.body.error).toBe("collection_scope_misplaced");
  expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId))).toEqual([]);
}, 60000);

it("[RED] an unavailable collector tool reports request_access with zero execution side effects", async () => {
  const w = await collectorWorld();
  await db.update(toolDefinitions).set({ enabled: false }) // collector 도구가 비활성화됐다 — 실행 전 정확한 보고
    .where(and(eq(toolDefinitions.companyId, w.companyId), eq(toolDefinitions.name, "collect-feed")));
  const result = await w.call({ operation: "recollect", collectorTarget: w.target,
    sourceRefs: ["https://example.test/feed"], mode: "same_configuration" });
  expect(result.status).toBe(200);
  expect(pending(result)).toMatchObject({ state: "blocked", reasonCode: "collector_tool_unavailable",
    requiredAction: { kind: "request_access", targetId: "collect-feed", reasonCode: "collector_tool_unavailable" } });
  expect(await w.authorities()).toEqual([]); // 권한 소비·리셋·전달 없음
  expect((await w.stepRow()).status).toBe("failed");
}, 60000);

it("[GREEN] changed_collection add oneShot runs the real stage-5 chain, executes the new collection, and keeps the periodic definition unchanged", async () => {
  const w = await slice1World(db, root, [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }],
    (agentId) => [{ id: "tpl-collect", name: "Collect periodic", type: "agent", agentId, dependencies: [],
      graphWorkProductRequired: true, toolNames: ["collect-periodic"],
      toolArgs: { url: "https://youtu.be/A", stateToken: { watermarks: { "channel-a": "wm-1" } } } }]);
  // 이전 1회 수집 시도(수정 미션 소속 run)가 실패했다 — collectorTarget 이 지목하는 정확한 스텝이다.
  const [priorDef] = await db.insert(workflowDefinitions).values({ companyId: w.companyId, name: "prior-one-shot",
    stepsJson: [{ id: "collect-feed", name: "Collect new URL once", type: "tool", agentId: w.agentId,
      toolNames: ["collect-feed"], toolArgs: { url: "https://youtu.be/B" }, dependencies: [] }] }).returning();
  const priorRunId = randomUUID(), priorStepRunId = randomUUID();
  await db.insert(workflowRuns).values({ id: priorRunId, workflowId: priorDef!.id, companyId: w.companyId,
    missionId: w.revision.id, triggeredBy: "test", status: "failed", startedAt: new Date(), completedAt: new Date() });
  await db.insert(workflowStepRuns).values({ id: priorStepRunId, workflowRunId: priorRunId, stepId: "collect-feed",
    issueId: null, status: "failed", startedAt: new Date(), completedAt: new Date(),
    metadata: { toolInvocation: { toolName: "collect-feed", args: { url: "https://youtu.be/B" } },
      toolResult: { toolName: "collect-feed", success: false, error: "unavailable" } } });
  await db.insert(workflowTerminalDecisions).values({ companyId: w.companyId, workflowRunId: priorRunId,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler" });
  const tools = await db.insert(toolDefinitions).values([
    { companyId: w.companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId: w.companyId, name: "collect-feed", adapterType: "builtin",
      adapterConfig: { command: GATE_COMMAND, capabilities: ["structural_validation_v1"] } }, // 구조 게이트 도구 계약
  ]).returning();
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId: w.companyId, agentId: w.agentId,
    toolId: tool.id, grantedBy: "test" })));
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: w.companyId, agentId: w.agentId,
    issueId: w.planning.id, status: "succeeded" });
  const decision = slice1Decision(w.revision.id, [
    { id: w.source[0].id, sourceStepId: w.source[0].id }, // 재사용 A — 신원만 선언(서버가 원문 복사·투영)
    slice1Unit(w.agentId, "collectNew", "Collect new URL once", { type: "tool", qaType: "structural",
      toolNames: ["collect-feed"], toolArgs: { url: "https://youtu.be/C" }, dependencies: [w.source[0].id] }),
  ], w.delta([{ unitId: w.source[0].id, operation: "reuse", sourceStepId: w.source[0].id },
    { unitId: "collectNew", operation: "add", collectionScope: "oneShot" }]));
  const first = await executeCoreWorkflowTool({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId,
    toolName: "mission_owner_execute", parameters: { schemaVersion: 1, missionId: w.revision.id,
      ownerActionIssueId: w.planning.id, actionRequestId: randomUUID(), expectedIntentEventId: null,
      ownerDecisionEventId: null, action: { operation: "recollect",
        collectorTarget: { kind: "tool_step", workflowRunId: priorRunId, stepRunId: priorStepRunId,
          expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null },
        sourceRefs: ["https://youtu.be/B"], mode: "changed_collection",
        plan: { planningIssueId: w.planning.id, expectedDecisionHash: null, decision } } }, requestId: randomUUID() });
  expect(first.status).toBe(200);
  const action = pending(first);
  expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending",
    requiredAction: { kind: "submit_qa_verdict" } });
  const [ledger] = await db.select().from(missionPlanDecisionSubmissions)
    .where(eq(missionPlanDecisionSubmissions.missionId, w.revision.id));
  expect(ledger.decision).toEqual(decision); // raw 제출 원문 보존 — canonical projection 는 refs 해시로 고정
  // 독립 PLAN-QA pass(별도 actor, 실제 verdict API) → 물화 → board 경계
  await submitMissionPlanQaVerdict({ db, issue: { id: action.requiredAction.targetId, companyId: w.companyId,
    missionId: w.revision.id, originKind: "mission_plan_qa" },
    actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null },
    data: { verdict: "pass", diagnostics: [] } });
  const steps = await paqoDefinitionSteps(db, w.companyId, w.revision.id);
  const newStep = steps.find((s) => (s.toolNames ?? []).includes("collect-feed"))!;
  expect(newStep).toBeTruthy();
  expect(newStep.toolArgs).toEqual({ url: "https://youtu.be/C" }); // 변경된 1회 수집 인자 — 정기 상태 토큰 없음
  const periodicUnchanged = async () => {
    const [row] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, w.currentTemplate.id));
    expect(row!.stepsJson).toEqual(w.currentTemplate.stepsJson); // 정기 정의 행 bytes 불변
    const periodic = (row!.stepsJson as Array<{ id: string; toolArgs?: unknown }>).find((s) => s.id === "tpl-collect")!;
    expect(periodic.toolArgs).toEqual({ url: "https://youtu.be/A", stateToken: { watermarks: { "channel-a": "wm-1" } } });
  };
  await periodicUnchanged();
  const projected = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId },
    { schemaVersion: 1, missionId: w.revision.id, actionId: action.actionId });
  expect(projected).toMatchObject({ state: "blocked", operation: "recollect",
    reasonCode: "board_revision_start_required", requiredAction: { kind: "board_revision_start" } });
  // board 시작(기존 native 경로, board actor) → 실제 수집 실행
  const [paqoDef] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, w.companyId),
    eq(workflowDefinitions.missionId, w.revision.id), eq(workflowDefinitions.sourceKind, "paqo")));
  const revisionRun = await createAdmittedWorkflowRun(db, { companyId: w.companyId, workflowId: paqoDef!.id,
    missionId: w.revision.id, triggeredBy: "board",
    seedFromRun: { sourceWorkflowRunId: w.sourceRun.id, stepIds: [w.source[0].id] } }, board);
  for (let round = 0; round < 2; round++) { await executeWorkflowRun(db, revisionRun.id); await processQueuedWorkflowToolStepRuns(db); }
  const [collectorRun] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, revisionRun.id), eq(workflowStepRuns.stepId, newStep.id)));
  expect(collectorRun).toBeTruthy();
  expect(collectorRun!.status).toBe("completed"); // 실제 로컬 수집 도구 실행
  expect(record(record(collectorRun!.metadata).toolInvocation).args).toEqual({ url: "https://youtu.be/C" });
  expect(record(record(collectorRun!.metadata).toolResult)).toMatchObject({ success: true });
  await periodicUnchanged(); // 실행 후에도 원본 periodic 정의·watermark 불변
}, 60000);
