// server/src/__tests__/mission-owner-plan-admission-stale.test.ts
//
// [PR367 회귀 R2 — 실제 실행 admission이 run context를 소비] ensureOwnerPlanWorkflowRun은 run
//   metadata 에 ownerPlanExecution(actionId·decisionHash)을 저장한다. 실제 실행 경계(tools 큐 admission·도구
//   발사 withCurrentOwnerToolAttempt·wake admission admitOwnerLinkedStepWake)은 이를 읽어 현재성을 재확인한다.
//   plan run이 유효하게 시작된 뒤(정의 물화·write 이슈+wake 생성·구조 게이트 큐잉) 같은 오너 이슈에 더
//   최신 intent가 기록되면, 승인된 계약(저장한 run context를 후속 admission이 읽어 현재성을 재확인)에
//   따라 첫 실제 실행 admission은 연기·거부되어야 한다. 수정 후 기대: executedCount 0 · 게이트 스텝 queued
//   유지 · toolResult 부재. 제품이 다시 도구를 실행하면 계약 회귀다.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, heartbeatRuns, issues, missionPlanDecisionSubmissions,
  missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { workProductService } from "../services/work-products.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-plan-admission-regress-");
  db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-plan-admission-regress-")));
  await writeFile(path.join(root, "qa.mjs"), `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`);
  // app.ts 운영 executor와 동일한 결합: 큐 claim → 코어 도구 실행 → 결과 완료 기록(실경로 복제).
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

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const qaContract: ArtifactContract = { role: "qa", resultFileName: "inspection.json", resultAdapter: "generic",
  resultSchemaVersion: "workflow.qa-result.v1", inputParams: { content: "document" }, deploymentFiles: ["qa.mjs"],
  inputEnvelopeVersion: "workflow.artifact-input.v1" };
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const qaVerdict = (companyId: string, missionId: string, planQaIssueId: string) =>
  submitMissionPlanQaVerdict({ db, issue: { id: planQaIssueId, companyId, missionId, originKind: "mission_plan_qa" },
    actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null }, data: { verdict: "pass", diagnostics: [] } });

async function world() {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "AdmissionRepro", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
  const tools = await db.insert(toolDefinitions).values([
    { companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId, name: "plan-qa-check", adapterType: "builtin", description: "Mock artifact tool",
      adapterConfig: { command: `${process.execPath} ${path.join(root, "qa.mjs")}`, workingDirectory: root,
        capabilities: ["structural_validation_v1"], artifactContract: qaContract } },
  ]).returning();
  await db.insert(agentToolGrants).values(tools.map((tool) => ({ companyId, agentId, toolId: tool.id, grantedBy: "test" })));
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Admission repro", status: "active" }).returning();
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
    assessment: { objectiveRestatement: "Admission repro", availableAssetsReviewed: [], assetEvaluation: [], gaps: [], researchPerformed: [] } });
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

// 계획 intent A의 기록 시각(직접 삽입하는 더 최신 intent의 순서 결정에만 쓴다).
const intentCreatedAt = async (actionId: string) =>
  (await db.select({ createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, actionId)))[0]!.createdAt;
// facade가 쓰는 것과 같은 구조의 비계획 owner 실행 intent 행(기존 테스트 관행과 동일 형태).
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
// 생산(agent) 스텝을 실제 승인 생산자 경로로 완료한다(기존 GREEN 파이프라인 테스트와 동일 기계).
const completeAgentStep = async (w: Awaited<ReturnType<typeof world>>, step: typeof workflowStepRuns.$inferSelect, name: string) => {
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
  const [issueRow] = await db.select().from(issues).where(eq(issues.id, step.issueId));
  await recordWorkflowValidationVerdict({ db, issue: issueRow!, verdict: "pass", source: "workflow_api",
    actorAgentId: w.agentId, heartbeatRunId: heartbeat });
};

it("[control][R2] without a newer owner intent the queued structural tool step executes (setup sanity)", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId);
  const [run] = await w.runs();
  expect(run.status).toBe("running");
  expect(run.metadata).toMatchObject({ ownerPlanExecution: { actionId: action.actionId } });
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.mission.id));
  const toolStepId = ((definition!.stepsJson ?? []) as Array<{ id: string; toolNames?: string[] }>)
    .find((st) => (st.toolNames ?? []).includes("plan-qa-check"))!.id;
  const write = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
    .find((r) => r.issueId !== null && r.stepId !== toolStepId)!;
  await completeAgentStep(w, write, "write");
  await syncWorkflowRunState(db, run.id); // 생산자 완료 동기화 → 구조 게이트 큐잉
  const dispatch = await processQueuedWorkflowToolStepRuns(db);
  expect(dispatch.executedCount).toBeGreaterThanOrEqual(1); // 실제 로컬 도구 실행
  const check = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
    .find((r) => r.stepId === toolStepId)!;
  expect(check.status).toBe("completed");
}, 60000);

it("[R2] a newer owner intent on the plan issue before the first actual execution admission must refuse it", async () => {
  const w = await world();
  const action = pending(await w.call(w.body()));
  await qaVerdict(w.companyId, w.mission.id, action.requiredAction.targetId); // run 유효 시작(스텝/게이트 큐잉 포함)
  const [run] = await w.runs();
  expect(run.status).toBe("running");
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.mission.id));
  const toolStepId = ((definition!.stepsJson ?? []) as Array<{ id: string; toolNames?: string[] }>)
    .find((st) => (st.toolNames ?? []).includes("plan-qa-check"))!.id;
  const write = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
    .find((r) => r.issueId !== null && r.stepId !== toolStepId)!;
  await completeAgentStep(w, write, "write");
  await syncWorkflowRunState(db, run.id); // 구조 게이트 큐잉 — 아직 첫 실제 실행 admission 전
  const before = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
    .find((r) => r.stepId === toolStepId)!;
  expect(before.status).toBe("running"); // 큐잉·발사됐으나 아직 실제 실행은 안 된 게이트 스텝
  expect(before.metadata).not.toHaveProperty("toolResult"); // 실행 결과 부재 = 아직 admission 전
  // 같은 오너 이슈에 더 최신 intent 를 기록한다 — 이 plan run 의 소유 intent 는 이제 stale 다.
  const at = await intentCreatedAt(action.actionId);
  await newerNonPlanIntent(w, w.planning.id, new Date(at.getTime() + 60_000));
  // 계약: stale 소유 intent 아래 첫 실제 실행 admission(queued tool step 처리)은 거부되어야 한다.
  const dispatch = await processQueuedWorkflowToolStepRuns(db);
  expect(dispatch.executedCount).toBe(0); // ← 현재 코드: 실행됨(RED) — metadata.ownerPlanExecution 을 읽는 경계가 없다
  const check = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)))
    .find((r) => r.stepId === toolStepId)!;
  expect(check.status).not.toBe("completed"); // 실제 실행 admission 이 없었으므로 완료될 수 없다
  expect(check.metadata).not.toHaveProperty("toolResult"); // durable 실행 결과 부재
}, 60000);
