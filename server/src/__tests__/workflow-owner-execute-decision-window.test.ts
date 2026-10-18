// [목적] mission_owner_execute 오퍼레이션의 오너 결정 API 창구(POST /issues/:id/owner-recovery/execute)
//   계약 검증. 라이브 사고(2026-10-17): 오너액션 이슈 웨이크 런엔 스텝이 없어 런 도구 계약이
//   만들어지지 않고, mission_owner_execute 플러그인 도구 라우트가 403 으로 원천 거부됐다.
//   이 창구는 기존 owner-recovery 인가 체인(미션 오너·heartbeat identity·체크아웃)으로 같은
//   서비스(executeMissionOwnerAction)를 호출한다 — 새 권한 경로가 아니다.
// [연결] routes/workflow-agent-api.ts, services/missions/owner-execute-decision-window.ts,
//   services/missions/mission-owner-execute.ts(기존 검증·펜스·원장 전부 재사용),
//   packages/shared/src/validators/mission-owner-authority.ts(ownerExecuteApiSchema).
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missions,
  toolDefinitions,
  workflowDefinitions,
  workflowRecoveryAuthorities,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";
import { workProductService } from "../services/work-products.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";
import { buildToolStepRecoveryDescription } from "../services/missions/tool-step-recovery-description.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
const roots: string[] = [];
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-execute-window-");
  db = createDb(temp.connectionString);
}, 60_000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await db.$client.end();
  await temp.cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

const stepRow = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;

type Scenario = Awaited<ReturnType<typeof seed>>;
// 라이브 사고 형태의 시드: 오너액션(unblock) 이슈가 살아 있는 웨이크 런(heartbeat·체크아웃)에
// 묶여 있고, 스텝은 없다. promote 대상 산출물은 과거 정산된 unblock 이슈에서 왔다.
async function seed() {
  const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID();
  const sourceIssueId = randomUUID(), unblockIssueId = randomUUID(), ownerIssueId = randomUUID();
  const delegatedHeartbeatId = randomUUID(), wakeHeartbeatId = randomUUID();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-execute-window-"))); roots.push(root);
  const file = path.join(root, "report.json"); await writeFile(file, '{"report":"rescued"}');
  await db.insert(companies).values({ id: companyId, name: "Owner execute window", issuePrefix: companyId.slice(0, 8), workProductRoot: root });
  await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", status: "active" });
  await db.insert(missions).values({ id: missionId, companyId, title: "Rescued report", ownerAgentId, status: "active" });
  await db.insert(issues).values([
    { id: sourceIssueId, companyId, missionId, title: "Report", originKind: "workflow_execution", status: "done" },
    { id: unblockIssueId, companyId, missionId, title: "Unblock report", originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "in_progress" },
    { id: ownerIssueId, companyId, missionId, title: "Owner wake", originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "in_progress" },
  ]);
  await db.insert(heartbeatRuns).values([
    { id: delegatedHeartbeatId, companyId, agentId: ownerAgentId, issueId: unblockIssueId, status: "succeeded" },
    // 오너액션 이슈 웨이크 런 — 실행 중이고 이슈를 체크아웃했다(사고 때의 실제 형태).
    { id: wakeHeartbeatId, companyId, agentId: ownerAgentId, issueId: ownerIssueId, status: "running" },
  ]);
  await db.update(issues).set({ checkoutRunId: wakeHeartbeatId }).where(eq(issues.id, ownerIssueId));
  // 위임 생산자 증명은 unblock 이슈가 살아 있는 체크아웃 상태여야 한다 — 생성 후 정산한다.
  await db.update(issues).set({ checkoutRunId: delegatedHeartbeatId }).where(eq(issues.id, unblockIssueId));
  const product = (await workProductService(db).createForIssue(sourceIssueId, companyId, {
    type: "document", title: "report.json", provider: "local_file", status: "active", metadata: { path: file },
    createdByRunId: delegatedHeartbeatId,
  }, { kind: "mission_owner_unblock_source", issueId: unblockIssueId }))!;
  await db.update(issues).set({ status: "done", checkoutRunId: null }).where(eq(issues.id, unblockIssueId));
  const script = path.join(root, "inspect.mjs");
  await writeFile(script, "import fs from 'node:fs';const file=process.argv[process.argv.indexOf('--report-path')+1];console.log(JSON.stringify({report:JSON.parse(fs.readFileSync(file,'utf8')).report}));");
  await db.insert(toolDefinitions).values({ companyId, name: "inspect-report", adapterType: "builtin",
    adapterConfig: { command: `${process.execPath} ${script}` } });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Report QA", stepsJson: [
    { id: "report", name: "Report", type: "agent", agentId: ownerAgentId, dependencies: [] },
    { id: "inspect", name: "Inspect", type: "tool", agentId: "", toolNames: ["inspect-report"], dependencies: ["report"],
      toolArgs: { reportPath: "{$steps.report.workProductPath}" }, workProductSelectors: { report: { type: "document", title: "report.json" } } },
  ] });
  const run = await createFrozenRun(db, { companyId, workflowId, missionId });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, run.id));
  await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "report", issueId: sourceIssueId, status: "completed" });
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "inspect", status: "pending" }).returning();
  setWorkflowToolStepExecutor(async r => {
    const result = await executeCoreWorkflowTool({ db, companyId: r.companyId, agentId: r.agentId,
      toolName: r.toolName, parameters: r.args ?? {}, requestId: r.requestId,
      workflowRunId: r.workflowRunId, stepRunId: r.stepRunId, stepId: r.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: r.companyId, workflowRunId: r.workflowRunId,
      stepRunId: r.stepRunId, stepId: r.stepId, requestId: r.requestId, toolName: r.toolName,
      success: result.status === 200, data: result.body.data, stdout: result.body.content ?? "", error: result.body.error });
    return { accepted: true };
  });
  await syncWorkflowRunState(db, run.id);
  const failed = await stepRow(consumer.id);
  expect(failed.status).toBe("failed");
  expect(failed.metadata.toolInvocation).toMatchObject({ dispatchError: "workproduct_selector_provenance_missing" });
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, run.id));
  const [failedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: run.id,
    decidedAuthorityVersion: failedRun.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler" });
  // 창구 페이로드 — ownerActionIssueId 는 경로 파라미터가 공급한다(본문 제공 금지).
  const baseBody = { schemaVersion: 1 as const, missionId, actionRequestId: randomUUID(),
    expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "promote_unblock_product" as const, productId: product.id, producerStepId: "report",
      target: { kind: "tool_step" as const, workflowRunId: run.id, stepRunId: consumer.id,
        expectedAuthorityVersion: failedRun.dispatchAuthorityVersion, expectedExecutionGeneration: failed.executionGeneration,
        failedDispatchRequestId: failed.lastDispatchRequestId } } };
  const app = (actor: Record<string, unknown>) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.actor = actor as never; next(); });
    a.use("/api", workflowAgentApiRoutes(db));
    a.use(errorHandler);
    return a;
  };
  const ownerActor = { type: "agent" as const, agentId: ownerAgentId, runId: wakeHeartbeatId, companyId };
  return {
    companyId, missionId, ownerAgentId, sourceIssueId, unblockIssueId, ownerIssueId, wakeHeartbeatId,
    run, consumer, product, baseBody, app, ownerActor,
    post: (actor: Record<string, unknown>, body: Record<string, unknown> = baseBody) =>
      request(app(actor)).post(`/api/issues/${ownerIssueId}/owner-recovery/execute`).send(body),
    readProduct: async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product.id)))[0]!,
    runEvents: async () => (await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, run.id))),
    authorities: async () => (await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, run.id))),
  };
}

describe("owner decision window for mission_owner_execute (isolated PostgreSQL)", () => {
  it("submits promote_unblock_product from an owner-action issue wake run, applying promotion, retry and activity", async () => {
    const s = await seed();
    const response = await s.post(s.ownerActor);
    expect(response.status).toBe(200);
    const action = response.body as { actionId: string; operation: string; state: string };
    expect(action.operation).toBe("promote_unblock_product");
    expect(action.actionId).toEqual(expect.any(String));
    expect(["executing", "resolved"]).toContain(action.state);
    // 기존 mission_owner_execute 원장·검증 재사용 증거: intent 이벤트가 같은 계약으로 기록됐다.
    const [intent] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.ownerIssueId));
    expect(intent).toMatchObject({ eventType: "owner_execute_intent_v1", layer: "mission_owner_authority", reason: "mission_owner_execute" });
    // 승격 + 재시도 커플링: 산출물 승격, 전이 이벤트, 복구 권한 소비.
    expect((await s.readProduct()).metadata!.workflowProducerPromotion).toMatchObject({
      promotedBy: { actorType: "mission_owner", actorId: s.ownerAgentId } });
    expect((await s.runEvents()).filter(e => (e.payload as { transition?: string })?.transition === "delegated_producer_promoted")).toHaveLength(1);
    expect(await s.authorities()).toHaveLength(1);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "issue.owner_recovery_execute_submitted"));
    expect(activity).toMatchObject({ actorType: "agent", actorId: s.ownerAgentId, entityType: "issue", entityId: s.ownerIssueId });
    // 멱등 replay(창구가 살아 있는 동안) — 같은 actionRequestId 는 같은 actionId 를 반환하고
    // 부작용을 늘리지 않는다. 기존 mission_owner_execute 서비스 멱등 규약이 그대로 흐른다.
    const replay = await s.post(s.ownerActor);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ actionId: action.actionId });
    expect(await s.authorities()).toHaveLength(1);
    // 재시도 실제 적용: 대기 중인 도구 단계를 실행하면 소비 단계가 완성된다.
    await processQueuedWorkflowToolStepRuns(db);
    const completed = await stepRow(s.consumer.id);
    expect(completed.status, JSON.stringify(completed.metadata)).toBe("completed");
    expect(completed.metadata.toolResult).toMatchObject({ success: true, data: { report: "rescued" } });
    expect((await s.runEvents()).filter(e => (e.payload as { transition?: string })?.transition === "delegated_producer_promoted")).toHaveLength(1);
    // 정산 후 창구 폐쇄 — 복구 적용으로 미션 정산이 오너액션 이슈를 done 으로 닫으면, 결정 API 와
    // 동일하게 살아 있는 체크아웃이 없어 새 제출은 거부된다(이중 실행 없음, 서비스 멱등은 무결).
    const settled = await s.post(s.ownerActor, { ...s.baseBody, actionRequestId: randomUUID() });
    expect(settled.status).toBe(409);
    expect(await s.authorities()).toHaveLength(1);
  });

  it("rejects non-owner agents, board users, cross-company access, stray ownerActionIssueId and detached heartbeats", async () => {
    const s = await seed();
    const otherAgentId = randomUUID(), otherHeartbeatId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: s.companyId, name: "Other", status: "active" });
    await db.insert(heartbeatRuns).values({ id: otherHeartbeatId, companyId: s.companyId, agentId: otherAgentId,
      issueId: s.ownerIssueId, status: "running" });
    // 미션 오너가 아닌 에이전트(자기 heartbeat·체크아웃 형제 런) — 결정 API 체인과 동일 거부.
    const nonOwner = await s.post({ type: "agent", agentId: otherAgentId, runId: otherHeartbeatId, companyId: s.companyId });
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.body.error).toContain("Only the mission owner agent");
    // 보드 사용자(사람 경로)·타 company — 창구는 오너 에이전트 런 전용.
    expect((await s.post({ type: "board", source: "session", userId: "human" })).status).toBe(403);
    expect((await s.post({ type: "agent", agentId: s.ownerAgentId, runId: s.wakeHeartbeatId, companyId: randomUUID() })).status).toBe(403);
    // 타 미션 지정 — 창구 인가는 통과하지만 기존 mission_owner_execute 서비스 검증이
    // 오너액션 이슈의 미션과 불일치함을 잡아 거부한다(서비스 재사용 증거).
    const wrongMission = await s.post(s.ownerActor, { ...s.baseBody, missionId: randomUUID() });
    expect(wrongMission.status).toBe(404);
    expect(wrongMission.body.error).toBe("owner_action_issue_not_found");
    // ownerActionIssueId 는 경로가 공급한다 — 본문에 있으면 스키마 거부(경로 우회 금지).
    const stray = await s.post(s.ownerActor, { ...s.baseBody, ownerActionIssueId: s.ownerIssueId });
    expect(stray.status).toBe(400);
    // heartbeat 가 이 이슈에 바인딩되지 않으면 identity mismatch — 사고 때의 403 과 달리 명확한 409.
    await db.update(heartbeatRuns).set({ issueId: s.unblockIssueId }).where(eq(heartbeatRuns.id, s.wakeHeartbeatId));
    const detached = await s.post(s.ownerActor);
    expect(detached.status).toBe(409);
    expect(JSON.stringify(detached.body)).toContain("owner_recovery_submission_identity_mismatch");
    // 거부된 요청은 의도 기록을 남기지 않는다.
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.ownerIssueId))).toHaveLength(0);
    expect((await s.readProduct()).metadata!.workflowProducerPromotion).toBeUndefined();
    expect(await s.authorities()).toHaveLength(0);
  });

  it("keeps the promotion-retry fence: a stale recovery target is refused without promotion or authority", async () => {
    const s = await seed();
    const before = await stepRow(s.consumer.id);
    const body = { ...s.baseBody, action: { ...s.baseBody.action,
      target: { ...s.baseBody.action.target, expectedExecutionGeneration: before.executionGeneration + 1 } } };
    const refused = await s.post(s.ownerActor, body);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("stale_generation");
    expect((await s.readProduct()).metadata!.workflowProducerPromotion).toBeUndefined();
    expect(await s.authorities()).toHaveLength(0);
    expect((await stepRow(s.consumer.id)).status).toBe("failed");
    expect((await s.runEvents()).filter(e => (e.payload as { transition?: string })?.transition === "delegated_producer_promoted")).toHaveLength(0);
  });

  it("points the tool-step recovery brief at the owner decision window instead of the tool-only route", async () => {
    const s = await seed();
    const description = buildToolStepRecoveryDescription({ marker: "test", missionTitle: "test", workflowName: "test",
      workflowRunId: s.run.id, stepId: "inspect", displayStepName: "Inspect", toolNames: [],
      classification: { className: "input_contract", retryPolicy: "fix_input_contract_before_retry",
        rationale: "fixture", requiredAction: "fixture", evidence: [] } });
    // 오너액션 이슈 웨이크 런에서 실제 호출 가능한 창구만 안내한다(플러그인 도구 라우트는 403 이었음).
    expect(description).toContain("/owner-recovery/execute");
    expect(description).toContain("promote_unblock_product");
    expect(description).toContain("adopt_producer_edits");
    expect(description).toContain("a refused retry rolls promotion back");
  });
});
