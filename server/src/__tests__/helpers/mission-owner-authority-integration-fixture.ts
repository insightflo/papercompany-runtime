// server/src/__tests__/helpers/mission-owner-authority-integration-fixture.ts
//
// [Stage 9] 여섯 operation 의 통합 fixture. 각 단계(1~8) 테스트가 검증한 실DB 시드 구조(qa-loop 세계·계획
//   체인·승인 생산자)를 재사용해 최종 caller(executeCoreWorkflowTool mission_owner_execute)부터 현재 결과 readback까지
//   실제 경로로 구동한다. 관측값은 기대값을 미리 쓰지 않는다 — dispatch 는 실제 DB 행, artifact 는 등록+실제
//   파일 bytes, QA 는 공식 판정(독립 actor)을 독립 읽기한다. board 선택은 owner 가 합성하지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  agentToolGrants, agentWakeupRequests, agents, companies, heartbeatRuns, issueWorkProducts, issues, missions,
  toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTerminalDecisions,
  workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { ArtifactContract } from "@paperclipai/shared";
import type { OwnerActionResult } from "../../services/missions/mission-owner-execution-state.js";
import { admittedProducer } from "./admitted-producer.js";
import { workProductService } from "../../services/work-products.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { executeCoreWorkflowTool } from "../../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor, syncWorkflowRunState } from "../../services/workflow/dag-engine.js";
import { getMissionOwnerActionResult } from "../../services/missions/mission-owner-execute.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { submitMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-agent-api.js";

export type AuthorityOperation = "retry_step" | "resume_run" | "revise_plan" | "recollect" | "delegate_fix" | "reassign";
export type AuthorityVariant = "eligible" | "stopped" | "missing_evidence" | "stale_intent";
export type OwnerAuthorityObservation = { result: OwnerActionResult; nativeDispatchCount: number;
  currentArtifactVerified: boolean; currentQaVerified: boolean };
const FEED_URL = "https://example.test/feed";
const FINDING_ARTIFACT = [{ id: "chart-wrong", summary: "report chart uses a stale series", layer: "artifact" as const }];
const FINDING_SOURCE = [{ id: "kr-missing", summary: "kr_index absent from collected feed", layer: "source_data" as const }];
// 수집 도구는 마지막 CLI 인자(--out 경로)에 실제 파일을 쓰고 같은 내용을 stdout 한다 — 등록 영수증과 실제 파일을 함께 검증.
const COLLECT_COMMAND = `node -e "const fs=require('fs'),a=process.argv.slice(2),p=a[a.indexOf('--out')+1];fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify({status:'success',out:p}));console.log(JSON.stringify({status:'success',out:p}))" --`;
const QA_MJS = `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const r={schemaVersion:'workflow.qa-result.v1',ok:true,checks:[{id:'fixture',ok:true,detail:process.env.PAPERCLIP_REQUEST_ID}],
inputDigest:{sha256:v.content.sha256,mode:'content'},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(r));`;
const qaContract: ArtifactContract = { role: "qa", resultFileName: "inspection.json", resultAdapter: "generic", resultSchemaVersion: "workflow.qa-result.v1",
  inputParams: { content: "document" }, deploymentFiles: ["qa.mjs"], inputEnvelopeVersion: "workflow.artifact-input.v1" };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type PendingOf = { actionId: string; state: string; reasonCode: string | null; requiredAction: { kind: string; targetId: string; reasonCode: string } | null };
export const pendingOf = (response: { body: { data?: unknown } }) => record(record(response.body).data) as unknown as PendingOf;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** app.ts 운영 executor 와 동일한 결합(큐 claim → 코어 도구 실행 → 결과 완료 기록). 테스트 파일 beforeAll 에서 설치. */
export function installAuthorityToolExecutor(db: Db): void {
  setWorkflowToolStepExecutor(async (request) => {
    const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId, agentId: request.agentId, agentName: request.agentName,
      toolName: request.toolName, parameters: request.args ?? {}, requestId: request.requestId, workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId, requestId: request.requestId,
      workflowRunId: request.workflowRunId, stepId: request.stepId, toolName: request.toolName, success: coreResult.status === 200,
      stdout: coreResult.body.content ?? "", data: coreResult.body.data, stderr: coreResult.body.stderr ?? "",
      exitCode: coreResult.status === 200 ? 0 : 1, artifactPath: coreResult.artifactPath, toolArtifactReceipt: coreResult.toolArtifactReceipt, error: coreResult.body.error });
    return { accepted: true as const };
  });
}

export type AuthorityWorld = {
  companyId: string; ownerAgentId: string; qaAgentId: string; newAgentId: string | null; missionId: string;
  workflowRunId: string; collectorStepRunId: string; collectorOutPath: string; collectorSourceRefs: string[];
  collectorTarget: { kind: "tool_step"; workflowRunId: string; stepRunId: string; expectedAuthorityVersion: number; expectedExecutionGeneration: number; failedDispatchRequestId: null };
  producerStepRunId: string; producerIssueId: string; qaIssueId: string; ownerActionIssueId: string; heartbeatRunId: string;
  verdictEventId: string | null; findingIds: string[]; terminalDecisionId: string | null; // qaIssueId 는 시나리오가 현재 스코프 이슈로 갱신한다
  planningIssueId: string | null; planDecision: ((assigneeAgentId: string) => Record<string, unknown>) | null;
  artifactIssueId: string | null; artifactProducerAgentId: string | null; evidenceAfter: Date;
  runIds: () => Promise<string[]>; getResult: (actionId: string) => Promise<OwnerActionResult>;
  call: (action: Record<string, unknown>, actionRequestId?: string) => Promise<{ status: number; body: { data?: unknown } }>; };

/** [QA-loop 세계] collector(tool, out 파일 작성) → producer(agent, back-edge) → QA(독립 agent) 실구조 run.
 *  옵션으로 계획 체인(planning issue+plan-qa-check 도구), reassign 새 agent, 공식 반려 판정을 붙인다. */
export type AuthorityWorldOptions = {
  runStatus?: "running" | "failed"; collectorStatus?: "completed" | "failed"; qaStepStatus?: "pending" | "failed";
  terminal?: { policyCause: string; decision?: string } | null; findings?: Array<{ id: string; summary: string; layer: "artifact" | "source_data" }>;
  planAttach?: boolean; newAgent?: boolean; skipSeedArtifact?: boolean; };
export async function authorityWorld(db: Db, root: string, options: AuthorityWorldOptions = {}): Promise<AuthorityWorld> {
  const ids = { companyId: randomUUID(), ownerAgentId: randomUUID(), qaAgentId: randomUUID(), newAgentId: randomUUID(),
    missionId: randomUUID(), workflowRunId: randomUUID(), collectorStepRunId: randomUUID(), producerStepRunId: randomUUID(),
    qaStepRunId: randomUUID(), producerIssueId: randomUUID(), qaIssueId: randomUUID(), ownerActionIssueId: randomUUID() };
  const collectorOutPath = path.join(root, "missions", ids.missionId, "collector", "out.json"); // 수집 산출물 실제 파일 경로(고유)
  await db.insert(companies).values({ id: ids.companyId, name: "Authority Co", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values([{ id: ids.ownerAgentId, companyId: ids.companyId, name: "Owner", role: "operator", status: "active", adapterType: "process" },
    { id: ids.qaAgentId, companyId: ids.companyId, name: "QA", role: "operator", status: "active", adapterType: "process" },
    ...(options.newAgent ? [{ id: ids.newAgentId, companyId: ids.companyId, name: "New Worker", role: "worker", status: "active", adapterType: "process" }] : [])]);
  await db.insert(missions).values({ id: ids.missionId, companyId: ids.companyId, ownerAgentId: ids.ownerAgentId, title: "Authority mission", status: "active" });
  const tools = await db.insert(toolDefinitions).values([{ companyId: ids.companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
    { companyId: ids.companyId, name: "collect-feed", adapterType: "builtin", adapterConfig: { command: COLLECT_COMMAND } },
    ...(options.planAttach ? [{ companyId: ids.companyId, name: "plan-qa-check", adapterType: "builtin", description: "Mock artifact tool",
      adapterConfig: { command: `${process.execPath} ${path.join(root, "qa.mjs")}`, workingDirectory: root, capabilities: ["structural_validation_v1"], artifactContract: qaContract } }] : [])]).returning();
  await db.insert(agentToolGrants).values(tools.flatMap((tool) => [{ companyId: ids.companyId, agentId: ids.ownerAgentId, toolId: tool.id, grantedBy: "test" },
    ...(options.newAgent ? [{ companyId: ids.companyId, agentId: ids.newAgentId, toolId: tool.id, grantedBy: "test" }] : [])]));
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: ids.companyId, name: "authority-qa-loop", stepsJson: [
    { id: "collect-feed", name: "Collect", type: "tool", toolNames: ["collect-feed"], toolArgs: { url: FEED_URL, out: collectorOutPath }, dependencies: [] },
    { id: "produce", name: "Produce", agentId: ids.ownerAgentId, dependencies: ["collect-feed"], graphWorkProductRequired: true, conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
    { id: "qa-validate", name: "QA", type: "qa", agentId: ids.qaAgentId, dependencies: ["produce"] }] }).returning();
  await db.insert(workflowRuns).values({ id: ids.workflowRunId, workflowId: definition!.id, companyId: ids.companyId, missionId: ids.missionId, triggeredBy: "test", status: options.runStatus ?? "running", startedAt: new Date() });
  await db.insert(issues).values([
    { id: ids.producerIssueId, companyId: ids.companyId, missionId: ids.missionId, assigneeAgentId: ids.ownerAgentId, originKind: "workflow_execution", status: "done", title: "produce report", completedAt: new Date(Date.now() - 60_000) },
    { id: ids.qaIssueId, companyId: ids.companyId, missionId: ids.missionId, assigneeAgentId: ids.qaAgentId, originKind: "workflow_execution", status: "done", title: "qa-validate", completedAt: new Date(Date.now() - 30_000) },
    { id: ids.ownerActionIssueId, companyId: ids.companyId, missionId: ids.missionId, assigneeAgentId: ids.ownerAgentId, originKind: "mission_main_executor_unblock", status: "todo", title: "[Owner Action] authority" },
    { id: randomUUID(), companyId: ids.companyId, missionId: ids.missionId, assigneeAgentId: ids.ownerAgentId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] authority" }]);
  await db.insert(workflowStepRuns).values([
    { id: ids.collectorStepRunId, workflowRunId: ids.workflowRunId, stepId: "collect-feed", issueId: null, status: options.collectorStatus ?? "completed",
      ...(options.collectorStatus === "failed" ? { startedAt: new Date(), completedAt: new Date(), lastDispatchErrorSummary: "feed unavailable", metadata: { toolInvocation: { toolName: "collect-feed", args: { url: FEED_URL, out: collectorOutPath } }, toolResult: { toolName: "collect-feed", success: false, error: "feed unavailable" } } } : { completedAt: new Date(Date.now() - 120_000) }) },
    { id: ids.producerStepRunId, workflowRunId: ids.workflowRunId, stepId: "produce", issueId: ids.producerIssueId, status: "completed", iterationIndex: 0, completedAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 90_000) },
    { id: ids.qaStepRunId, workflowRunId: ids.workflowRunId, stepId: "qa-validate", issueId: ids.qaIssueId, status: options.qaStepStatus ?? "pending",
      ...(options.qaStepStatus === "failed" ? { startedAt: new Date(Date.now() - 45_000), completedAt: new Date(Date.now() - 30_000) } : {}) }]);
  let terminalDecisionId: string | null = null;
  if (options.terminal) { const [row] = await db.insert(workflowTerminalDecisions).values({ companyId: ids.companyId, workflowRunId: ids.workflowRunId,
    decidedAuthorityVersion: 0, decision: options.terminal.decision ?? "failed", policyCause: options.terminal.policyCause, discoveryPath: "stuck_diagnostic", origin: "reconciler" }).returning(); terminalDecisionId = row!.id; }
  if (!options.skipSeedArtifact) { // 완료된 생산자의 등록 산출물(옛 증거 — evidenceAfter 이전이라 현재 시도 증거가 되지 않는다)
    // [2026-10-18 미봉인 등록 거부 대응] 스텝 바인딩 이슈의 등록은 이제 연결 신원(하트비트+웨이크 시도증명)만
    //   통과한다(workproduct_producer_unlinked_registration). 시드를 실제 디스패치와 동일한
    //   연결 신원으로 만든다 — 세대·시도는 producerStepRun 기본값(0/0/0)과 일치.
    const seedHeartbeatId = randomUUID(), seedWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: seedWakeId, companyId: ids.companyId, agentId: ids.ownerAgentId,
      source: "automation", requestedByActorType: "system", requestKind: "workflow_dispatch",
      missionId: ids.missionId,
      issueId: ids.producerIssueId, workflowRunId: ids.workflowRunId, workflowStepRunId: ids.producerStepRunId,
      workflowExecutionGeneration: 0, runId: seedHeartbeatId, status: "delivered",
      payload: { __paperclipWorkflowProducerAttempt: { schemaVersion: 1, companyId: ids.companyId, agentId: ids.ownerAgentId,
        issueId: ids.producerIssueId, missionId: ids.missionId, workflowRunId: ids.workflowRunId, stepRunId: ids.producerStepRunId,
        executionGeneration: 0, retryCount: 0, iterationIndex: 0, wakeupRequestId: seedWakeId, parentHeartbeatRunId: null } } });
    await db.insert(heartbeatRuns).values({ id: seedHeartbeatId, companyId: ids.companyId, agentId: ids.ownerAgentId, issueId: ids.producerIssueId,
      wakeupRequestId: seedWakeId, workflowStepRunId: ids.producerStepRunId, workflowExecutionGeneration: 0,
      startedAt: new Date(), status: "succeeded" });
    const seedArtifact = path.join(root, "missions", ids.missionId, "seed", "content.json"), seedBytes = Buffer.from('{"blocks":["seed"]}');
    await mkdir(path.dirname(seedArtifact), { recursive: true }); await writeFile(seedArtifact, seedBytes);
    await workProductService(db).createForIssue(ids.producerIssueId, ids.companyId, { provider: "local_file", type: "document", title: "content.json",
      status: "active", createdByRunId: seedHeartbeatId, metadata: { path: seedArtifact, sha256: sha256(seedBytes) } });
  }
  let verdictEventId: string | null = null;
  if (options.findings) { // 공식 QA 반려 판정: 독립 QA actor 의 QA 이슈 스코프 heartbeat → workflow_api request_changes.
    const qaHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: qaHeartbeatId, companyId: ids.companyId, agentId: ids.qaAgentId, issueId: ids.qaIssueId, status: "succeeded" });
    const [qaIssueRow] = await db.select().from(issues).where(eq(issues.id, ids.qaIssueId));
    await recordWorkflowValidationVerdict({ db, issue: qaIssueRow!, verdict: "request_changes", source: "workflow_api", actorAgentId: ids.qaAgentId, heartbeatRunId: qaHeartbeatId, findings: options.findings });
    const [verdictEvent] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, ids.companyId), eq(workflowTransitionEvents.issueId, ids.qaIssueId), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"))).limit(1);
    verdictEventId = verdictEvent!.id;
  }
  let planningIssueId: string | null = null; let planDecision: AuthorityWorld["planDecision"] = null;
  if (options.planAttach) { // 계획 체인 부속: 검수 도구 배포 + planning issue + 초기 plan refs + 구조적 decision.
    await writeFile(path.join(root, "qa.mjs"), QA_MJS);
    const [planning] = await db.insert(issues).values({ companyId: ids.companyId, missionId: ids.missionId, title: "PLAN", originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: ids.ownerAgentId }).returning();
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: ids.companyId, missionId: ids.missionId,
      refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    planningIssueId = planning!.id;
    planDecision = (assigneeAgentId: string) => ({ missionId: ids.missionId, missionGoal: "Authority plan", selectedPlanTemplateIds: [],
      selectedExecutionUnits: [
        { id: "write", title: "Write", selectionState: "selected", reason: "unit", assigneeAgentId, sourceRef: { type: "mission_plan_unit", id: "write" }, graphWorkProductRequired: true, dependencies: [] },
        { id: "check", title: "Check", selectionState: "selected", reason: "unit", assigneeAgentId, sourceRef: { type: "mission_plan_unit", id: "check" }, type: "tool", qaType: "structural", toolNames: ["plan-qa-check"], toolArgs: { document: "{$steps.write.workProductPath}" },
          workProductSelectors: { write: { type: "document", title: "content.json" } }, toolArtifactContract: { schemaVersion: "workflow.qa-result.v1", role: "qa", inputStepId: "write" }, dependencies: ["write"] }],
      ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
      assessment: { objectiveRestatement: "Authority plan", availableAssetsReviewed: [], assetEvaluation: [], gaps: [], researchPerformed: [] } });
  }
  const [ownerHeartbeat] = await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: ids.companyId, agentId: ids.ownerAgentId, issueId: ids.ownerActionIssueId, status: "succeeded" }).returning({ id: heartbeatRuns.id });
  return { ...ids, heartbeatRunId: ownerHeartbeat!.id, newAgentId: options.newAgent ? ids.newAgentId : null, collectorOutPath, collectorSourceRefs: [FEED_URL, collectorOutPath],
    collectorTarget: { kind: "tool_step", workflowRunId: ids.workflowRunId, stepRunId: ids.collectorStepRunId, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null },
    verdictEventId, findingIds: (options.findings ?? []).map((finding) => finding.id), terminalDecisionId,
    planningIssueId, planDecision, artifactIssueId: null, artifactProducerAgentId: null, evidenceAfter: new Date(),
    runIds: async () => (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, ids.missionId))).map((r) => r.id),
    call: (action, actionRequestId = randomUUID()) => executeCoreWorkflowTool({ db, companyId: ids.companyId, agentId: ids.ownerAgentId,
      heartbeatRunId: ownerHeartbeat!.id, toolName: "mission_owner_execute", requestId: randomUUID(), parameters: { schemaVersion: 1,
        missionId: ids.missionId, ownerActionIssueId: ids.ownerActionIssueId, actionRequestId, expectedIntentEventId: null, ownerDecisionEventId: null, action } }),
    getResult: (actionId) => getMissionOwnerActionResult({ db, companyId: ids.companyId, agentId: ids.ownerAgentId,
      heartbeatRunId: ownerHeartbeat!.id }, { schemaVersion: 1, missionId: ids.missionId, actionId }) };
}

/** [실제 생산자 구동] 승인 입장 → 실제 산출물 등록(파일+sha) → 이슈 종결 → (QA 성격 이슈면 구조 판정) → 엔진 동기화. */
export async function settleAgentProducer(db: Db, w: AuthorityWorld, input: { runId: string; agentId: string; issueId: string; stepRunId: string; label: string }): Promise<void> {
  const heartbeatId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, input.stepRunId));
  await admittedProducer(db, { companyId: w.companyId, agentId: input.agentId, issueId: input.issueId, stepRunId: input.stepRunId, heartbeatId });
  const file = path.join(path.dirname(w.collectorOutPath), input.label, "content.json"), bytes = Buffer.from(`{"blocks":["${input.label}"]}`);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  await workProductService(db).createForIssue(input.issueId, w.companyId, { provider: "local_file", type: "document", title: "content.json",
    status: "active", createdByRunId: heartbeatId, metadata: { path: file, sha256: sha256(bytes) } });
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, input.issueId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
  await recordWorkflowValidationVerdict({ db, issue: issue!, verdict: "pass", source: "workflow_api", actorAgentId: input.agentId, heartbeatRunId: heartbeatId }); // QA 성격 이슈는 구조 판정이 완료를 소유(생산 이슈 no-op)
  await syncWorkflowRunState(db, input.runId);
}

/** [독립 현재 QA] 이슈에 독립 actor 의 공식 pass 판정을 실제 verdict API 로 제출한다. */
export async function submitIndependentQaPass(db: Db, w: AuthorityWorld, issueId = w.qaIssueId): Promise<void> {
  const heartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: w.companyId, agentId: w.qaAgentId, issueId, status: "succeeded" });
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  await recordWorkflowValidationVerdict({ db, issue: issue!, verdict: "pass", source: "workflow_api", actorAgentId: w.qaAgentId, heartbeatRunId: heartbeatId }); }

/** [독립 PLAN-QA pass] 별도 actor(실제 verdict API) — owner 와 다른 결정 채널이다. */
export async function planQaPass(db: Db, w: AuthorityWorld, planQaIssueId: string): Promise<void> {
  await submitMissionPlanQaVerdict({ db, issue: { id: planQaIssueId, companyId: w.companyId, missionId: w.missionId, originKind: "mission_plan_qa" },
    actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null }, data: { verdict: "pass", diagnostics: [] } }); }

/** [계획 파이프라인] 독립 PLAN-QA pass → 물화 → native run → write 생산 → 실제 검수 도구 → final QA → 종결. */
export async function runPlanToCompletion(db: Db, w: AuthorityWorld, planQaIssueId: string): Promise<void> {
  await planQaPass(db, w, planQaIssueId);
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.missionId, w.missionId), ne(workflowRuns.id, w.workflowRunId)));
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, w.companyId), eq(workflowDefinitions.missionId, w.missionId)));
  const toolStepId = ((definition!.stepsJson ?? []) as Array<{ id: string; toolNames?: string[] }>).find((step) => (step.toolNames ?? []).includes("plan-qa-check"))!.id;
  const rows = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const write = (await rows()).find((row) => row.issueId !== null && row.stepId !== toolStepId)!; // 물화된 정의의 write 스텝(수동 seed 아님)
  w.artifactIssueId = write.issueId!; // 현재 시도 산출물 probe 대상 = 이 실행의 write 스텝 이슈
  await settleAgentProducer(db, w, { runId: run.id, agentId: w.artifactProducerAgentId ?? w.ownerAgentId, issueId: write.issueId!, stepRunId: write.id, label: "write" });
  await syncWorkflowRunState(db, run.id); // 생산 완료 → 게이트 발사·큐잉
  await processQueuedWorkflowToolStepRuns(db); // 실제 로컬 검수 도구 실행(현재 run 의 dispatch)
  await syncWorkflowRunState(db, run.id); // 게이트 완료 → final QA 이슈 발사
  const finalQa = (await rows()).find((row) => row.issueId !== null && row.id !== write.id)!;
  await settleAgentProducer(db, w, { runId: run.id, agentId: w.qaAgentId, issueId: finalQa.issueId!, stepRunId: finalQa.id, label: "final-qa" });
  w.qaIssueId = finalQa.issueId!; // 현재 스코프의 공식 판정은 이 실행의 final QA 이슈다
  await syncWorkflowRunState(db, run.id);
}

/** [구조적 신규 intent] 같은 오너 이슈에 facade 가 쓰는 것과 같은 형태의 더 최신 의도 행을 넣는다(경합 재현). */
export async function insertNewerOwnerIntent(db: Db, w: AuthorityWorld): Promise<void> {
  await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId, issueId: w.ownerActionIssueId,
    heartbeatRunId: w.heartbeatRunId, eventType: "owner_execute_intent_v1", layer: "mission_owner_authority", reason: "mission_owner_execute", reasonCode: "mission_owner_execute",
    idempotencyKey: `mission-owner-execute:v1:${w.companyId}:${w.missionId}:${w.ownerActionIssueId}:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: w.missionId, ownerActionIssueId: w.ownerActionIssueId,
      actionRequestId: randomUUID(), heartbeatRunId: w.heartbeatRunId, agentId: w.ownerAgentId,
      action: { operation: "retry_step", target: { kind: "tool_step", workflowRunId: randomUUID(), stepRunId: randomUUID(), expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } }, bodyFingerprint: randomUUID() } });
}

/** [독립 readback] 기대값을 쓰지 않는다 — dispatch 는 실제 DB 행, artifact 는 등록+실제 파일 bytes, QA 는 공식 판정. */
export async function observeAuthority(db: Db, w: AuthorityWorld, result: OwnerActionResult): Promise<OwnerAuthorityObservation> {
  const runIds = await w.runIds();
  const nativeDispatchCount = (await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
    .where(and(inArray(workflowStepRuns.workflowRunId, runIds), isNotNull(workflowStepRuns.lastDispatchRequestId)))).length;
  let currentArtifactVerified = false;
  if (w.artifactIssueId) { // agent 생산: 현재 시도(evidenceAfter 이후, 예상 생산자)의 등록 산출물 + 실제 파일 sha 일치
    const products = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, w.companyId), eq(issueWorkProducts.issueId, w.artifactIssueId), eq(issueWorkProducts.status, "active")));
    for (const product of products) {
      const meta = record(product.metadata), file = typeof meta.path === "string" ? meta.path : null;
      if (!file || typeof meta.sha256 !== "string" || !product.createdByRunId) continue;
      const [hb] = await db.select({ agentId: heartbeatRuns.agentId, startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, product.createdByRunId)).limit(1);
      if (!hb || (hb.startedAt?.getTime() ?? 0) <= w.evidenceAfter.getTime()) continue; // 옛 등록은 현재 시도 증거가 아니다
      if (w.artifactProducerAgentId && hb.agentId !== w.artifactProducerAgentId) continue;
      try { if (sha256(await readFile(file)) === meta.sha256) { currentArtifactVerified = true; break; } } catch { /* 파일 삭제·스코프 변경 */ }
    }
  } else { // tool 수집: 현재 시도의 실행 영수증(toolResult) + 실제 파일 내용 일치
    const [collector] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.collectorStepRunId));
    const toolResult = record(record(collector?.metadata).toolResult);
    if (collector?.status === "completed" && toolResult.success === true && record(toolResult.data).out === w.collectorOutPath) {
      try { currentArtifactVerified = record(JSON.parse(String(await readFile(w.collectorOutPath)))).out === w.collectorOutPath; } catch { /* 없음 */ } }
  }
  let currentQaVerified = false; // 현재 스코프의 공식 판정 독립 읽기: 최신 workflow_api pass, 독립 actor, 현재 시도 이후
  const [latest] = await db.select({ verdict: workflowTransitionEvents.verdict, createdAt: workflowTransitionEvents.createdAt, heartbeatRunId: workflowTransitionEvents.heartbeatRunId })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.issueId, w.qaIssueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.reason, "workflow_api")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  if (latest && latest.verdict === "pass" && latest.heartbeatRunId && (latest.createdAt?.getTime() ?? 0) > w.evidenceAfter.getTime()) {
    const [hb] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, latest.heartbeatRunId)).limit(1);
    currentQaVerified = !!hb && hb.agentId === w.qaAgentId;
  }
  return { result, nativeDispatchCount, currentArtifactVerified, currentQaVerified };
}

/** [시나리오] operation×variant — 세계 시드 → 최종 caller 호출 → 실제 파이프라인 구동 → 독립 readback.
 *  refused(4xx) 호출에는 action 결과가 없다 — refusal 미러(state blocked + 관측된 reasonCode)로 보고한다. */
export async function runOwnerAuthorityScenario(db: Db, operation: AuthorityOperation,
  variant: AuthorityVariant = "eligible"): Promise<OwnerAuthorityObservation> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `owner-authority-${operation}-`)));
  const finish = async (w: AuthorityWorld, actionId: string) => observeAuthority(db, w, await w.getResult(actionId));
  const producerTarget = (w: AuthorityWorld) => ({ kind: "issue_step", workflowRunId: w.workflowRunId, stepRunId: w.producerStepRunId,
    issueId: w.producerIssueId, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null });
  try {
    if (operation === "revise_plan" || operation === "reassign") { // 계획 체인: 제출 → 독립 PLAN-QA → 물화 → 실제 실행
      const w = await authorityWorld(db, root, { planAttach: true, ...(operation === "reassign" ? { newAgent: true } : {}) });
      const assignee = operation === "reassign" ? w.newAgentId! : w.ownerAgentId;
      w.artifactProducerAgentId = assignee;
      const plan = { planningIssueId: w.planningIssueId, expectedDecisionHash: null, decision: w.planDecision!(assignee) };
      const action = operation === "reassign" ? { operation, target: producerTarget(w), targetAgentId: w.newAgentId, plan } : { operation, plan };
      w.evidenceAfter = new Date();
      const submitted = pendingOf(await w.call(action));
      if (variant === "stopped") { // [QA 직전 stop] 미션 정지 뒤 독립 QA pass 로도 run 이 시작되지 않는다(시작 펜스)
        await db.update(missions).set({ status: "paused" }).where(eq(missions.id, w.missionId));
        try { await planQaPass(db, w, submitted.requiredAction!.targetId); } catch { /* 시작 펜스가 거부 */ }
        return await finish(w, submitted.actionId); }
      await runPlanToCompletion(db, w, submitted.requiredAction!.targetId);
      return await finish(w, submitted.actionId);
    }
    const failed = { runStatus: "failed" as const, collectorStatus: "failed" as const, terminal: { policyCause: "recovery_deadline_hard" } };
    const loops: Partial<Record<AuthorityOperation, Parameters<typeof authorityWorld>[2]>> = {
      retry_step: failed, recollect: failed,
      resume_run: { runStatus: "failed", collectorStatus: "failed", terminal: variant === "stopped"
        ? { policyCause: "operator_cancel", decision: "cancelled" } : { policyCause: "outcome_convergence" } },
      delegate_fix: variant === "missing_evidence" ? { runStatus: "running", qaStepStatus: "failed", findings: FINDING_ARTIFACT, skipSeedArtifact: true }
        : { runStatus: "failed", collectorStatus: "failed", qaStepStatus: "failed", findings: FINDING_SOURCE, terminal: { policyCause: "recovery_deadline_hard" } } };
    const loop = loops[operation];
    if (!loop) throw new Error(`variant_not_supported: ${operation}/${variant}`);
    const w = await authorityWorld(db, root, loop);
    w.evidenceAfter = new Date(); // 세팅 이후의 등록·판정만 현재 시도 증거로 읽는다
    const action = operation === "delegate_fix"
      ? { operation, producerTarget: producerTarget(w), qaVerdictEventId: w.verdictEventId, findingIds: w.findingIds,
        ...(variant === "missing_evidence" ? {} : { collection: { sourceRefs: w.collectorSourceRefs } }) }
      : operation === "recollect" ? { operation, collectorTarget: w.collectorTarget, sourceRefs: w.collectorSourceRefs, mode: "same_configuration" }
      : { operation, target: w.collectorTarget, ...(operation === "resume_run" ? { terminalDecisionId: w.terminalDecisionId!, previewPolicy: "native_failed_anchor_v1" } : {}) };
    const requestId = randomUUID();
    const actionId = pendingOf(await w.call(action, requestId)).actionId;
    if (variant === "stale_intent") { await insertNewerOwnerIntent(db, w); await w.call(action, requestId); }
    if (operation === "delegate_fix" && variant === "missing_evidence")
      await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(), startedAt: new Date() }).where(eq(workflowStepRuns.id, w.producerStepRunId)); // 산출물 등록 없는 완료 상태 — 증거 누락 관찰
    else if (variant !== "stopped") { await processQueuedWorkflowToolStepRuns(db); await submitIndependentQaPass(db, w); }
    return await finish(w, actionId);
  } finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
}
