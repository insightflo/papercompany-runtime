// [Stage 3] mission_owner_execute 의 issue_step 재시도가 exact strict native 복구 경로
//   (dispatchSourceIssueNativeResume → acceptSourceIssueRecovery → wakeExistingWorkflowStepIssue)로
//   실제 실행되고, 그 결과가 현재 시도 기준으로 읽히는지를 실DB+실경로로 검증한다.
//   어댑터만 recording stub 으로 대체(실제 wake/heartbeat/DB write 는 전부 운영 경로).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues,
  missions, toolDefinitions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { drainHeartbeatRuns } from "./helpers/cap-override-fixtures.js";
import { failIssueBackedAttempt, seedIssueBackedRetryWorkflow } from "./helpers/workflow-step-retry-issue-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as delivery from "../services/workflow/replacement-agent-delivery.js";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

type Db = ReturnType<typeof createDb>;
type Scenario = {
  companyId: string; ownerAgentId: string; missionId: string; ownerActionIssueId: string;
  heartbeatRunId: string; agentId: string; workflowRunId: string; stepRunId: string; issueId: string;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

describe("mission owner execute issue step (real DB + native source-issue resume)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-execute-issue-");
    db = createDb(temp.connectionString);
    await setRunRecoveryFlags(db, true, true); // official recovery service owns failed-run revival
    executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
  }, 60_000);
  afterAll(async () => {
    await drainHeartbeatRuns(db);
    await db.$client.end({ timeout: 5 });
    await temp?.cleanup();
  });

  async function seed(variant: { issueStatus?: string; stepStatus?: string; exhaust?: boolean; decision?: boolean } = {}): Promise<Scenario> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Issue Step Owner Co",
      issuePrefix: `IS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false });
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner",
      role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "Issue-step owner retry mission", status: "active" });
    const base = await seedIssueBackedRetryWorkflow(db, companyId);
    await drainHeartbeatRuns(db); // let the seeded dispatch settle, then impose the failed state
    await failIssueBackedAttempt(db, companyId, base.stepRunId);
    await db.update(workflowStepRuns).set({ status: variant.stepStatus ?? "failed", completedAt: new Date(),
      ...(variant.exhaust ? { metadata: { workflowRetryExhaustion: { attempts: 3, maxRetries: 2 } } } : {}) })
      .where(eq(workflowStepRuns.id, base.stepRunId));
    await db.update(workflowRuns).set({ status: "failed", missionId, completedAt: new Date() }).where(eq(workflowRuns.id, base.workflowRunId));
    await db.update(issues).set({ missionId }).where(and(eq(issues.companyId, companyId), eq(issues.id, base.issueId)));
    if (variant.decision !== false) await db.insert(workflowTerminalDecisions).values({ companyId,
      workflowRunId: base.workflowRunId, decidedAuthorityVersion: 0, decision: "failed",
      policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    if (variant.issueStatus) await db.update(issues).set({ status: variant.issueStatus })
      .where(eq(issues.id, base.issueId));
    const ownerActionIssueId = randomUUID();
    await db.insert(issues).values({ id: ownerActionIssueId, companyId, missionId,
      assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock", originId: base.issueId,
      status: "todo", title: "[Owner Action] Retry failed issue step" });
    const tools = await db.insert(toolDefinitions).values({ companyId, name: "mission_owner_execute",
      adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }).returning();
    await db.insert(agentToolGrants).values({ companyId, agentId: ownerAgentId,
      toolId: tools[0]!.id, grantedBy: "test" });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: ownerAgentId,
      issueId: ownerActionIssueId, status: "succeeded" });
    return { companyId, ownerAgentId, missionId, ownerActionIssueId, heartbeatRunId,
      agentId: base.agentId, workflowRunId: base.workflowRunId, stepRunId: base.stepRunId, issueId: base.issueId };
  }
  const ownerBody = (s: Scenario, targetOverride: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const,
    missionId: s.missionId, ownerActionIssueId: s.ownerActionIssueId, actionRequestId: randomUUID(),
    expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "retry_step" as const, target: { kind: "issue_step" as const, issueId: s.issueId,
      workflowRunId: s.workflowRunId, stepRunId: s.stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: 0, failedDispatchRequestId: null, ...targetOverride } } });
  function callExecute(s: Scenario, body: unknown, caller?: { agentId: string; heartbeatRunId: string; companyId?: string }) {
    return executeCoreWorkflowTool({ db, companyId: caller?.companyId ?? s.companyId,
      agentId: caller?.agentId ?? s.ownerAgentId, heartbeatRunId: caller?.heartbeatRunId ?? s.heartbeatRunId,
      toolName: "mission_owner_execute", parameters: body, requestId: randomUUID() });
  }
  const getResult = (s: Scenario, actionId: string) =>
    getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.ownerAgentId,
      heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.missionId, actionId });
  const stepRow = async (s: Scenario) => (await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, s.stepRunId)))[0]!;
  const runRow = async (s: Scenario) => (await db.select().from(workflowRuns)
    .where(eq(workflowRuns.id, s.workflowRunId)))[0]!;
  const authorities = (s: Scenario) => db.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));
  const resumeWakes = (s: Scenario) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.issueId, s.issueId),
    eq(agentWakeupRequests.requestKind, "workflow_resume")));
  const workerHeartbeats = (s: Scenario) => db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.issueId, s.issueId)).orderBy(heartbeatRuns.id);
  const snapshot = async (s: Scenario) => JSON.stringify({ run: await runRow(s), step: await stepRow(s),
    authorities: await authorities(s), wakes: await resumeWakes(s) });
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("waitFor timed out");
  }

  it("executes the exact issue-step retry through the native resume path and reads the current result", async () => {
    const s = await seed();
    const first = await callExecute(s, ownerBody(s));
    expect(first.status).toBe(200);
    const action = first.body.data as { actionId: string; state: string };
    expect(action.actionId).toBeTruthy();
    const [authority] = await authorities(s);
    expect(authority.requestReference).toBe(`mission-owner-execute:${action.actionId}`);
    expect(authority.recoveryKind).toBe("supervision_tool_retry");
    expect(authority.targetAuthorityVersion).toBe(0);
    expect(authority.resultingAuthorityVersion).toBe(1);
    const [wake] = await resumeWakes(s);
    expect(wake).toBeTruthy();
    expect(wake.workflowRunId).toBe(s.workflowRunId);
    expect(wake.workflowStepRunId).toBe(s.stepRunId);
    expect(wake.agentId).toBe(s.agentId); // frozen worker, not the owner
    await waitFor(async () => (await stepRow(s)).status === "completed");
    const step = await stepRow(s);
    expect(step.executionGeneration).toBe(1);
    expect(record(step.metadata).ownerToolRetry).toMatchObject(
      { authorityId: authority.id, authorityVersion: 1, executionGeneration: 1 });
    const [workerHeartbeat] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.issueId, s.issueId), eq(heartbeatRuns.status, "succeeded")));
    expect(workerHeartbeat?.agentId).toBe(s.agentId);
    const result = await getResult(s, action.actionId);
    expect(result.state).toBe("resolved");
    expect(result.evidence).toContainEqual(expect.objectContaining(
      { kind: "dispatch", executionGeneration: 1 }));
    // A new action against the consumed failure target is blocked — it needs a fresh exact failure.
    const stale = await callExecute(s, ownerBody(s));
    expect(stale.status).toBe(200);
    expect((stale.body.data as { state: string }).state).toBe("blocked");
    expect(await authorities(s)).toHaveLength(1);
  });

  it.each(["stale_generation", "retry_exhausted", "missing_decision", "wrong_owner"] as const)(
    "refuses %s with zero execution side effects", async (variant) => {
      const s = await seed({ exhaust: variant === "retry_exhausted",
        decision: variant !== "missing_decision" });
      let caller: { agentId: string; heartbeatRunId: string } | undefined;
      if (variant === "wrong_owner") {
        const otherAgentId = randomUUID();
        await db.insert(agents).values({ id: otherAgentId, companyId: s.companyId, name: "Not Owner",
          role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
        const [tool] = await db.select().from(toolDefinitions)
          .where(and(eq(toolDefinitions.companyId, s.companyId), eq(toolDefinitions.name, "mission_owner_execute")));
        await db.insert(agentToolGrants).values({ companyId: s.companyId, agentId: otherAgentId,
          toolId: tool.id, grantedBy: "test" });
        const otherHeartbeat = randomUUID();
        await db.insert(heartbeatRuns).values({ id: otherHeartbeat, companyId: s.companyId,
          agentId: otherAgentId, issueId: s.ownerActionIssueId, status: "succeeded" });
        caller = { agentId: otherAgentId, heartbeatRunId: otherHeartbeat };
      }
      const body = variant === "stale_generation"
        ? ownerBody(s, { expectedExecutionGeneration: 9 }) : ownerBody(s);
      const before = await snapshot(s);
      const result = await callExecute(s, body, caller);
      if (variant === "wrong_owner") {
        expect(result.status).toBe(403);
        expect(result.body.error).toBe("not_mission_owner");
      } else {
        expect(result.status).toBe(200);
        expect(result.body.data).toMatchObject({ state: "blocked",
          reasonCode: variant === "stale_generation" ? "stale_generation"
            : variant === "retry_exhausted" ? "retry_exhausted" : "missing_failed_decision" });
      }
      expect(await snapshot(s)).toBe(before);
    });

  // C02/C03 + addendum:4: request admission failure rolls recovery back; owner intent commits separately.
  it("refuses an in-review source before recovery and preserves its existing execution records", async () => {
    const s = await seed({ issueStatus: "in_review" });
    executeSpy.mockClear();
    const before = await snapshot(s), heartbeats = await workerHeartbeats(s);
    const requests = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.issueId, s.issueId)).orderBy(agentWakeupRequests.id);
    expect(await runRow(s)).toMatchObject({ status: "failed", dispatchAuthorityVersion: 0 });
    expect(await stepRow(s)).toMatchObject({ status: "failed", executionGeneration: 0 });
    const first = await callExecute(s, ownerBody(s));
    expect(first.status).toBe(200);
    const action = first.body.data as { actionId: string; state: string };
    expect(action.state).toBe("blocked"); // Old delivery_pending/authority 1/version 1/generation 1 was pre-atomicity.
    expect(await snapshot(s)).toBe(before); // run, step, authority, generations and requests only, not all DB writes
    expect(await authorities(s)).toHaveLength(0);
    expect(await workerHeartbeats(s)).toEqual(heartbeats);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, s.issueId))
      .orderBy(agentWakeupRequests.id)).toEqual(requests);
    expect(executeSpy).not.toHaveBeenCalled();
    const intents = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, s.companyId), eq(workflowTransitionEvents.issueId, s.ownerActionIssueId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1")));
    expect(intents).toEqual([{ id: action.actionId }]); // This separate durable intent is allowed to remain.
  });

  it("reuses the committed request after lost notification and completes through the native queue re-read", async () => {
    const s = await seed({ issueStatus: "blocked" });
    executeSpy.mockClear(); // Seed dispatch has already drained; measure only the recovery worker.
    const drain = vi.spyOn(delivery, "drainReplacementRootNotifications")
      .mockRejectedValueOnce(new Error("committed source delivery lost"));
    let failed = false;
    try {
      const body = ownerBody(s);
      const first = await callExecute(s, body);
      expect(first.status).toBe(200);
      const action = first.body.data as { actionId: string; state: string };
      expect(action.state).toBe("executing"); // Existing queued projection; NOT proof of adapter start.
      const authorityRows = await authorities(s);
      expect(authorityRows).toHaveLength(1);
      const [authority] = authorityRows;
      expect(authority).toMatchObject({ requestReference: `mission-owner-execute:${action.actionId}`,
        recoveryKind: "supervision_tool_retry", targetAuthorityVersion: 0, resultingAuthorityVersion: 1 });
      expect(await runRow(s)).toMatchObject({ status: "running", dispatchAuthorityVersion: 1 });
      expect(await stepRow(s)).toMatchObject({ status: "running", executionGeneration: 1 });
      const wakes = await resumeWakes(s);
      expect(wakes).toHaveLength(1);
      const [wake] = wakes;
      expect(wake).toMatchObject({ agentId: s.agentId, issueId: s.issueId, workflowRunId: s.workflowRunId,
        workflowStepRunId: s.stepRunId, workflowExecutionGeneration: 1, requestKind: "workflow_resume" });
      const heartbeats = await workerHeartbeats(s);
      const linked = heartbeats.filter(row => row.wakeupRequestId === wake.id);
      expect(linked).toHaveLength(1);
      const [heartbeat] = linked;
      expect(heartbeat).toMatchObject({ status: "queued", companyId: s.companyId, agentId: s.agentId,
        issueId: s.issueId, wakeupRequestId: wake.id });
      expect(wake.runId).toBe(heartbeat.id);
      expect(heartbeat.contextSnapshot).toMatchObject({ issueId: s.issueId, missionId: s.missionId,
        workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId });
      expect(drain).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
      const committed = await snapshot(s);
      const replay = await callExecute(s, body);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ actionId: action.actionId, state: "executing" });
      expect(await snapshot(s)).toBe(committed); // Same authority 1, generation 1 and exact request ID.
      expect(await workerHeartbeats(s)).toEqual(heartbeats); // Same queued heartbeat ID and wake linkage.
      expect(executeSpy).not.toHaveBeenCalled();
      await heartbeatService(db).resumeQueuedRuns(s.agentId);
      await waitFor(async () => (await stepRow(s)).status === "completed"
        && (await workerHeartbeats(s)).some(row => row.id === heartbeat.id && row.status === "succeeded"));
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ runId: heartbeat.id });
      expect((await workerHeartbeats(s)).filter(row => row.wakeupRequestId === wake.id))
        .toMatchObject([{ id: heartbeat.id, wakeupRequestId: wake.id, status: "succeeded",
          workflowStepRunId: s.stepRunId, workflowExecutionGeneration: 1 }]);
      expect((await getResult(s, action.actionId)).state).toBe("resolved");
      expect((await resumeWakes(s)).map(row => row.id)).toEqual([wake.id]);
      expect(await authorities(s)).toHaveLength(1);
      expect((await stepRow(s)).executionGeneration).toBe(1);
      expect((await runRow(s)).dispatchAuthorityVersion).toBe(1);
      // A NEW action against the consumed failure still needs a new exact failure.
      const stale = await callExecute(s, ownerBody(s));
      expect((stale.body.data as { state: string }).state).toBe("blocked");
      expect(await authorities(s)).toHaveLength(1);
    } catch (error) { failed = true; throw error; }
    finally {
      drain.mockRestore();
      try {
        await heartbeatService(db).resumeQueuedRuns(s.agentId);
        await drainHeartbeatRuns(db);
      } catch (error) { if (!failed) throw error; console.error("Recovery cleanup failed after test failure", error); }
    }
  });

  it("never reaches the privileged cap-override branch for automatic retries", async () => {
    const s = await seed({ stepStatus: "completed" }); // failed run + completed producer
    const before = await snapshot(s);
    const result = await callExecute(s, ownerBody(s));
    expect(result.status).toBe(200);
    expect((result.body.data as { state: string }).state).toBe("blocked");
    expect(await snapshot(s)).toBe(before);
    expect(await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "owner_cap_override_retry")))).toHaveLength(0);
  });
});
