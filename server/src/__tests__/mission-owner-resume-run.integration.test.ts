// [Stage 4] resume_run(native_failed_anchor_v1)이 적격 failed run 의 실패 anchor 를 기존 exact native 복구
//   (stage1 tool / stage3 issue)로 실제 재개하는지 실DB 검증 — 상태만 바꾸는 구현은 authority v+1·새
//   dispatch·완료 단언으로 실패한다. 사람 중지/예산 정지/hard deadline/signed tail/계약 밖 원인은 부작용
//   0 + 정확한 reasonCode 로 사람 판단 대기(policyCause 는 outcome_convergence 허용목록 — fail-closed).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agentWakeupRequests, agents, approvals, companies, createDb, heartbeatRuns,
  issues, missions, toolDefinitions, workflowRecoveryAuthorities, workflowResumeRequests,
  workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import type { MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { drainHeartbeatRuns } from "./helpers/cap-override-fixtures.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { failIssueBackedAttempt, seedIssueBackedRetryWorkflow } from "./helpers/workflow-step-retry-issue-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { previewOwnerNativeRunResume } from "../services/missions/mission-owner-resume-run.js";

const TOOL_COMMAND = `node -e "console.log(JSON.stringify({status:'success',attempt:'owner-resume-stage4-current'}))"`;
const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

type Db = ReturnType<typeof createDb>;
type World = { companyId: string; ownerAgentId: string; missionId: string; ownerActionIssueId: string;
  heartbeatRunId: string; workflowRunId: string; stepRunId: string; terminalDecisionId: string | null;
  issueId?: string; downstreamStepRunId?: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

describe("mission owner resume run (real DB + native failed-anchor recovery)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-resume-run-");
    db = createDb(temp.connectionString);
    await setRunRecoveryFlags(db, true, true);
    executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
  }, 60_000);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await drainHeartbeatRuns(db);
    await db.$client.end({ timeout: 5 });
    await temp?.cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  // tool anchor world: seedToolRecoveryScenario(실패 tool step + mission/run) + 종결 결정 + 오너 도구.
  async function seedToolWorld(variant: { policy?: string; decision?: string;
    decisionVersion?: number; noDecision?: boolean; stepStatus?: string;
    replaced?: boolean; retryExhaustion?: boolean } = {}): Promise<World> {
    const s = await seedToolRecoveryScenario({ db, artifactExists: true });
    roots.push(s.tempRoot);
    const policy = variant.policy ?? "outcome_convergence";
    const discovery = policy === "recovery_deadline_hard" ? "stuck_diagnostic" : "engine_recompute";
    const origin = policy === "recovery_deadline_hard" ? "reconciler" : "dag_engine";
    let terminalDecisionId: string | null = null;
    if (!variant.noDecision) {
      const [row] = await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId,
        workflowRunId: s.workflowRunId, decidedAuthorityVersion: variant.decisionVersion ?? 0,
        decision: variant.decision ?? "failed", policyCause: policy, discoveryPath: discovery, origin }).returning();
      terminalDecisionId = row!.id;
    }
    if (variant.stepStatus) await db.update(workflowStepRuns)
      .set({ status: variant.stepStatus }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant.replaced) { // 교체 규칙 실제 구조(replacement_from_start_v1 체크제약 전체)로 시드
      const [approval] = await db.insert(approvals).values({ companyId: s.companyId,
        type: "workflow_replacement", status: "approved", payload: {} }).returning();
      const workflowId = (await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns)
        .where(eq(workflowRuns.id, s.workflowRunId)))[0]!.workflowId;
      const [replacementRun] = await db.insert(workflowRuns).values({ companyId: s.companyId,
        workflowId, missionId: s.missionId, triggeredBy: "test" }).returning();
      const [decisionEvent] = await db.insert(workflowTransitionEvents).values({ companyId: s.companyId,
        eventType: "workflow_replacement_decision_v1", layer: "workflow_replacement", payload: {} }).returning();
      await db.insert(workflowRecoveryAuthorities).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        targetAuthorityVersion: 0, resultingAuthorityVersion: 0, targetDecisionId: terminalDecisionId!,
        recoveryKind: "replacement_from_start_v1", requestedBy: "test", requestReference: randomUUID(), ownerDecisionEventId: decisionEvent!.id,
        operatorApprovalId: approval!.id, replacementRunId: replacementRun!.id, requestHash: "a".repeat(64), replacementContract: {} });
    }
    if (variant.retryExhaustion) { const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
      await db.update(workflowStepRuns).set({ metadata: { ...record(step?.metadata),
        workflowRetryExhaustion: { attempts: 4, maxRetries: 3 } } }).where(eq(workflowStepRuns.id, s.stepRunId)); }
    const tools = await db.insert(toolDefinitions).values([
      { companyId: s.companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
      { companyId: s.companyId, name: "collect-us-stockflow", adapterType: "builtin", adapterConfig: { command: TOOL_COMMAND } },
    ]).returning();
    await db.insert(agentToolGrants).values(tools.map((tool) =>
      ({ companyId: s.companyId, agentId: s.ownerAgentId, toolId: tool.id, grantedBy: "test" })));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: s.companyId, agentId: s.ownerAgentId,
      issueId: s.recoveryIssueId, status: "succeeded" });
    installRealExecutor();
    return { companyId: s.companyId, ownerAgentId: s.ownerAgentId, missionId: s.missionId,
      ownerActionIssueId: s.recoveryIssueId, heartbeatRunId, workflowRunId: s.workflowRunId,
      stepRunId: s.stepRunId, terminalDecisionId, downstreamStepRunId: s.downstreamStepRunId };
  }

  // issue anchor world: stage3 시드(실패 issue-backed step + 공식 failed 결정[eligible policy] + 오너 도구).
  async function seedIssueWorld(variant: { noDecision?: boolean; liveWake?: boolean } = {}): Promise<World> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resume Issue Co",
      issuePrefix: `RU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false });
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner",
      role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Resume issue-anchor mission", status: "active" });
    const base = await seedIssueBackedRetryWorkflow(db, companyId);
    await drainHeartbeatRuns(db);
    await failIssueBackedAttempt(db, companyId, base.stepRunId);
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowStepRuns.id, base.stepRunId));
    await db.update(workflowRuns).set({ status: "failed", missionId, completedAt: new Date() }).where(eq(workflowRuns.id, base.workflowRunId)); await db.update(issues).set({ missionId }).where(and(eq(issues.companyId, companyId), eq(issues.id, base.issueId)));
    let terminalDecisionId: string | null = null;
    if (!variant.noDecision) {
      const [row] = await db.insert(workflowTerminalDecisions).values({ companyId,
        workflowRunId: base.workflowRunId, decidedAuthorityVersion: 0, decision: "failed", policyCause: "outcome_convergence",
        discoveryPath: "engine_failure", origin: "dag_engine" }).returning();
      terminalDecisionId = row!.id;
    }
    if (variant.liveWake) await db.insert(agentWakeupRequests).values({ companyId, agentId: base.agentId, issueId: base.issueId, source: "test", status: "queued" });
    const ownerActionIssueId = randomUUID();
    await db.insert(issues).values({ id: ownerActionIssueId, companyId, missionId, assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_unblock", originId: base.issueId, status: "todo", title: "[Owner Action] Resume failed run" });
    const tools = await db.insert(toolDefinitions).values({ companyId, name: "mission_owner_execute",
      adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }).returning();
    await db.insert(agentToolGrants).values({ companyId, agentId: ownerAgentId,
      toolId: tools[0]!.id, grantedBy: "test" });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "succeeded" });
    return { companyId, ownerAgentId, missionId, ownerActionIssueId, heartbeatRunId,
      workflowRunId: base.workflowRunId, stepRunId: base.stepRunId, terminalDecisionId, issueId: base.issueId };
  }

  function installRealExecutor() {
    setWorkflowToolStepExecutor(async (request) => {
      const coreResult = await executeCoreWorkflowTool({ db, companyId: request.companyId,
        agentId: request.agentId, agentName: request.agentName, toolName: request.toolName,
        parameters: request.args ?? {}, requestId: request.requestId,
        workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId });
      const success = coreResult.status === 200;
      await completeWorkflowToolStepFromResult(db, { companyId: request.companyId, stepRunId: request.stepRunId,
        requestId: request.requestId, workflowRunId: request.workflowRunId, stepId: request.stepId,
        toolName: request.toolName, success, stdout: coreResult.body.content ?? "", data: coreResult.body.data,
        stderr: coreResult.body.stderr ?? "", exitCode: success ? 0 : 1, error: coreResult.body.error });
      return { accepted: true as const };
    });
  }
  const resumeBody = (w: World, override: Record<string, unknown> = {}): MissionOwnerExecuteRequest => ({ schemaVersion: 1 as const,
    missionId: w.missionId, ownerActionIssueId: w.ownerActionIssueId, actionRequestId: randomUUID(),
    expectedIntentEventId: null, ownerDecisionEventId: null, action: { operation: "resume_run" as const,
      target: { kind: (w.issueId ? "issue_step" : "tool_step") as "tool_step" | "issue_step",
        ...(w.issueId ? { issueId: w.issueId } : {}), workflowRunId: w.workflowRunId, stepRunId: w.stepRunId,
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null },
      terminalDecisionId: w.terminalDecisionId ?? randomUUID(), previewPolicy: "native_failed_anchor_v1" as const,
      ...override } } as unknown as MissionOwnerExecuteRequest);
  const callExecute = (w: World, body: unknown) => executeCoreWorkflowTool({ db, companyId: w.companyId,
    agentId: w.ownerAgentId, heartbeatRunId: w.heartbeatRunId,
    toolName: "mission_owner_execute", parameters: body, requestId: randomUUID() });
  const getResult = (w: World, actionId: string) => getMissionOwnerActionResult({ db, companyId: w.companyId,
    agentId: w.ownerAgentId, heartbeatRunId: w.heartbeatRunId }, { schemaVersion: 1, missionId: w.missionId, actionId });
  const stepRow = async (w: World) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.stepRunId)))[0]!;
  const runRow = async (w: World) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.workflowRunId)))[0]!;
  const snapshot = async (w: World) => JSON.stringify({ run: await runRow(w), step: await stepRow(w),
    authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId)),
    resumeRequests: await db.select().from(workflowResumeRequests).where(eq(workflowResumeRequests.companyId, w.companyId)) });
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("waitFor timed out");
  }

  it("previews and actually resumes an eligible tool-step anchor through the native stage-1 path", async () => {
    const w = await seedToolWorld();
    const body = resumeBody(w);
    const preview = await previewOwnerNativeRunResume({ db, companyId: w.companyId,
      agentId: w.ownerAgentId, heartbeatRunId: w.heartbeatRunId }, body);
    expect(preview).toMatchObject({ kind: "eligible", reasonCode: null,
      terminalDecisionId: w.terminalDecisionId, authorityVersion: 0,
      stepRunId: w.stepRunId, executionGeneration: 0 });
    const first = await callExecute(w, body);
    expect(first.status).toBe(200);
    const action = first.body.data as { actionId: string; state: string; operation: string };
    expect(action.operation).toBe("resume_run");
    expect(action.state).toBe("executing"); // delivery ≠ completion
    const [authority] = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId));
    expect(authority).toMatchObject({ requestReference: `mission-owner-execute:${action.actionId}`,
      targetAuthorityVersion: 0, resultingAuthorityVersion: 1 });
    await processQueuedWorkflowToolStepRuns(db);
    const step = await stepRow(w);
    expect(step.status).toBe("completed");
    expect(step.executionGeneration).toBe(1); // state-only resume cannot fake a new attempt
    expect(record(step.metadata).toolResult).toMatchObject(
      { success: true, data: { attempt: "owner-resume-stage4-current" } });
    const [applied] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.correlationId, action.actionId),
      eq(workflowTransitionEvents.eventType, "owner_execute_applied_v1")));
    expect(record(applied?.payload).stepRunId).toBe(w.stepRunId); // anchor scope recorded
    const result = await getResult(w, action.actionId);
    expect(result.state).toBe("resolved");
    expect(result.evidence).toContainEqual(expect.objectContaining({ kind: "dispatch", executionGeneration: 1 }));
  });

  it("resumes an eligible issue-step anchor through the native stage-3 path (delivery vs completion)", async () => {
    const w = await seedIssueWorld();
    const first = await callExecute(w, resumeBody(w));
    expect(first.status).toBe(200);
    const action = first.body.data as { actionId: string; state: string };
    expect(["executing", "delivery_pending"]).toContain(action.state); // not resolved yet
    const [authority] = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId));
    expect(authority).toMatchObject({ recoveryKind: "supervision_tool_retry", resultingAuthorityVersion: 1 });
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, w.companyId),
      eq(agentWakeupRequests.issueId, w.issueId!), eq(agentWakeupRequests.requestKind, "workflow_resume")));
    expect(wake?.workflowStepRunId).toBe(w.stepRunId);
    await waitFor(async () => (await stepRow(w)).status === "completed");
    const step = await stepRow(w);
    expect(step.executionGeneration).toBe(1);
    expect(record(step.metadata).ownerToolRetry).toMatchObject({ authorityVersion: 1, executionGeneration: 1 });
    expect((await getResult(w, action.actionId)).state).toBe("resolved");
  });

  it.each([
    ["operator_cancel", { policy: "operator_cancel", decision: "cancelled" }],
    ["budget_hard_stop", { policy: "budget_hard_stop" }],
    ["recovery_deadline_hard", { policy: "recovery_deadline_hard" }],
    ["missing_decision", { noDecision: true }],
    ["stale_decision", { decisionVersion: 7 }],
    ["stale_generation", {}],
    ["step_not_failed", { stepStatus: "completed" }],
    ["replaced_run", { replaced: true }],
    ["retry_exhausted", { retryExhaustion: true }],
    ["unsupported_policy_cause", { policy: "future_cause" }],
  ] as const)("blocks %s with zero execution side effects and an exact reason", async (variant, seedVariant) => {
    const w = await seedToolWorld(seedVariant);
    const body = variant === "stale_generation" ? resumeBody(w, { target: { kind: "tool_step",
      workflowRunId: w.workflowRunId, stepRunId: w.stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: 9, failedDispatchRequestId: null } }) : resumeBody(w);
    const before = await snapshot(w);
    const result = await callExecute(w, body);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ state: "blocked", reasonCode: variant, operation: "resume_run" });
    if (["operator_cancel", "budget_hard_stop", "recovery_deadline_hard"].includes(variant)) {
      expect((result.body.data as { requiredAction: { kind: string } }).requiredAction.kind).toBe("board_resume");
    }
    expect(await snapshot(w)).toBe(before); // no authority, no state flip, no board request
    const action = (result.body.data as { actionId: string }).actionId;
    expect((await getResult(w, action)).reasonCode).toBe(variant); // get-result keeps the exact reason
  });

  it("blocks signed_unexecuted_tail at the existing board-only boundary", async () => {
    const w = await seedToolWorld();
    const before = await snapshot(w);
    const result = await callExecute(w, resumeBody(w, { previewPolicy: "signed_unexecuted_tail" }));
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ state: "blocked", reasonCode: "board_resume_required" });
    expect((result.body.data as { requiredAction: { kind: string } }).requiredAction.kind).toBe("board_resume");
    expect(await snapshot(w)).toBe(before); // no policy synthesis, no board actor, no legacy fallback
  });

  it("keeps the run unresolved when another failed branch remains after the anchor completes", async () => {
    const w = await seedToolWorld();
    const first = await callExecute(w, resumeBody(w));
    const action = first.body.data as { actionId: string };
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(w)).status).toBe("completed");
    // anchor 완료 후 다른 독립 branch 가 실패로 남은 현재 상태(읽기 시점 기준) — run 전체
    // resolved 로 보고하지 않고 남은 실패 step 을 결과에 표시한다.
    await db.update(workflowStepRuns).set({ status: "failed", startedAt: new Date(),
      completedAt: new Date() }).where(eq(workflowStepRuns.id, w.downstreamStepRunId!));
    const result = await getResult(w, action.actionId);
    expect(result.state).toBe("blocked"); // run-wide resolved is not declared
    expect(result.reasonCode).toBe("failed_steps_remain");
    const marker = result.evidence.find((item) => item.kind === "heartbeat" && item.stepRunId
      && item.stepRunId !== w.stepRunId);
    expect(marker?.stepRunId).toBe(w.downstreamStepRunId); // remaining failed step surfaced
  });

  it("blocks an in-flight old execution on the issue anchor with zero side effects", async () => {
    const w = await seedIssueWorld({ liveWake: true });
    const before = await snapshot(w);
    const result = await callExecute(w, resumeBody(w));
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ state: "blocked", reasonCode: "execution_in_flight" });
    expect(await snapshot(w)).toBe(before);
  });
});
