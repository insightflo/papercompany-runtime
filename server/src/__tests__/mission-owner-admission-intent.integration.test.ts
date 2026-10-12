// [Stage 2 admission] owner-linked 실행의 실제 durable wake(agent_wakeup_requests)가
//   frozen 정의/현재 intent·권한버전·세대와 일치할 때만 만들어지는지를 실DB+실경로로 검증한다.
//   callback 호출 횟수가 아니라 durable 행(wake/authority/transition event)로 단언한다.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agentWakeupRequests, agents, createDb, heartbeatRuns, issues, missions,
  toolDefinitions, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { captureExecutionDefinition, type TransactionDb } from "../services/workflow/execution-definition.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const TOOL_COMMAND = `node -e "console.log(JSON.stringify({status:'success',attempt:'owner-execute-stage2-admission'}))"`;
// 즉사 명령(false)은 자식이 먼저 죽어 프로세스 어댑터의 선제 stdin 쓰기가 닫힌 파이프에
// 부딪혀 처리 안 된 EPIPE를 낸다(CI 리눅스에서 재현, PR #368 verify-tests). 공백 포함 문자열은
// 실행 파일로 조회되지 않아 잡힌 채로 즉시 실패한다(= main CI의 codex 부재 ENOENT와 동일 경로,
// 자식이 없으니 EPIPE도 없다). 조회 방식이 나중에 문자열 분할로 바뀌어도 500ms 생존 후 종료하는
// 안전한 자식으로 대체될 뿐이다.
const SEAL_COMMAND = `node -e "setTimeout(()=>process.exit(0),500)"`;
const ACCEPTED_WAKE = ["queued", "claimed", "deferred_issue_execution"];
type Db = ReturnType<typeof createDb>;
type Scenario = Awaited<ReturnType<typeof seedToolRecoveryScenario>> & {
  heartbeatRunId: string; downstreamIssueId: string; liveAgentId: string;
};

describe("mission owner admission intent (real DB + real wake path)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-admission-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (db) await waitForHeartbeatExecutionsToDrain(db);
    setWorkflowToolStepExecutor(null);
    if (db) await db.$client.end({ timeout: 5 });
    await temp?.cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  // Downstream agent step(issue 보유)를 failure-cascade skip 상태로 만들고, 실행정의를
  // frozen 원본으로 고정한 뒤 live 정의를 다른 agent로 바꿔 frozen 준수를 검증 가능하게 한다.
  async function seed(withAssignee: boolean): Promise<Scenario> {
    const s = await seedToolRecoveryScenario({ db, artifactExists: true });
    roots.push(s.tempRoot);
    // [테스트 밀봉] 이 테스트는 깨어난 하위 실행의 어댑터 결과를 단언하지 않는다. 기본 codex_local
    // 설정(adapterConfig:{})은 실제 codex CLI 자식을 띄워 afterAll 드레인이 vitest 기본
    // hookTimeout(10s)을 넘긴다. 빠르게 확정 수렴하는 SEAL_COMMAND로 덮어 쓴다.
    await db.update(agents).set({ adapterConfig: { command: SEAL_COMMAND } })
      .where(eq(agents.id, s.ownerAgentId));
    const tools = await db.insert(toolDefinitions).values([
      { companyId: s.companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
      { companyId: s.companyId, name: "collect-us-stockflow", adapterType: "builtin", adapterConfig: { command: TOOL_COMMAND } },
    ]).returning();
    await db.insert(agentToolGrants).values(tools.map((tool) => (
      { companyId: s.companyId, agentId: s.ownerAgentId, toolId: tool.id, grantedBy: "test" })));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: s.companyId,
      agentId: s.ownerAgentId, issueId: s.recoveryIssueId, status: "succeeded" });
    await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
      discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    const downstreamIssueId = randomUUID();
    await db.insert(issues).values({ id: downstreamIssueId, companyId: s.companyId, missionId: s.missionId,
      assigneeAgentId: withAssignee ? s.ownerAgentId : null, originKind: "workflow_execution",
      originRunId: s.workflowRunId, status: "todo", title: "Summarize stockflow" });
    await db.update(workflowStepRuns).set({ issueId: downstreamIssueId,
      metadata: { controlFlowSkipped: true } }).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
    const [run] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns)
      .where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowRuns).set({ status: "pending", startedAt: null, completedAt: null,
      metadata: { executionDefinitionVersion: 1 } }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.transaction(async (tx) => captureExecutionDefinition(tx as unknown as TransactionDb, s.workflowRunId));
    const liveAgentId = randomUUID();
    await db.update(workflowDefinitions).set({ stepsJson: [
      { id: "collect-us-stockflow", name: "Collect US stockflow", type: "tool", dependencies: [], toolNames: ["collect-us-stockflow"] },
      { id: "summarize-stockflow", name: "Summarize stockflow", type: "agent", agentId: liveAgentId, dependencies: ["collect-us-stockflow"] },
    ] }).where(eq(workflowDefinitions.id, run.workflowId));
    await db.update(workflowRuns).set({ status: "failed", startedAt: new Date("2026-07-06T04:52:47.000Z"),
      completedAt: new Date("2026-07-06T04:56:23.000Z") }).where(eq(workflowRuns.id, s.workflowRunId));
    return { ...s, heartbeatRunId, downstreamIssueId, liveAgentId };
  }
  const ownerBody = (s: Scenario) => ({ schemaVersion: 1 as const, missionId: s.missionId,
    ownerActionIssueId: s.recoveryIssueId, actionRequestId: randomUUID(),
    expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "retry_step" as const, target: { kind: "tool_step" as const,
      workflowRunId: s.workflowRunId, stepRunId: s.stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: 0, failedDispatchRequestId: null } } });
  function callExecute(s: Scenario, body: unknown) {
    return executeCoreWorkflowTool({ db, companyId: s.companyId, agentId: s.ownerAgentId,
      heartbeatRunId: s.heartbeatRunId, toolName: "mission_owner_execute",
      parameters: body, requestId: randomUUID() });
  }
  const getResult = (s: Scenario, actionId: string) =>
    getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.ownerAgentId,
      heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.missionId, actionId });
  // Production-path executor replica: real builtin tool + midHook + real completion path.
  function installRealExecutor(midHook?: () => Promise<void>) {
    setWorkflowToolStepExecutor(async (request) => {
      const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId,
        agentId: request.agentId, agentName: request.agentName, toolName: request.toolName,
        parameters: request.args ?? {}, requestId: request.requestId,
        workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
      const success = coreResult.status === 200;
      if (midHook) await midHook();
      await completeWorkflowToolStepFromResult(db, { companyId: request.companyId,
        stepRunId: request.stepRunId, requestId: request.requestId, workflowRunId: request.workflowRunId,
        stepId: request.stepId, toolName: request.toolName, success,
        stdout: coreResult.body.content ?? "", data: coreResult.body.data,
        stderr: coreResult.body.stderr ?? "", exitCode: success ? 0 : 1, error: coreResult.body.error });
      return { accepted: true as const };
    });
  }
  const stepRow = async (stepRunId: string) =>
    (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!;
  const downstreamWakes = async (s: Scenario) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowRunId, s.workflowRunId)))
    .filter((w) => w.workflowStepRunId === s.downstreamStepRunId);
  const authorities = (s: Scenario) => db.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));

  it("admits the dependent agent wake after a real owner retry, matching the frozen definition agent", async () => {
    const s = await seed(false); // assignee resolved from the frozen step
    installRealExecutor();
    const first = await callExecute(s, ownerBody(s));
    expect(first.status).toBe(200);
    expect((first.body.data as { state: string }).state).toBe("executing");
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
    expect((await stepRow(s.downstreamStepRunId)).status).toBe("pending"); // revived, awaiting claim
    const accepted = (await downstreamWakes(s)).filter((w) => ACCEPTED_WAKE.includes(w.status));
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(new Set(accepted.map((w) => w.agentId))).toEqual(new Set([s.ownerAgentId])); // frozen agent
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.downstreamIssueId));
    expect(issue.assigneeAgentId).toBe(s.ownerAgentId);
    expect(issue.assigneeAgentId).not.toBe(s.liveAgentId);
    // No implicit cap-override branch fired (⑦): durable traces only.
    expect(await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "owner_cap_override_retry")))).toHaveLength(0);
    expect((await downstreamWakes(s)).every((w) => !String(w.idempotencyKey ?? "").startsWith("cap-override-wake:"))).toBe(true);
    const rows = await authorities(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recoveryKind).toBe("supervision_tool_retry");
  });

  it.each(["superseding_intent", "mission_stopped"] as const)(
    "creates no durable wake when %s lands right before wake admission", async (variant) => {
      const s = await seed(true); // pre-assigned downstream issue: blocked wake must mutate nothing
      installRealExecutor(async () => {
        if (variant === "superseding_intent") await callExecute(s, ownerBody(s)); // fresh intent supersedes
        else await db.update(missions).set({ status: "paused" }).where(eq(missions.id, s.missionId));
      });
      const before = (await db.select().from(issues).where(eq(issues.id, s.downstreamIssueId)))[0];
      const first = await callExecute(s, ownerBody(s));
      expect(first.status).toBe(200);
      await processQueuedWorkflowToolStepRuns(db);
      expect((await stepRow(s.stepRunId)).status).toBe("completed"); // the attempt itself finished
      expect(await downstreamWakes(s)).toHaveLength(0); // but its stale wake was not admitted
      const [after] = await db.select().from(issues).where(eq(issues.id, s.downstreamIssueId));
      expect(after).toEqual(before); // wake path made zero side effects
    });

  it("leaves unrelated workflows' wakes untouched (no owner linkage, human path)", async () => {
    const s = await seed(true);
    await db.update(workflowRuns).set({ status: "running", completedAt: null })
      .where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "running", completedAt: null,
      lastDispatchRequestId: "legacy-dispatch-1", lastDispatchAcceptedAt: new Date() })
      .where(eq(workflowStepRuns.id, s.stepRunId));
    await completeWorkflowToolStepFromResult(db, { companyId: s.companyId, stepRunId: s.stepRunId,
      workflowRunId: s.workflowRunId, requestId: "legacy-dispatch-1", success: true,
      toolName: "collect-us-stockflow", stdout: "legacy ok" });
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
    expect((await downstreamWakes(s)).filter((w) => ACCEPTED_WAKE.includes(w.status)).length)
      .toBeGreaterThanOrEqual(1); // existing behavior preserved
  });

  it("recovers delivery only on replay and then admits the wake under the still-current intent", async () => {
    const s = await seed(true);
    installRealExecutor();
    const body = ownerBody(s);
    const first = await callExecute(s, body);
    const action = first.body.data as { actionId: string };
    const before = await stepRow(s.stepRunId);
    await db.update(workflowStepRuns).set({ status: "pending", startedAt: null,
      lastDispatchRequestId: null, lastDispatchAcceptedAt: null,
      metadata: { ownerToolRetry: before.metadata.ownerToolRetry } })
      .where(eq(workflowStepRuns.id, s.stepRunId)); // crash between native commit and queue delivery
    const replay = await callExecute(s, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ actionId: action.actionId, state: "executing" });
    expect(await authorities(s)).toHaveLength(1); // delivery only — no second reset/authority
    const redelivered = await stepRow(s.stepRunId);
    expect(redelivered.lastDispatchRequestId).toBeTruthy();
    expect(redelivered.executionGeneration).toBe(1);
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
    expect((await getResult(s, action.actionId)).state).toBe("resolved");
    expect((await downstreamWakes(s)).filter((w) => ACCEPTED_WAKE.includes(w.status)).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("does not complete a new intent via the old receipt and rejects delayed stale results", async () => {
    const s = await seed(true);
    installRealExecutor();
    const first = await callExecute(s, ownerBody(s));
    const action = first.body.data as { actionId: string };
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
    // Old receipt must not complete a fresh intent (⑤): the new action is evaluated, not resolved.
    const nextBody = { ...ownerBody(s), action: { ...ownerBody(s).action,
      target: { ...ownerBody(s).action.target, expectedAuthorityVersion: 1, expectedExecutionGeneration: 1 } } };
    const next = await callExecute(s, nextBody);
    expect(next.status).toBe(200);
    expect((next.body.data as { state: string }).state).toBe("blocked");
    expect(await authorities(s)).toHaveLength(1);
    // Delayed result from a superseded dispatch must not touch the current generation (⑥).
    const before = await stepRow(s.stepRunId);
    const late = await completeWorkflowToolStepFromResult(db, { companyId: s.companyId,
      stepRunId: s.stepRunId, requestId: "stale-pre-retry-dispatch", success: true,
      toolName: "collect-us-stockflow", stdout: "late" });
    expect(late).toBeNull();
    expect(await stepRow(s.stepRunId)).toEqual(before);
  });
});
