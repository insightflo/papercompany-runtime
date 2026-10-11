import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants,
  agents,
  createDb,
  heartbeatRuns,
  toolDefinitions,
  workflowRecoveryAuthorities,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { missionOwnerExecuteSchema } from "@paperclipai/shared/validators/mission-owner-authority";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";

const TOOL_COMMAND = `node -e "console.log(JSON.stringify({status:'success',attempt:'owner-execute-stage1-current'}))"`;
type Db = ReturnType<typeof createDb>;
type Scenario = Awaited<ReturnType<typeof seedToolRecoveryScenario>> & { heartbeatRunId: string };

describe("owner action input", () => {
  it("requires an exact failure generation and separate request identity", () => {
    const body = {
      schemaVersion: 1 as const, missionId: randomUUID(), ownerActionIssueId: randomUUID(),
      actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
      action: { operation: "retry_step" as const, target: { kind: "tool_step" as const,
        workflowRunId: randomUUID(), stepRunId: randomUUID(),
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } },
    };
    expect(missionOwnerExecuteSchema.safeParse(body).success).toBe(true);
    expect(missionOwnerExecuteSchema.safeParse({ ...body, action: { ...body.action,
      target: { ...body.action.target, expectedExecutionGeneration: -1 } } }).success).toBe(false);
  });
});

describe("mission owner execute tool step (real DB + real builtin execution)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-execute-tool-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await temp?.cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  async function seed(): Promise<Scenario> {
    const s = await seedToolRecoveryScenario({ db, artifactExists: true });
    roots.push(s.tempRoot);
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
    installRealExecutor(); // native delivery needs a configured executor; execution stays queued until processQueued
    return { ...s, heartbeatRunId };
  }
  const ownerBody = (s: Scenario) => ({ schemaVersion: 1 as const, missionId: s.missionId,
    ownerActionIssueId: s.recoveryIssueId, actionRequestId: randomUUID(),
    expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "retry_step" as const, target: { kind: "tool_step" as const,
      workflowRunId: s.workflowRunId, stepRunId: s.stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: 0, failedDispatchRequestId: null } } });
  function callExecute(s: Scenario, body: unknown, caller?: { agentId: string; heartbeatRunId: string; companyId?: string }) {
    return executeCoreWorkflowTool({ db, companyId: caller?.companyId ?? s.companyId,
      agentId: caller?.agentId ?? s.ownerAgentId, heartbeatRunId: caller?.heartbeatRunId ?? s.heartbeatRunId,
      toolName: "mission_owner_execute", parameters: body, requestId: randomUUID() });
  }
  const getResult = (s: Scenario, actionId: string, caller?: { agentId: string; heartbeatRunId: string }) =>
    getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: caller?.agentId ?? s.ownerAgentId,
      heartbeatRunId: caller?.heartbeatRunId ?? s.heartbeatRunId },
      { schemaVersion: 1, missionId: s.missionId, actionId });
  // Production-path executor replica (app.ts core branch): real builtin tool + real completion.
  function installRealExecutor() {
    setWorkflowToolStepExecutor(async (request) => {
      const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId,
        agentId: request.agentId, agentName: request.agentName, toolName: request.toolName,
        parameters: request.args ?? {}, requestId: request.requestId,
        workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
      const success = coreResult.status === 200;
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
  const snapshot = async (s: Scenario) => JSON.stringify({
    step: await stepRow(s.stepRunId), run: (await db.select().from(workflowRuns)
      .where(eq(workflowRuns.id, s.workflowRunId)))[0],
    authorities: await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId)) });

  it("executes the exact retry through the real builtin tool and reads back only the current result", async () => {
    const s = await seed();
    const body = ownerBody(s);
    const first = await callExecute(s, body);
    expect(first.status).toBe(200);
    console.log("FIRST_BODY", JSON.stringify(first.body));
    const action = first.body.data as { actionId: string; state: string };
    expect(action.actionId).toBeTruthy();
    expect(action.state).toBe("executing");
    const [authority] = await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));
    expect(authority.requestReference).toBe(`mission-owner-execute:${action.actionId}`);
    // Stale fixture artifact + success comment must not resolve the action before execution.
    expect((await getResult(s, action.actionId)).state).toBe("executing");
    const dispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatch.executedCount).toBeGreaterThanOrEqual(1);
    const completed = await stepRow(s.stepRunId);
    expect(completed.status).toBe("completed");
    expect(completed.metadata.toolResult).toMatchObject(
      { success: true, data: { attempt: "owner-execute-stage1-current" } });
    const resolved = await getResult(s, action.actionId);
    expect(resolved.state).toBe("resolved");
    expect(resolved.evidence).toContainEqual(expect.objectContaining(
      { kind: "dispatch", requestId: completed.lastDispatchRequestId, executionGeneration: 1 }));
    // Same request replay: no reset, no new authority, projection only.
    const replay = await callExecute(s, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ actionId: action.actionId, state: "resolved" });
    expect(await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId))).toHaveLength(1);
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
  });

  it("recovers delivery only (no re-reset) when a replay arrives after a delivery interruption", async () => {
    const s = await seed();
    const body = ownerBody(s);
    const first = await callExecute(s, body);
    const action = first.body.data as { actionId: string; state: string };
    expect(action.state).toBe("executing");
    // Simulate a crash between the native commit and queue delivery.
    const before = await stepRow(s.stepRunId);
    const receipt = before.metadata.ownerToolRetry;
    await db.update(workflowStepRuns).set({ status: "pending", startedAt: null,
      lastDispatchRequestId: null, lastDispatchAcceptedAt: null, metadata: { ownerToolRetry: receipt } })
      .where(eq(workflowStepRuns.id, s.stepRunId));
    const replay = await callExecute(s, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ actionId: action.actionId, state: "executing" });
    expect(await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId))).toHaveLength(1);
    const redelivered = await stepRow(s.stepRunId);
    expect(redelivered.lastDispatchRequestId).toBeTruthy();
    expect(redelivered.executionGeneration).toBe(1);
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.stepRunId)).status).toBe("completed");
    expect((await getResult(s, action.actionId)).state).toBe("resolved");
  });

  it.each(["no_grant", "wrong_company", "wrong_owner", "stale_generation", "stale_intent", "conflicting_body"])(
    "refuses %s with zero execution side effects", async (variant) => {
      const s = await seed();
      let caller: { agentId: string; heartbeatRunId: string; companyId?: string } | undefined;
      if (variant === "no_grant") {
        const [tool] = await db.select().from(toolDefinitions)
          .where(and(eq(toolDefinitions.companyId, s.companyId), eq(toolDefinitions.name, "mission_owner_execute")));
        await db.delete(agentToolGrants).where(eq(agentToolGrants.toolId, tool.id));
      }
      if (variant === "wrong_company") caller = { agentId: s.ownerAgentId, heartbeatRunId: s.heartbeatRunId, companyId: randomUUID() };
      if (variant === "wrong_owner") {
        const otherAgentId = randomUUID();
        await db.insert(agents).values({ id: otherAgentId, companyId: s.companyId, name: "Not Owner",
          role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
        const tools = await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, s.companyId));
        await db.insert(agentToolGrants).values(tools.map((tool) => (
          { companyId: s.companyId, agentId: otherAgentId, toolId: tool.id, grantedBy: "test" })));
        const otherHeartbeat = randomUUID();
        await db.insert(heartbeatRuns).values({ id: otherHeartbeat, companyId: s.companyId,
          agentId: otherAgentId, issueId: s.recoveryIssueId, status: "succeeded" });
        caller = { agentId: otherAgentId, heartbeatRunId: otherHeartbeat };
      }
      const firstBody = variant === "stale_intent" || variant === "conflicting_body" ? ownerBody(s) : null;
      let seededAction: unknown = null;
      if (firstBody) {
        const first = await callExecute(s, firstBody, caller);
        expect(first.status).toBe(variant === "stale_intent" || variant === "conflicting_body" ? 200 : first.status);
        seededAction = (first.body.data as { actionId: string }).actionId;
      }
      const before = await snapshot(s);
      let body: Record<string, unknown> = ownerBody(s);
      if (variant === "stale_intent") body = { ...ownerBody(s), expectedIntentEventId: randomUUID() };
      if (variant === "conflicting_body") body = { ...firstBody!, actionRequestId: firstBody!.actionRequestId,
        action: { ...firstBody!.action, target: { ...firstBody!.action.target, expectedExecutionGeneration: 9 } } };
      if (variant === "stale_generation") body = { ...ownerBody(s),
        action: { ...ownerBody(s).action, target: { ...ownerBody(s).action.target, expectedExecutionGeneration: 9 } } };
      const result = await callExecute(s, body, caller);
      if (variant === "stale_generation") {
        expect(result.status).toBe(200);
        expect(result.body.data).toMatchObject({ state: "blocked", reasonCode: "stale_generation" });
      } else {
        expect(result.status).toBe(variant === "no_grant" || variant === "wrong_owner" ? 403
          : variant === "wrong_company" ? 404 : 409);
        expect(typeof result.body.error).toBe("string");
      }
      expect(await snapshot(s)).toBe(before);
      if (variant === "stale_intent" || variant === "conflicting_body") expect(seededAction).toBeTruthy();
    });

  it("rejects unimplemented operations without intents; resume_run refuses unknown decisions safely", async () => {
    const s = await seed();
    const before = await snapshot(s);
    const base = ownerBody(s);
    // [Stage 4] resume_run is now a real operation — an unknown terminal decision id is a
    //   structured blocked result with zero execution side effects, not operation_not_available.
    const resume = await callExecute(s, { ...base, action: { operation: "resume_run",
      target: base.action.target, terminalDecisionId: randomUUID(), previewPolicy: "native_failed_anchor_v1" } });
    expect(resume.status).toBe(200);
    expect(resume.body.data).toMatchObject({ state: "blocked", reasonCode: "missing_decision" });
    // [Stage 5] revise_plan · [Stage 6] recollect · [Stage 7] delegate_fix · [Stage 8] reassign 은
    //   이제 실제 operation 이다(각 통합 테스트가 검증). 미구현 operation 배열은 비었다.
    // [Stage 8] reassign 사전 검증: 존재하지 않는 대상 agent 는 intent 기록 없이 거부된다.
    const reassignRefused = await callExecute(s, { ...base, action: { operation: "reassign",
      target: base.action.target, targetAgentId: randomUUID() } });
    expect(reassignRefused.status).toBe(404);
    expect(reassignRefused.body.error).toBe("target_agent_not_found");
    // [Stage 7] delegate_fix 사전 검증: 이 fixture 에 없는 공식 QA verdict 는 intent 기록 없이 거부된다.
    const delegateFixRefused = await callExecute(s, { ...base, action: { operation: "delegate_fix",
      producerTarget: base.action.target, qaVerdictEventId: randomUUID(), findingIds: ["f"] } });
    expect(delegateFixRefused.status).toBe(404);
    expect(delegateFixRefused.body.error).toBe("qa_verdict_not_found");
    // [Stage 6] recollect same_configuration 사전 검증: 이 fixture 의 collector 는 typed args 가 없어
    //   선언된 sourceRefs 와 정확 일치할 수 없다 — intent 기록 없이 구조 거부된다.
    const recollectRefused = await callExecute(s, { ...base, action: { operation: "recollect",
      collectorTarget: base.action.target, sourceRefs: ["s"], mode: "same_configuration" } });
    expect(recollectRefused.status).toBe(422);
    expect(recollectRefused.body.error).toBe("collector_configuration_changed");
    // [Stage 3] issue_step is now a supported target kind; a random issue that is not the
    //   step's own issue is still refused before any intent is recorded.
    const issueStep = await callExecute(s, { ...base, action: { operation: "retry_step",
      target: { ...base.action.target, kind: "issue_step", issueId: randomUUID() } } });
    expect(issueStep.status).toBe(404);
    expect(issueStep.body.error).toBe("target_not_found");
    // Only the blocked resume action recorded its intent (200-path); refusals recorded none.
    const events = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, s.companyId));
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("owner_execute_intent_v1");
    expect(await snapshot(s)).toBe(before);
  });

  it("does not start the queued command when a newer intent supersedes the attempt", async () => {
    const s = await seed();
    const first = await callExecute(s, ownerBody(s));
    const action = (first.body.data as { actionId: string });
    const superseded = await callExecute(s, ownerBody(s));
    expect((superseded.body.data as { state: string }).state).toBe("blocked");
    await processQueuedWorkflowToolStepRuns(db);
    const step = await stepRow(s.stepRunId);
    expect(step.status).toBe("failed");
    const failedResult = step.metadata.toolResult as { error?: unknown } | undefined;
    expect(String(failedResult?.error ?? step.lastDispatchErrorSummary)).toContain("owner_attempt_stale");
    expect((await getResult(s, action.actionId)).state).not.toBe("resolved");
  });
});
