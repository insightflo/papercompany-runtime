// server/src/__tests__/mission-owner-plan-fence-and-fresh-start.test.ts
//
// [PR367 회귀 R1+R3 — 펜스 창·미시작 pending 재시작] R1: deriveOwnerPlanRunFence(owner-plan-workflow-run.ts)는
//   미션의 owner 실행 intent 를 최신순 전수 스캔한다(과거 .limit(10) 창 제거). 계획 P 제출 intent A 뒤에
//   (a) 같은 오너 이슈 I에 더 최신 비계획 intent B, (b) 다른 이슈 9건의 비계획 intent 가 차례로 기록돼도
//   A 를 찾아내고, 이슈-국소 최신성 검사가 지연 PLAN-QA PASS 의 stale 시작을 차단해야 한다(run 0건).
// R3: 두 번째 시작 확인(펜스 validateIntent) 실패로 남은 미시작 pending run 을 현재 오너의 새 유효
//   요청 C(별도 actionRequestId, 같은 계획 decision)가 실제 경로로 다시 만나면 실제 native 시작(또는
//   정확한 구조 거부)으로 연결해야 한다 — 조용한 delivery_pending 관찰은 계약 위반이다.
//   두 번째 확인 실패는 실제 경로 안의 run INSERT 시점 DB 트리거로 같은 오너 이슈에 더 최신 intent 를
//   기록해 결정적으로 만든다(저장소 내 기존 테스트 트리거 관행과 동일 방식).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, heartbeatRuns, issues, missions, toolDefinitions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-plan-fence-fresh-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-plan-fence-fresh-")));
  await writeFile(path.join(root, "qa.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`);
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
}, 120000);
afterAll(async () => { setWorkflowToolStepExecutor(null); if (db) await waitForHeartbeatExecutionsToDrain(db);
  if (db) await db.$client.end({ timeout: 5 }); await temp?.cleanup();
  if (root) { execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); } });

const qaContract: ArtifactContract = { role: "qa", resultFileName: "inspection.json", resultAdapter: "generic",
  resultSchemaVersion: "workflow.qa-result.v1", inputParams: { content: "document" }, deploymentFiles: ["qa.mjs"],
  inputEnvelopeVersion: "workflow.artifact-input.v1" };
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const qaVerdict = (companyId: string, missionId: string, planQaIssueId: string) =>
  submitMissionPlanQaVerdict({ db, issue: { id: planQaIssueId, companyId, missionId, originKind: "mission_plan_qa" },
    actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null }, data: { verdict: "pass", diagnostics: [] } });

async function world() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "FenceFresh", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
  const tools = await db.insert(toolDefinitions).values([
    { companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId, name: "plan-qa-check", adapterType: "builtin", description: "Mock artifact tool",
      adapterConfig: { command: `${process.execPath} ${path.join(root, "qa.mjs")}`, workingDirectory: root,
        capabilities: ["structural_validation_v1"], artifactContract: qaContract } },
  ]).returning();
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId, agentId, toolId: tool.id, grantedBy: "test" })));
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Fence fresh", status: "active" }).returning();
  const [planning] = await db.insert(issues).values({ companyId, missionId: mission.id, title: "PLAN",
    originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: agentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId: mission.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  const heartbeatRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId: planning.id, status: "succeeded" });
  await mkdir(path.join(root, "missions", mission.id), { recursive: true });
  const decision = () => ({ missionId: mission.id, missionGoal: "Owner revised plan", selectedPlanTemplateIds: [],
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
    assessment: { objectiveRestatement: "Fence fresh", availableAssetsReviewed: [], assetEvaluation: [], gaps: [], researchPerformed: [] } });
  const body = () => ({ schemaVersion: 1 as const, missionId: mission.id, ownerActionIssueId: planning.id,
    actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "revise_plan" as const, plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision: decision() } } });
  const call = (b: unknown) => executeCoreWorkflowTool({ db, companyId, agentId, heartbeatRunId,
    toolName: "mission_owner_execute", parameters: b, requestId: randomUUID() });
  const runs = () => db.select().from(workflowRuns).where(eq(workflowRuns.missionId, mission.id));
  return { companyId, agentId, mission, planning, heartbeatRunId, body, call, runs };
}
const pending = (response: { body: { data?: unknown } }) => record(record(response.body).data) as unknown as {
  actionId: string; state: string; reasonCode: string; requiredAction: { kind: string; targetId: string } };

// facade가 쓰는 것과 같은 구조의 비계획(=계획 결정 없는) owner 실행 intent 행(기존 테스트 관행과 동일 형태).
async function newerNonPlanIntent(w: Awaited<ReturnType<typeof world>>, issueId: string, createdAt: Date) {
  await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.mission.id, issueId,
    heartbeatRunId: w.heartbeatRunId, eventType: "owner_execute_intent_v1", layer: "mission_owner_authority",
    reason: "mission_owner_execute", reasonCode: "mission_owner_execute",
    idempotencyKey: `mission-owner-execute:v1:${w.companyId}:${w.mission.id}:${issueId}:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: w.mission.id, ownerActionIssueId: issueId,
      actionRequestId: randomUUID(), heartbeatRunId: w.heartbeatRunId, agentId: w.agentId,
      action: { operation: "retry_step", target: { kind: "tool_step", workflowRunId: randomUUID(), stepRunId: randomUUID(),
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } }, bodyFingerprint: randomUUID() },
    createdAt });
}
const intentCreatedAt = async (actionId: string) =>
  (await db.select({ createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, actionId)))[0]!.createdAt;

// 실제 경로 안의 run INSERT(createWorkflowRun) 시점에 issueId 에 더 최신 비계획 owner 실행 intent 를
// 기록한다 — 첫 번째 펜스 확인은 통과하고 run 생성 뒤의 두 번째 확인만 실패하는 경쟁 창을 결정화한다.
async function installStaleIntentOnRunCreate(w: Awaited<ReturnType<typeof world>>, issueId: string,
  anchorActionId: string, suffix: string) {
  const payload = JSON.stringify({ schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: w.mission.id,
    ownerActionIssueId: issueId, actionRequestId: `repro-r3-${suffix}`, heartbeatRunId: w.heartbeatRunId,
    agentId: w.agentId, action: { operation: "retry_step", target: { kind: "tool_step", workflowRunId: randomUUID(),
      stepRunId: randomUUID(), expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } },
    bodyFingerprint: randomUUID() });
  await db.execute(sql.raw(`CREATE FUNCTION repro_r3_stale_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN
    INSERT INTO workflow_transition_events (company_id, mission_id, issue_id, heartbeat_run_id, event_type, layer,
      reason, reason_code, idempotency_key, payload, created_at)
    VALUES (NEW.company_id, NEW.mission_id, '${issueId}', '${w.heartbeatRunId}', 'owner_execute_intent_v1',
      'mission_owner_authority', 'mission_owner_execute', 'mission_owner_execute',
      'mission-owner-execute:v1:${w.companyId}:${w.mission.id}:${issueId}:repro-r3-${suffix}',
      $json$${payload}$json$::jsonb,
      (SELECT created_at + interval '30 seconds' FROM workflow_transition_events WHERE id = '${anchorActionId}'));
    RETURN NEW; END $fn$`));
  await db.execute(sql.raw(`CREATE TRIGGER repro_r3_stale_${suffix} AFTER INSERT ON workflow_runs FOR EACH ROW
    WHEN (NEW.mission_id = '${w.mission.id}'::uuid AND NEW.status = 'pending')
    EXECUTE FUNCTION repro_r3_stale_${suffix}()`));
}
async function dropStaleIntentTrigger(suffix: string) {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS repro_r3_stale_${suffix} ON workflow_runs`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS repro_r3_stale_${suffix}()`));
}

it("[control][R1] a single newer intent on the owner action issue still blocks the stale start", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  const at = await intentCreatedAt(action.actionId);
  await newerNonPlanIntent(w, w.planning.id, new Date(at.getTime() + 1000));
  await expect(qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId))
    .rejects.toThrow("owner_plan_start_intent_stale");
  expect(await w.runs()).toEqual([]); // A가 창 안(최신 2건 중 2번째) → 이슈-국소 최신성 검사가 작동
}, 60000);

it("[R1] 10 newer intents push the matching plan intent out of the former 10-row fence window — the stale start must still be blocked", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  const at = await intentCreatedAt(action.actionId);
  await newerNonPlanIntent(w, w.planning.id, new Date(at.getTime() + 1000)); // 같은 오너 이슈 I의 더 최신 intent B
  const otherIssues = await db.insert(issues).values(Array.from({ length: 9 }, (_, i) => ({ companyId: w.companyId,
    missionId: w.mission.id, title: `Owner action ${i}`, originKind: "workflow_execution", status: "todo",
    assigneeAgentId: w.agentId }))).returning();
  for (const [i, issue] of otherIssues.entries())
    await newerNonPlanIntent(w, issue.id, new Date(at.getTime() + (i + 2) * 1000)); // 다른 이슈 9건의 더 최신 intent
  // 설정 확인(제품 실패와 구분): A는 과거 10건 창 기준 밖이다(합계 11건).
  const window = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.missionId, w.mission.id),
    eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"),
    eq(workflowTransitionEvents.layer, "mission_owner_authority")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(10);
  expect(window).toHaveLength(10);
  expect(window.map((row) => row.id)).not.toContain(action.actionId);
  // 계약: 오너 이슈 I에 더 최신 intent B가 있으므로 P의 stale 시작은 차단되어야 한다(run 0건).
  let refusal: unknown = null;
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId).catch((error) => { refusal = error; });
  expect(await w.runs()).toEqual([]); // 전수 스캔 펜스가 A 를 찾고 이슈-국소 최신성이 시작을 차단한다
  if (refusal) expect((refusal as Error).message).toBe("owner_plan_start_intent_stale");
}, 60000);

it("[control][R3] the same run-insert interpose on another issue leaves the second validation passing and the run started", async () => {
  const w = await world();
  const [other] = await db.insert(issues).values({ companyId: w.companyId, missionId: w.mission.id, title: "Other",
    originKind: "workflow_execution", status: "todo", assigneeAgentId: w.agentId }).returning();
  const action = pending(await w.call(w.body()));
  await installStaleIntentOnRunCreate(w, other.id, action.actionId, "ctl"); // 다른 이슈 → 오너 이슈 최신성 불변
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId); // 거부 없이 물화·시작
  const [run] = await w.runs();
  expect(run.status).toBe("running"); // 트리거 개입 없이 두 번째 확인 통과 → 실제 시작(기계 정상 확인)
  await dropStaleIntentTrigger("ctl");
}, 60000);

it("[R3] an unstarted pending run must not silently satisfy a fresh valid same-plan request", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  await installStaleIntentOnRunCreate(w, w.planning.id, action.actionId, "stale");
  // 1단계: run 생성 뒤 두 번째 시작 확인이 실패한다(시작 거부 자체는 계약상 정상).
  await expect(qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId))
    .rejects.toThrow("owner_plan_start_intent_stale");
  const [stranded] = await w.runs();
  expect(stranded.status).toBe("pending"); // 미시작 pending 잔존
  expect(stranded.startedAt).toBeNull();
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, stranded.id))).toEqual([]);
  await dropStaleIntentTrigger("stale");
  // 2단계: 현재 오너의 새 요청 C(같은 계획 decision, 별도 actionRequestId)를 실제 경로로 제출한다.
  const fresh = pending(await w.call(w.body()));
  expect(fresh.actionId).not.toBe(action.actionId); // 새 intent 가 오너 이슈의 최신이다
  // 같은-hash PASS 물화가 판정을 pass 로 마감하고 실행 연결은 해당 run 을 가리킨다.
  const refs = record((await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.mission.id }))?.refs);
  expect(record(refs.planQa).status).toBe("pass");
  expect(record(refs.paqoWorkflow).workflowRunId).toBe(stranded.id);
  // 계약: C는 실제 native 시작 또는 정확한 구조 거부를 받아야 한다(조용한 미시작 pending 연결은 불가).
  const runsAfter = await w.runs();
  const nativeStart = runsAfter.some((r) => r.status === "running" && r.startedAt !== null);
  const exactRefusal = fresh.state === "blocked" && typeof fresh.reasonCode === "string" && fresh.reasonCode.length > 0;
  expect(nativeStart || exactRefusal).toBe(true); // 현재 코드: run 은 pending, 응답은 delivery_pending 이면 위반
}, 60000);
