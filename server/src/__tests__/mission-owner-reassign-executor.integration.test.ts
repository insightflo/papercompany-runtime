// [Stage 8] mission_owner_execute reassign — 담당 표시만 바꾸는 것이 아니라 실제 실행자까지 일치시키는지
//   실DB+실경로로 검증한다. ① 이슈 기반(정의에 실행자 고정 없음) 대상: guarded 재배정 + stage3 strict
//   native 깨움으로 새 담당자가 실제 실행·완료. ② frozen step.agentId: plan 없으면 intent 전 사전 거부,
//   제한된 plan unit 은 stage5 실제 계획 체인으로 새 불변 정의·실행. ③ 상태 부족 agent → request_access,
//   ④ 진행 중 기존 작업 → 정확한 대기(병렬 시작 없음), ⑤ sourceMissionId → 기존 board 대기,
//   ⑥ 무작정 targetAgentId → 사전 거부, ⑦ old agent 지연 결과는 새 시도를 완성시키지 못함.
//   과거 실행 정의의 step.agentId 는 절대 수정하지 않는다. 어댑터만 recording stub(나머지 전부 운영 경로).
import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { agentToolGrants, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRuns } from "./helpers/cap-override-fixtures.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { slice1Decision, slice1Unit, slice1World } from "./helpers/mission-revision-slice1-world.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";
import { missionOwnerExecuteSchema } from "@paperclipai/shared/validators/mission-owner-authority";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { workProductService } from "../services/work-products.js";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));
type Db = ReturnType<typeof createDb>;
const rec = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const dataOf = (response: { body: { data?: unknown } }) => rec(rec(response.body).data) as {
  actionId: string; state: string; reasonCode: string | null; requiredAction: { kind: string; targetId: string; reasonCode: string } | null };

describe("mission owner reassign (real DB + native executor match)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-reassign-");
    db = createDb(temp.connectionString);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-reassign-")));
    executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
  }, 60_000);
  afterAll(async () => {
    await drainHeartbeatRuns(db).catch(() => undefined); await db.$client.end({ timeout: 5 });
    await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true });
  });

  /** 이슈 기반 스텝(+선택적으로 정의에 고정 agentId)을 가진 미션 세계. 정의/런/스텝런/이슈는 실제 행. */
  async function seed(opts: { pinned?: boolean; newAgentStatus?: string } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reassign Co",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot: root });
    const mk = async (name: string, status = "active", role = "worker") => (await db.insert(agents).values({
      id: randomUUID(), companyId, name, role, status, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning())[0]!;
    const owner = await mk("Owner", "active", "operator");
    const oldAgent = await mk("Old Worker");
    const newAgent = await mk("New Worker", opts.newAgentStatus ?? "active");
    const [mission] = await db.insert(missions).values({ id: randomUUID(), companyId, ownerAgentId: owner.id, title: "Reassign mission", status: "active" }).returning();
    const [definition] = await db.insert(workflowDefinitions).values({ id: randomUUID(), companyId, name: "reassign-wf",
      stepsJson: [{ id: "review-pack", name: "Review pack", ...(opts.pinned ? { agentId: oldAgent.id } : {}), dependencies: [] }] }).returning();
    const [run] = await db.insert(workflowRuns).values({ id: randomUUID(), workflowId: definition.id, companyId, missionId: mission.id, triggeredBy: "test", status: "running" }).returning();
    const [issue] = await db.insert(issues).values({ id: randomUUID(), companyId, missionId: mission.id,
      title: "Review pack", status: "blocked", originKind: "workflow_execution", assigneeAgentId: oldAgent.id }).returning();
    const [stepRun] = await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId: run.id, stepId: "review-pack", issueId: issue.id, status: "pending", metadata: {} }).returning();
    const [ownerActionIssue] = await db.insert(issues).values({ id: randomUUID(), companyId,
      missionId: mission.id, title: "[Owner Action] Reassign", originKind: "mission_main_executor_unblock",
      originId: issue.id, status: "todo", assigneeAgentId: owner.id }).returning();
    const [tool] = await db.insert(toolDefinitions).values({ companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }).returning();
    await db.insert(agentToolGrants).values({ companyId, agentId: owner.id, toolId: tool.id, grantedBy: "test" });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: owner.id, issueId: ownerActionIssue.id, status: "succeeded" });
    return { companyId, owner, oldAgent, newAgent, mission, run, definition, issue, stepRun, ownerActionIssue, heartbeatRunId };
  }
  type Scenario = Awaited<ReturnType<typeof seed>>;
  const body = (s: Scenario, over: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, missionId: s.mission.id,
    ownerActionIssueId: s.ownerActionIssue.id, actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "reassign" as const, target: { kind: "issue_step" as const, issueId: s.issue.id, workflowRunId: s.run.id,
      stepRunId: s.stepRun.id, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null },
      targetAgentId: s.newAgent.id, ...over } });
  const call = (s: Scenario, b: unknown, caller?: { agentId: string; heartbeatRunId: string }) =>
    executeCoreWorkflowTool({ db, companyId: s.companyId, agentId: caller?.agentId ?? s.owner.id,
      heartbeatRunId: caller?.heartbeatRunId ?? s.heartbeatRunId, toolName: "mission_owner_execute", parameters: b, requestId: randomUUID() });
  const getResult = (s: Scenario, actionId: string) => getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.owner.id,
    heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.mission.id, actionId });
  const stepRow = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;
  const issueRow = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const resumeWakes = (issueId: string, agentId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.issueId, issueId), eq(agentWakeupRequests.agentId, agentId)));
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("waitFor timed out");
  }
  /** 물화된 에이전트 스텝을 실제 완료로 수렴: 자동 파이프라인 우선, 픽업이 없으면 실제 승인 생산자 1회 +
   *  실제 산출물 등록(graphWorkProductRequired 게이트) + 이슈 종결·엔진 동기화. 스텝 완료는 syncStepRunsFromIssueState
   *  가 소유한다 — 반복 wake 삽입으로 재발송 루프를 만들지 않는다. */
  async function settleAgentStep(s: Scenario, runId: string, stepRunId: string, issueId: string) {
    let admitted = false;
    for (let i = 0; i < 200; i++) {
      if ((await stepRow(stepRunId)).status === "completed") return;
      const [live] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, issueId), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (!live && i >= 10) {
        let heartbeatId: string = randomUUID();
        if (!admitted) {
          admitted = true; // 실제 승인 경로(wake+claim)를 1회만 사용한다
          await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, stepRunId));
          heartbeatId = (await admittedProducer(db, { companyId: s.companyId, agentId: s.newAgent.id, issueId, stepRunId, heartbeatId })).heartbeatId;
          const dir = `${root}/missions/${s.mission.id}/steps/${stepRunId}`;
          await mkdir(dir, { recursive: true });
          const file = `${dir}/content.json`, bytes = Buffer.from(`{"blocks":["reassign-${stepRunId.slice(0, 8)}"]}`);
          await writeFile(file, bytes); // 새 담당자의 실제 산출물 등록 → 완료 게이트 통과
          await workProductService(db).createForIssue(issueId, s.companyId, { provider: "local_file",
            type: "document", title: "content.json", status: "active", createdByRunId: heartbeatId, metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
        } else {
          await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: s.newAgent.id, issueId,
            status: "succeeded", startedAt: new Date(), finishedAt: new Date() });
        }
        await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issueId));
        // QA 성격 이슈의 완료는 구조 검증 판정 원장(workflow_api pass)이 소유한다(생산 이슈에는 no-op).
        await recordWorkflowValidationVerdict({ db, issue: await issueRow(issueId), verdict: "pass",
          source: "workflow_api", actorAgentId: s.newAgent.id, heartbeatRunId: heartbeatId });
        await syncWorkflowRunState(db, runId);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("settleAgentStep timed out");
  }
  const qaVerdict = (companyId: string, missionId: string, planQaIssueId: string) =>
    submitMissionPlanQaVerdict({ db, issue: { id: planQaIssueId, companyId, missionId, originKind: "mission_plan_qa" },
      actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null }, data: { verdict: "pass", diagnostics: [] } });
  const planDecision = (missionId: string, agentId: string) => ({ missionId, missionGoal: "Reassign execution unit",
    selectedPlanTemplateIds: [], selectedExecutionUnits: [{ id: "redo", title: "Redo by new agent", selectionState: "selected",
      reason: "unit", assigneeAgentId: agentId, sourceRef: { type: "mission_plan_unit", id: "redo" }, dependencies: [] }],
    ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    assessment: { objectiveRestatement: "Reassign", availableAssetsReviewed: [], assetEvaluation: [], gaps: [], researchPerformed: [] } });
  const attachPlanning = async (s: Scenario) => {
    const [planning] = await db.insert(issues).values({ id: randomUUID(), companyId: s.companyId,
      missionId: s.mission.id, title: "PLAN", originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: s.owner.id }).returning();
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: s.companyId, missionId: s.mission.id,
      refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    return planning!;
  };

  it("[GREEN] reassigns an issue-driven target and the new assignee actually executes it", async () => {
    const s = await seed();
    const first = await call(s, body(s));
    expect(first.status).toBe(200);
    const action = dataOf(first);
    expect(action.actionId).toBeTruthy();
    expect(["delivery_pending", "executing", "resolved"]).toContain(action.state);
    expect((await issueRow(s.issue.id)).assigneeAgentId).toBe(s.newAgent.id); // guarded 재배정 적용
    const [wake] = await resumeWakes(s.issue.id, s.newAgent.id);
    expect(wake).toMatchObject({ workflowRunId: s.run.id, workflowStepRunId: s.stepRun.id }); // 새 담당자 native wake
    await waitFor(async () => (await stepRow(s.stepRun.id)).status === "completed");
    const [workerHeartbeat] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, s.issue.id), eq(heartbeatRuns.agentId, s.newAgent.id), eq(heartbeatRuns.status, "succeeded")));
    expect(workerHeartbeat).toBeTruthy(); // 실제 실행자 = 새 담당자
    const resolved = await getResult(s, action.actionId);
    expect(resolved).toMatchObject({ state: "resolved", operation: "reassign" });
    expect(resolved.evidence).toContainEqual(expect.objectContaining({ kind: "heartbeat", recordId: workerHeartbeat!.id }));
  }, 45_000);

  it("[RED] a frozen step.agentId target without a plan is refused before any intent", async () => {
    const s = await seed({ pinned: true });
    const before = JSON.stringify({ issue: await issueRow(s.issue.id), step: await stepRow(s.stepRun.id) });
    const refused = await call(s, body(s));
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("plan_required");
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1")))).toHaveLength(0);
    expect(JSON.stringify({ issue: await issueRow(s.issue.id), step: await stepRow(s.stepRun.id) })).toBe(before);
  });

  it("[GREEN] a frozen target with a restricted plan unit builds a new definition executed by the new agent", async () => {
    const s = await seed({ pinned: true });
    const planning = await attachPlanning(s);
    const decision = planDecision(s.mission.id, s.newAgent.id);
    const first = await call(s, body(s, { plan: { planningIssueId: planning.id, expectedDecisionHash: null, decision } }));
    expect(first.status).toBe(200);
    const action = dataOf(first);
    expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending", requiredAction: { kind: "submit_qa_verdict" } });
    await qaVerdict(s.companyId, s.mission.id, action.requiredAction!.targetId); // 독립 PLAN-QA pass(실제 API)
    const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.missionId, s.mission.id), ne(workflowRuns.id, s.run.id))); // 이 action 의 계획이 만든 실제 run
    expect(run).toBeTruthy();
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, s.mission.id));
    const steps = (definition!.stepsJson ?? []) as Array<{ agentId?: string }>;
    expect(steps[0]!.agentId).toBe(s.newAgent.id); // 새 불변 정의의 실행자 = 새 담당자(과거 정의 미수정)
    expect(((s.definition.stepsJson ?? []) as Array<{ agentId?: string }>)[0]!.agentId).toBe(s.oldAgent.id); // 원본 고정 유지
    const [agentStep] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, run.id), isNotNull(workflowStepRuns.issueId)));
    expect(agentStep).toBeTruthy();
    expect((await issueRow(agentStep!.issueId!)).assigneeAgentId).toBe(s.newAgent.id); // 새 시도 이슈의 담당자
    const runSteps = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
    for (let pass = 0; pass < 6; pass++) { // 마지막 QA 스텝은 생산자 완료 동기화 후 발사된다 — 반복 패스로 마감
      const pending = (await runSteps()).filter((step) => step.issueId && step.status !== "completed"); if (pending.length === 0) break;
      for (const step of pending) await settleAgentStep(s, run.id, step.id, step.issueId!);
      await syncWorkflowRunState(db, run.id);
    }
    const resolved = await getResult(s, action.actionId);
    expect(resolved).toMatchObject({ state: "resolved", operation: "reassign" });
  }, 60_000);

  it("[RED] a non-runnable target agent is blocked with request_access and zero execution side effects", async () => {
    const s = await seed({ newAgentStatus: "paused" });
    const before = JSON.stringify({ issue: await issueRow(s.issue.id) });
    const result = await call(s, body(s));
    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ state: "blocked", reasonCode: "target_agent_not_runnable", requiredAction: { kind: "request_access", targetId: s.newAgent.id } });
    expect(JSON.stringify({ issue: await issueRow(s.issue.id) })).toBe(before); // 담당 변경 없음
    expect(await resumeWakes(s.issue.id, s.newAgent.id)).toHaveLength(0); // wake 없음
    expect((await stepRow(s.stepRun.id)).status).toBe("pending"); // 실행 부작용 0
  });

  it("[RED] live execution on the target issue waits instead of starting parallel work", async () => {
    const s = await seed();
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: s.companyId, agentId: s.oldAgent.id, issueId: s.issue.id, status: "running", startedAt: new Date() });
    const before = JSON.stringify({ issue: await issueRow(s.issue.id) });
    const result = await call(s, body(s));
    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ state: "blocked", reasonCode: "reassign_target_in_flight", requiredAction: { kind: "wait_active_execution" } });
    expect(JSON.stringify({ issue: await issueRow(s.issue.id) })).toBe(before);
    expect(await resumeWakes(s.issue.id, s.newAgent.id)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(and(eq(heartbeatRuns.issueId, s.issue.id), eq(heartbeatRuns.status, "running")));
  });

  it("[RED] a random target agent is refused before any intent", async () => {
    const s = await seed();
    const refused = await call(s, body(s, { targetAgentId: randomUUID() }));
    expect(refused.status).toBe(404);
    expect(refused.body.error).toBe("target_agent_not_found");
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1")))).toHaveLength(0);
  });

  it("[RED] the old agent's late result does not resolve the new attempt", async () => {
    const s = await seed();
    executeSpy.mockImplementation(() => new Promise(() => undefined)); // 새 담당자 세션이 끝나지 않게 고정
    try {
      const first = await call(s, body(s));
      const action = dataOf(first);
      expect(["delivery_pending", "executing"]).toContain(action.state);
      const lateHeartbeat = randomUUID();
      await db.insert(heartbeatRuns).values({ id: lateHeartbeat, companyId: s.companyId, agentId: s.oldAgent.id, issueId: s.issue.id, status: "succeeded", startedAt: new Date() });
      await completeLinkedWorkflowStepRunsForIssue({ db, issueId: s.issue.id, completedAt: new Date(), heartbeatRunId: lateHeartbeat }); // 이전 담당자의 지연 완료
      expect((await stepRow(s.stepRun.id)).status).toBe("completed"); // 스텝 행은 완료로 마킹됐지만
      const projected = await getResult(s, action.actionId);
      expect(projected.state).not.toBe("resolved"); // 새 시도를 완성시키지 못한다
      expect(projected.reasonCode).toBe("completed_by_prior_agent");
    } finally {
      executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(and(eq(heartbeatRuns.issueId, s.issue.id), eq(heartbeatRuns.status, "running")));
    }
  }, 45_000);

  it("[RED] a revision mission keeps the board fresh/seed boundary", async () => {
    const w = await slice1World(db, root,
      [{ id: "write", title: "Write report", graphWorkProductRequired: true, dependencies: [] }],
      (agentId) => [{ id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true }]);
    const [newAgent] = await db.insert(agents).values({ id: randomUUID(), companyId: w.companyId,
      name: "Revision Worker", role: "worker", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const [ownerTool] = await db.insert(toolDefinitions).values({ companyId: w.companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } }).returning();
    await db.insert(agentToolGrants).values({ companyId: w.companyId, agentId: w.agentId, toolId: ownerTool.id, grantedBy: "test" });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: w.companyId, agentId: w.agentId, issueId: w.planning.id, status: "succeeded" });
    const decision = slice1Decision(w.revision.id, [slice1Unit(newAgent!.id, "write", "Write report",
      { sourceStepId: w.source[0]!.id, graphWorkProductRequired: true, dependencies: [] })],
      w.delta([{ unitId: "write", operation: "rerun", sourceStepId: w.source[0]!.id }]));
    // revision 미션 안에서 진행 중인 고정 실행자 스텝(대상 run 은 요청 미션 소속이어야 한다).
    const [revDef] = await db.insert(workflowDefinitions).values({ companyId: w.companyId, name: "rev-frozen",
      stepsJson: [{ id: "rev-write", name: "Write", type: "agent", agentId: w.agentId, dependencies: [] }] }).returning();
    const [revRun] = await db.insert(workflowRuns).values({ workflowId: revDef!.id, companyId: w.companyId, missionId: w.revision.id, triggeredBy: "test", status: "running" }).returning();
    const [revIssue] = await db.insert(issues).values({ companyId: w.companyId, missionId: w.revision.id,
      title: "Frozen work", status: "blocked", originKind: "workflow_execution", assigneeAgentId: w.agentId }).returning();
    const [revStep] = await db.insert(workflowStepRuns).values({ workflowRunId: revRun!.id, stepId: "rev-write", issueId: revIssue!.id, status: "pending", metadata: {} }).returning();
    const params = { schemaVersion: 1 as const, missionId: w.revision.id, ownerActionIssueId: w.planning.id, actionRequestId: randomUUID(),
      expectedIntentEventId: null, ownerDecisionEventId: null, action: { operation: "reassign" as const,
      target: { kind: "issue_step" as const, issueId: revIssue!.id, workflowRunId: revRun!.id, stepRunId: revStep!.id,
        expectedAuthorityVersion: revRun!.dispatchAuthorityVersion, expectedExecutionGeneration: revStep!.executionGeneration, failedDispatchRequestId: null },
      targetAgentId: newAgent!.id, plan: { planningIssueId: w.planning.id, expectedDecisionHash: null, decision } } };
    const result = await executeCoreWorkflowTool({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId, toolName: "mission_owner_execute", parameters: params, requestId: randomUUID() });
    expect(result.status).toBe(200);
    const action = dataOf(result);
    expect(action).toMatchObject({ state: "applied", reasonCode: "plan_qa_pending" });
    const [planQaIssue] = await db.select().from(issues).where(and(eq(issues.missionId, w.revision.id), eq(issues.originKind, "mission_plan_qa")));
    await qaVerdict(w.companyId, w.revision.id, planQaIssue!.id); // 독립 QA pass → 물화는 board 경계에서 멈춘다
    const projected = await getMissionOwnerActionResult({ db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId }, { schemaVersion: 1, missionId: w.revision.id, actionId: action.actionId });
    expect(projected).toMatchObject({ state: "blocked", reasonCode: "board_revision_start_required", requiredAction: { kind: "board_revision_start" } }); // ordinary 가 아닌 미션의 기존 board 대기 보존
    expect((await db.select().from(workflowRuns).where(and(eq(workflowRuns.missionId, w.revision.id), ne(workflowRuns.id, revRun!.id)))).length).toBe(0); // 물화는 새 run 을 만들지 않는다
  }, 60_000);
});
