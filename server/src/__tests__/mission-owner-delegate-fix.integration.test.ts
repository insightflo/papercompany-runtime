// server/src/__tests__/mission-owner-delegate-fix.integration.test.ts
//
// [Stage 7 — delegate_fix 실제 연결] 공식 QA finding 을 담당 경로로 잇는 것을 실DB+실경로로 검증한다.
//   ① artifact → native back-edge 재작업 → 생산자 실재실행 → 새 산출물 → 독립 현재 QA → resolved
//   ② source_data → stage 6 재수집 실경로(생산자 미건드림) ③ mixed 양 경로 분배 ④ 없는 verdict·finding 불일치 → 부작용 0
//   ⑤ cap 소진 → blocked+사람 판단 ⑥ missing edge+plan 누락 → 거부 ⑦ 진행 중 중복 요청 → reset 없이 현재 attempt 연결
//   ⑧ failed run 의 artifact finding → run_failed_requires_resume blocked(stage 4 이관, 부작용 0)
//   ⑨ [C1] source-only + collection.plan(변경 수집) — 실행 응답과 get-result 투영 일치(오보고 없음).
//   fence 일반화: 일반 미션 recollect changed_collection 계획 시작이 소유자 intent 펜스에 걸린다.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues,
  missionPlanDecisionSubmissions, missions, toolDefinitions, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
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

const TOOL_COMMAND = `node -e "console.log(JSON.stringify({status:'success',attempt:'delegate-fix-stage7-current'}))" --`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type PendingResult = { actionId: string; state: string; reasonCode: string | null;
  requiredAction: { kind: string; targetId: string; reasonCode: string } | null };
const pendingResult = (response: { body: { data?: unknown } }): PendingResult => record(record(response.body).data) as unknown as PendingResult;
const FINDING_ARTIFACT = [{ id: "chart-wrong", summary: "report chart uses a stale series", layer: "artifact" as const }];
const FINDING_SOURCE = [{ id: "kr-missing", summary: "kr_index absent from collected feed", layer: "source_data" as const }];
const FEED_URL = "https://example.test/feed";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-delegate-fix-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-delegate-fix-")));
  // app.ts 운영 executor 와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록.
  setWorkflowToolStepExecutor(async (request) => {
    const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId, agentName: request.agentName,
      toolName: request.toolName, parameters: request.args ?? {}, requestId: request.requestId, workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId, requestId: request.requestId,
      workflowRunId: request.workflowRunId, stepId: request.stepId, toolName: request.toolName, success: coreResult.status === 200,
      stdout: coreResult.body.content ?? "", data: coreResult.body.data, stderr: coreResult.body.stderr ?? "",
      exitCode: coreResult.status === 200 ? 0 : 1, error: coreResult.body.error });
    return { accepted: true as const };
  });
}, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

/** [QA loop 세계] collector(tool) → producer(agent, back-edge) → QA(독립 agent) 의 실구조 run + 공식 반려 판정. */
async function qaWorld(options: { findings: Array<{ id: string; summary: string; layer: "artifact" | "source_data" }>;
  backEdge?: boolean; maxIterations?: number; iterationIndex?: number; collectorStatus?: "completed" | "failed";
  runStatus?: "running" | "failed"; terminalDecision?: boolean }) {
  const companyId = randomUUID(), ownerAgentId = randomUUID(), qaAgentId = randomUUID(), missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "DelegateFix Co", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Owner", role: "operator", status: "active", adapterType: "process" }, { id: qaAgentId, companyId, name: "QA", role: "operator", status: "active", adapterType: "process" }]);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "DelegateFix mission", status: "active" });
  const tools = await db.insert(toolDefinitions).values([{ companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }, { companyId, name: "collect-feed", adapterType: "builtin", adapterConfig: { command: TOOL_COMMAND } }]).returning();
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId, agentId: ownerAgentId, toolId: tool.id, grantedBy: "test" })));
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "qa-loop", stepsJson: [
    { id: "collect-feed", name: "Collect", type: "tool", toolNames: ["collect-feed"], toolArgs: { url: FEED_URL }, dependencies: [] },
    { id: "produce", name: "Produce", agentId: ownerAgentId, dependencies: ["collect-feed"], graphWorkProductRequired: true,
      ...(options.backEdge === false ? {} : { conditionalDependencies: [
        { stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: options.maxIterations ?? 2 }] }) },
    { id: "qa-validate", name: "QA", type: "qa", agentId: qaAgentId, dependencies: ["produce"] }] }).returning();
  const workflowRunId = randomUUID(), collectorStepRunId = randomUUID(), producerStepRunId = randomUUID(), qaStepRunId = randomUUID();
  const producerIssueId = randomUUID(), qaIssueId = randomUUID(), ownerActionIssueId = randomUUID();
  await db.insert(workflowRuns).values({ id: workflowRunId, workflowId: definition!.id, companyId, missionId,
    triggeredBy: "test", status: options.runStatus ?? "running", startedAt: new Date() });
  await db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, assigneeAgentId: ownerAgentId, originKind: "workflow_execution", status: "done", title: "produce report", completedAt: new Date(Date.now() - 60_000) },
    { id: qaIssueId, companyId, missionId, assigneeAgentId: qaAgentId, originKind: "workflow_execution", status: "done", title: "qa-validate", completedAt: new Date(Date.now() - 30_000) },
    { id: ownerActionIssueId, companyId, missionId, assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock", status: "todo", title: "[Owner Action] fix QA finding" },
    { id: randomUUID(), companyId, missionId, assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] DelegateFix mission" }]);
  await db.insert(workflowStepRuns).values([
    { id: collectorStepRunId, workflowRunId, stepId: "collect-feed", issueId: null, status: options.collectorStatus ?? "completed",
      ...(options.collectorStatus === "failed" ? { startedAt: new Date(), completedAt: new Date(), lastDispatchErrorSummary: "feed unavailable",
        metadata: { toolInvocation: { toolName: "collect-feed", args: { url: FEED_URL } }, toolResult: { toolName: "collect-feed", success: false, error: "feed unavailable" } } }
        : { completedAt: new Date(Date.now() - 120_000) }) },
    { id: producerStepRunId, workflowRunId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: options.iterationIndex ?? 0, completedAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 90_000) },
    { id: qaStepRunId, workflowRunId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", startedAt: new Date(Date.now() - 45_000), completedAt: new Date(Date.now() - 30_000) }]);
  if (options.terminalDecision) await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId, decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" });
  // 완료된 생산자의 등록 산출물 — graphWorkProductRequired 게이트가 completed 를 지키게 한다.
  // 등록 provenance 는 생산자 이슈 스코프 heartbeat 여야 한다(producer-provenance 게이트).
  const seedHeartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: seedHeartbeatId, companyId, agentId: ownerAgentId, issueId: producerIssueId, status: "succeeded" });
  const seedArtifact = path.join(root, "missions", missionId, "seed", "content.json"), seedBytes = Buffer.from('{"blocks":["seed"]}');
  await mkdir(path.dirname(seedArtifact), { recursive: true }); await writeFile(seedArtifact, seedBytes);
  await workProductService(db).createForIssue(producerIssueId, companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: seedHeartbeatId, metadata: { path: seedArtifact, sha256: createHash("sha256").update(seedBytes).digest("hex") } });
  // 공식 QA 반려 판정: 독립 QA actor 의 QA 이슈 스코프 heartbeat → workflow_api request_changes + findings.
  const qaHeartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: qaHeartbeatId, companyId, agentId: qaAgentId, issueId: qaIssueId, status: "succeeded" });
  const [qaIssueRow] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
  await recordWorkflowValidationVerdict({ db, issue: qaIssueRow!, verdict: "request_changes", source: "workflow_api", actorAgentId: qaAgentId, heartbeatRunId: qaHeartbeatId, findings: options.findings });
  const [verdictEvent] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"))).limit(1);
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "succeeded" });
  const call = (action: Record<string, unknown>, actionRequestId = randomUUID()) => executeCoreWorkflowTool({ db, companyId,
    agentId: ownerAgentId, heartbeatRunId, toolName: "mission_owner_execute", requestId: randomUUID(), parameters: {
      schemaVersion: 1, missionId, ownerActionIssueId, actionRequestId, expectedIntentEventId: null, ownerDecisionEventId: null, action } });
  const row = async (stepRunId: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!;
  const getResult = (actionId: string) => getMissionOwnerActionResult({ db, companyId, agentId: ownerAgentId, heartbeatRunId }, { schemaVersion: 1, missionId, actionId });
  return { companyId, ownerAgentId, qaAgentId, missionId, workflowRunId, definitionId: definition!.id, collectorStepRunId,
    producerStepRunId, producerIssueId, qaIssueId, heartbeatRunId, verdictEventId: verdictEvent!.id, call, row, getResult, producerTarget: { kind: "issue_step" as const, workflowRunId, stepRunId: producerStepRunId, issueId: producerIssueId,
      expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } };
}

/** 일반 미션 계획 체인 부속: planning issue + 초기 plan refs (changed_collection/fence 테스트 공용). */
async function addPlanning(w: Awaited<ReturnType<typeof qaWorld>>) {
  const [planning] = await db.insert(issues).values({ companyId: w.companyId, missionId: w.missionId, title: "PLAN",
    originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: w.ownerAgentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: w.companyId, missionId: w.missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  return planning!; }
const planDecisionFor = (w: Awaited<ReturnType<typeof qaWorld>>) => ({
  missionId: w.missionId, missionGoal: "Recollection plan", selectedPlanTemplateIds: [],
  selectedExecutionUnits: [{ id: "write", title: "Write", selectionState: "selected", reason: "unit", assigneeAgentId: w.ownerAgentId, sourceRef: { type: "mission_plan_unit", id: "write" }, graphWorkProductRequired: true, dependencies: [] }],
  ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
  assessment: { objectiveRestatement: "Recollection plan", availableAssetsReviewed: ["source"], assetEvaluation: ["source"], gaps: [], researchPerformed: [] } });

it("[①GREEN] artifact finding reworks the real producer and resolves only via a fresh independent QA pass", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT });
  const action = pendingResult(await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] }));
  expect(action.state).toBe("executing"); // native back-edge 재작업 발사(실제 wake 존재)
  const producer = await w.row(w.producerStepRunId);
  expect(producer.status).toBe("pending"); // 재작업 리셋 — cap 1 소모
  expect(producer.iterationIndex).toBe(1);
  const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, w.companyId), eq(agentWakeupRequests.issueId, w.producerIssueId)));
  expect(wake).toBeTruthy();
  // 생산자 실재실행: 승인 입장 → 새 산출물 등록 → 이슈 완료 → 엔진 동기화가 완료를 소유
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, w.producerStepRunId));
  const producerHeartbeat = randomUUID();
  await admittedProducer(db, { companyId: w.companyId, agentId: w.ownerAgentId, issueId: w.producerIssueId, stepRunId: w.producerStepRunId, heartbeatId: producerHeartbeat });
  const file = path.join(root, "missions", w.missionId, "produce", "content.json"), bytes = Buffer.from('{"blocks":["reworked"]}');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  await workProductService(db).createForIssue(w.producerIssueId, w.companyId, { provider: "local_file", type: "document", title: "content.json", status: "active", createdByRunId: producerHeartbeat, metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, w.producerIssueId));
  await syncWorkflowRunState(db, w.workflowRunId); // 생산자 재완료 동기화 → QA 재발화
  expect((await w.row(w.producerStepRunId)).status).toBe("completed");
  // 옛 판정은 resolved 근거가 아니다 — 새 산출물 이후 관측된 독립 QA pass 만 근거다
  const before = await w.getResult(action.actionId);
  expect(before).toMatchObject({ state: "needs_evidence" });
  expect(before.requiredAction).toMatchObject({ kind: "submit_qa_verdict" });
  const freshQaHeartbeat = randomUUID();
  await db.insert(heartbeatRuns).values({ id: freshQaHeartbeat, companyId: w.companyId, agentId: w.qaAgentId, issueId: w.qaIssueId, status: "succeeded" });
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, w.qaIssueId));
  const [qaIssueRow] = await db.select().from(issues).where(eq(issues.id, w.qaIssueId));
  await recordWorkflowValidationVerdict({ db, issue: qaIssueRow!, verdict: "pass", source: "workflow_api",
    actorAgentId: w.qaAgentId, heartbeatRunId: freshQaHeartbeat });
  const resolved = await w.getResult(action.actionId);
  expect(resolved).toMatchObject({ state: "resolved", operation: "delegate_fix" });
  expect(resolved.evidence).toContainEqual(expect.objectContaining({ kind: "qa" }));
  expect(resolved.evidence).toContainEqual(expect.objectContaining({ kind: "artifact" }));
}, 60000);

it("[②GREEN] source_data finding routes to the real collection path without touching the producer", async () => {
  const w = await qaWorld({ findings: FINDING_SOURCE, collectorStatus: "failed", runStatus: "failed", terminalDecision: true });
  const result = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["kr-missing"], collection: { sourceRefs: [FEED_URL] } });
  expect(result.status).toBe(200);
  expect(pendingResult(result)).toMatchObject({ state: "executing", operation: "delegate_fix" });
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBeGreaterThanOrEqual(1); // 실제 수집 재실행
  const collector = await w.row(w.collectorStepRunId);
  expect(collector.status).toBe("completed");
  expect(record(record(collector.metadata).toolResult)).toMatchObject({ success: true });
  const producer = await w.row(w.producerStepRunId);
  expect(producer.status).toBe("completed"); // 생산자 미건드림 — reset·cap 소모 없음
  expect(producer.iterationIndex).toBe(0);
  expect(producer.metadata).not.toHaveProperty("workflowReworkContract");
  expect(await w.getResult(pendingResult(result).actionId)).toMatchObject({ state: "resolved" });
}, 60000);

it("[③GREEN] mixed findings are split across the rework path and the collection plan path", async () => {
  const w = await qaWorld({ findings: [...FINDING_SOURCE, ...FINDING_ARTIFACT] });
  const planning = await addPlanning(w);
  const result = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget,
    qaVerdictEventId: w.verdictEventId, findingIds: ["kr-missing", "chart-wrong"],
    collection: { sourceRefs: [FEED_URL], plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision: planDecisionFor(w) } } });
  expect(result.status).toBe(200);
  const action = pendingResult(result);
  expect(action.state).toBe("executing"); // artifact 부: producer 재작업이 우선 진행
  expect((await w.row(w.producerStepRunId)).iterationIndex).toBe(1);
  const [ledger] = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId)); // source 부: 계획 실제 제출
  expect(ledger).toBeTruthy();
}, 60000);

it("[④RED] an unknown verdict or mismatched finding ids refuse with zero side effects", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT });
  const eventsSnapshot = () => db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId));
  const before = JSON.stringify({ producer: await w.row(w.producerStepRunId), events: await eventsSnapshot() });
  const unknown = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: randomUUID(), findingIds: ["chart-wrong"] });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toBe("qa_verdict_not_found");
  const mismatch = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["not-in-this-verdict"] });
  expect(mismatch.status).toBe(422);
  expect(mismatch.body.error).toBe("finding_mismatch");
  expect(JSON.stringify({ producer: await w.row(w.producerStepRunId), events: await eventsSnapshot() })).toBe(before);
}, 60000);

it("[⑤RED] rework cap exhaustion blocks with a precise human-decision request", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT, maxIterations: 2, iterationIndex: 2 });
  const result = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] });
  expect(result.status).toBe(200);
  expect(pendingResult(result)).toMatchObject({ state: "blocked", reasonCode: "rework_cap_exhausted",
    requiredAction: { kind: "submit_corrected_plan" } });
  const producer = await w.row(w.producerStepRunId);
  expect(producer.status).toBe("completed"); // cap 소진 → 추가 reset 없음
  expect(producer.iterationIndex).toBe(2);
}, 60000);

it("[⑥RED] a missing back-edge without a plan is refused before any intent", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT, backEdge: false });
  const refused = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget,
    qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] });
  expect(refused.status).toBe(422);
  expect(refused.body.error).toBe("plan_required");
  expect(await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1")))).toEqual([]);
}, 60000);

it("[⑦GREEN] a duplicate request during rework connects to the current attempt without a second reset", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT });
  const first = pendingResult(await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] }));
  expect((await w.row(w.producerStepRunId)).iterationIndex).toBe(1);
  const again = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] }); // 새 요청 id, 같은 verdict
  expect(again.status).toBe(200);
  expect(pendingResult(again)).toMatchObject({ state: "executing" });
  const producer = await w.row(w.producerStepRunId);
  expect(producer.status).toBe("pending");
  expect(producer.iterationIndex).toBe(1); // 이미 시작된 재작업 — reset·cap 이중 소모 없음
}, 60000);

it("[⑧RED] an artifact finding on a failed run blocks with the stage-4 resume handoff", async () => {
  const w = await qaWorld({ findings: FINDING_ARTIFACT, runStatus: "failed", terminalDecision: true });
  const result = await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget, qaVerdictEventId: w.verdictEventId, findingIds: ["chart-wrong"] });
  expect(result.status).toBe(200);
  expect(pendingResult(result)).toMatchObject({ state: "blocked", reasonCode: "run_failed_requires_resume", requiredAction: null }); // stage 4(resume_run) 이관 — 자동 재개 없음
  const producer = await w.row(w.producerStepRunId);
  expect(producer.status).toBe("completed"); // 부작용 0 — reset·cap 소모 없음
  expect(producer.iterationIndex).toBe(0);
  expect(producer.metadata).not.toHaveProperty("workflowReworkContract");
  expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, w.companyId), eq(agentWakeupRequests.issueId, w.producerIssueId)))).toEqual([]); // 재작업 wake 없음
  expect(await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.eventType, "owner_execute_applied_v1"),
    eq(workflowTransitionEvents.correlationId, pendingResult(result).actionId)))).toEqual([]); // applied 영수증 없음
}, 60000);

it("[fence RED→GREEN] an ordinary mission's changed_collection plan start is now fenced by the owner intent", async () => {
  const w = await qaWorld({ findings: FINDING_SOURCE });
  const planning = await addPlanning(w);
  const planHeartbeat = randomUUID();
  await db.insert(heartbeatRuns).values({ id: planHeartbeat, companyId: w.companyId, agentId: w.ownerAgentId,
    issueId: planning.id, status: "succeeded" });
  const call = (action: Record<string, unknown>) => executeCoreWorkflowTool({ db, companyId: w.companyId,
    agentId: w.ownerAgentId, heartbeatRunId: planHeartbeat, toolName: "mission_owner_execute", requestId: randomUUID(), parameters: {
      schemaVersion: 1, missionId: w.missionId, ownerActionIssueId: planning.id, actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null, action } });
  const action = pendingResult(await call({ operation: "recollect", collectorTarget: w.producerTarget,
    sourceRefs: [FEED_URL], mode: "changed_collection",
    plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision: planDecisionFor(w) } }));
  expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending" });
  const missionRuns = async () => (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).length;
  const runsBefore = await missionRuns();
  // QA 통과 직전 같은 오너 이슈에 더 최신 의도가 기록됐다 — 일반 미션의 recollect 계획 시작도 펜스에 걸린다.
  await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId, issueId: planning.id,
    heartbeatRunId: planHeartbeat, eventType: "owner_execute_intent_v1", layer: "mission_owner_authority",
    reason: "mission_owner_execute", reasonCode: "mission_owner_execute",
    idempotencyKey: `mission-owner-execute:v1:${w.companyId}:${w.missionId}:${planning.id}:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: w.missionId, ownerActionIssueId: planning.id,
      actionRequestId: randomUUID(), heartbeatRunId: planHeartbeat, agentId: w.ownerAgentId,
      action: { operation: "retry_step", target: { kind: "tool_step", workflowRunId: randomUUID(), stepRunId: randomUUID(),
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } }, bodyFingerprint: randomUUID() } });
  await expect(submitMissionPlanQaVerdict({ db, issue: { id: action.requiredAction!.targetId, companyId: w.companyId, missionId: w.missionId,
    originKind: "mission_plan_qa" }, actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null },
    data: { verdict: "pass", diagnostics: [] } })).rejects.toThrow("owner_plan_start_intent_stale");
  expect(await missionRuns()).toBe(runsBefore);
}, 60000);

it("[⑨ C1] source-only changed-collection delegate_fix agrees between the execution response and get-result", async () => {
  const w = await qaWorld({ findings: FINDING_SOURCE });
  const planning = await addPlanning(w);
  const executed = pendingResult(await w.call({ operation: "delegate_fix", producerTarget: w.producerTarget,
    qaVerdictEventId: w.verdictEventId, findingIds: ["kr-missing"],
    collection: { sourceRefs: [FEED_URL], plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision: planDecisionFor(w) } } }));
  expect(executed).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending", operation: "delegate_fix" }); // 실행 응답
  expect((await w.row(w.producerStepRunId)).iterationIndex).toBe(0); // source 경로 — 생산자 미건드림
  const projected = await w.getResult(executed.actionId); // [C1] 투영 오보고 없음 — 실행 응답과 일치해야 한다
  expect(projected).toMatchObject({ operation: "delegate_fix", state: executed.state, reasonCode: executed.reasonCode });
  expect(projected.requiredAction).toEqual(executed.requiredAction);
}, 60000);
