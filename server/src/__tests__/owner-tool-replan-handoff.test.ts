import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  heartbeatRuns,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { missionService, type MissionServiceDeps } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping owner tool replan handoff tests: ${support.reason ?? "unsupported host"}`);
}

// 라이브 결함 재현(A1 5207d3bf / RES-10929): 워크플로 트리거 미션은 초기 [PLAN] 이슈 없이 시작하고,
// 도구 단계 실패로 만들어진 tool-bound [Owner Action] 카드에 제출된 replan_mission 결정이
// applyOwnerToolRecovery 의 no_op(retry_not_requested)+continue 에 갇혀 실체화되지 않았다.
// 이 파일은 (A) 열림/done 카드 모두에서 감시 스윕이 [PLAN] 이슈를 만들고 오너를 깨우는지,
// (B) 두 번째 스윕이 멱등인지, (C) replan 이 아닌 도구 카드 결정은 여전히 일반 재시도로
// 빠지지 않는지를 실제 임베디드 PG 로 검증한다.
describeEmbeddedPostgres("tool-bound owner action replan_mission materializes through the general decision lane", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb> | null = null;
  const roots: string[] = [];
  const planningWakes: Array<{ missionId: string; issueId: string; targetAgentId: string; idempotencyKey: string }> = [];

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-tool-replan-handoff-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => {
    await temp?.cleanup();
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  const deps: MissionServiceDeps = {
    onOwnerPlanningIssueCreated: async ({ mission, issue, targetAgentId, idempotencyKey }) => {
      planningWakes.push({ missionId: mission.id, issueId: issue.id, targetAgentId, idempotencyKey });
    },
  };
  const sweep = (companyId: string) =>
    missionService(db!, deps).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(),
      applyOwnerDecisionActions: true,
    });

  /** seedToolRecoveryScenario 를 라이브 실패 형태(실행 failed + 도구 단계 failed + frozen 정의 + tool 카드)로 완성한다. */
  async function seedFailedToolCard(cardStatus: "todo" | "done") {
    const scenario = await seedToolRecoveryScenario({ db: db!, artifactExists: true, captureExecutionDefinitionSnapshot: true });
    roots.push(scenario.tempRoot);
    const [originalRun] = await db!.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.workflowRunId));
    const failedAt = new Date();
    await db!.update(workflowRuns).set({
      status: "failed",
      startedAt: originalRun.createdAt,
      completedAt: failedAt,
      metadata: { executionDefinitionVersion: 1 },
    }).where(eq(workflowRuns.id, scenario.workflowRunId));
    await db!.update(workflowStepRuns).set({ startedAt: originalRun.createdAt, completedAt: failedAt })
      .where(eq(workflowStepRuns.id, scenario.stepRunId));
    await db!.update(issues).set({ status: cardStatus }).where(eq(issues.id, scenario.recoveryIssueId));
    await db!.insert(workflowTransitionEvents).values({
      companyId: scenario.companyId,
      missionId: scenario.missionId,
      issueId: scenario.recoveryIssueId,
      workflowRunId: scenario.workflowRunId,
      workflowStepRunId: scenario.stepRunId,
      layer: "mission_owner_recovery",
      eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${scenario.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: scenario.workflowRunId, stepRunId: scenario.stepRunId },
    });
    await db!.insert(workflowTerminalDecisions).values({
      companyId: scenario.companyId,
      workflowRunId: scenario.workflowRunId,
      decidedAuthorityVersion: originalRun.dispatchAuthorityVersion,
      decision: "failed",
      policyCause: "recovery_deadline_hard",
      discoveryPath: "stuck_diagnostic",
      origin: "reconciler",
    });
    return scenario;
  }

  async function currentTarget(scenario: { workflowRunId: string; stepRunId: string }) {
    const [run] = await db!.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.workflowRunId));
    const [step] = await db!.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.stepRunId));
    return {
      kind: "tool_step" as const,
      workflowRunId: run.id,
      stepRunId: step.id,
      expectedAuthorityVersion: run.dispatchAuthorityVersion,
      expectedExecutionGeneration: step.executionGeneration,
      failedDispatchRequestId: step.lastDispatchRequestId,
    };
  }

  async function decide(
    scenario: { companyId: string; missionId: string; recoveryIssueId: string; ownerAgentId: string },
    decision: "replan_mission" | "no_action_waiting" | "retry_source_issue",
    recoveryTarget?: Record<string, unknown>,
  ) {
    const heartbeatRunId = randomUUID();
    await db!.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: scenario.companyId,
      agentId: scenario.ownerAgentId,
      issueId: scenario.recoveryIssueId,
      status: "succeeded",
    });
    const submission = missionOwnerDecisionSubmitSchema.parse({
      decision,
      ...(recoveryTarget ? { recoveryTarget } : {}),
      ...(decision === "replan_mission" ? { reason: "tool step failed; revise the mission plan" } : {}),
    });
    const [card] = await db!.select().from(issues).where(eq(issues.id, scenario.recoveryIssueId));
    await recordMissionOwnerDecision({
      db: db!,
      issue: { id: card.id, companyId: scenario.companyId, missionId: scenario.missionId },
      heartbeatRunId,
      sourceIssueId: card.originId,
      submission,
    });
  }

  const planningIssues = (missionId: string) =>
    db!.select().from(issues).where(and(eq(issues.missionId, missionId), eq(issues.originKind, "mission_main_executor_plan")));

  it.each([["todo"], ["done"]])(
    "materializes the [PLAN] issue and wakes the owner when the replan_mission decision sits on a %s tool card",
    async (cardStatus) => {
      const scenario = await seedFailedToolCard(cardStatus as "todo" | "done");
      await decide(scenario, "replan_mission", await currentTarget(scenario));
      const result = await sweep(scenario.companyId);
      const missionResult = result.missions[0]!;
      const plans = await planningIssues(scenario.missionId);
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        originKind: "mission_main_executor_plan",
        assigneeAgentId: scenario.ownerAgentId,
        status: "todo",
        title: "[PLAN] Issue-less tool recovery result mission",
      });
      expect(missionResult.appliedActions).toContainEqual(expect.objectContaining({
        type: "owner_decision_replan_mission",
        missionId: scenario.missionId,
        ownerActionIssueId: scenario.recoveryIssueId,
        planningIssueId: plans[0]!.id,
        resultStatus: "todo",
      }));
      expect(missionResult.findings.some((finding) => finding.includes("tool_step_recovery_no_op"))).toBe(false);
      expect(planningWakes).toContainEqual({
        missionId: scenario.missionId,
        issueId: plans[0]!.id,
        targetAgentId: scenario.ownerAgentId,
        idempotencyKey: `mission-owner-replan-wakeup:${scenario.missionId}:${plans[0]!.id}`,
      });
    },
    120_000,
  );

  it("keeps the second supervision sweep idempotent (no duplicate [PLAN], no false no_op blocking)", async () => {
    const scenario = await seedFailedToolCard("done");
    await decide(scenario, "replan_mission", await currentTarget(scenario));
    await sweep(scenario.companyId);
    const firstPlans = await planningIssues(scenario.missionId);
    expect(firstPlans).toHaveLength(1);
    const second = await sweep(scenario.companyId);
    const missionResult = second.missions[0]!;
    const plans = await planningIssues(scenario.missionId);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe(firstPlans[0]!.id);
    expect(missionResult.findings.some((finding) => finding.includes("tool_step_recovery_no_op"))).toBe(false);
    expect(missionResult.findings.some((finding) => finding.includes("reason=retry_not_requested"))).toBe(false);
    expect(missionResult.appliedActions).toContainEqual(expect.objectContaining({
      type: "owner_decision_replan_mission",
      planningIssueId: plans[0]!.id,
      resultStatus: plans[0]!.status,
    }));
    const wakesForMission = planningWakes.filter((wake) => wake.missionId === scenario.missionId);
    expect(wakesForMission).toHaveLength(2);
    expect(new Set(wakesForMission.map((wake) => wake.idempotencyKey)).size).toBe(1);
  }, 120_000);

  it("still holds a non-replan decision on a tool card closed (no generic retry, no planning issue)", async () => {
    const scenario = await seedFailedToolCard("done");
    await decide(scenario, "no_action_waiting", await currentTarget(scenario));
    const result = await sweep(scenario.companyId);
    const missionResult = result.missions[0]!;
    expect(missionResult.findings.some((finding) => finding.includes("tool_step_recovery_no_op"))).toBe(true);
    expect(missionResult.findings.some((finding) => finding.includes("reason=retry_not_requested"))).toBe(true);
    expect(await planningIssues(scenario.missionId)).toHaveLength(0);
    expect(missionResult.appliedActions.some((action) => action.type === "owner_decision_retry_source_issue")).toBe(false);
    const [oversight] = await db!.select().from(issues).where(eq(issues.id, scenario.oversightIssueId));
    expect(oversight.status).toBe("todo");
    const [step] = await db!.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.stepRunId));
    expect(step.status).toBe("failed");
  }, 120_000);

  it("still holds a stale tool target decision closed instead of falling through to a generic retry", async () => {
    const scenario = await seedFailedToolCard("done");
    const stale = { ...(await currentTarget(scenario)), expectedExecutionGeneration: 77 };
    await decide(scenario, "retry_source_issue", stale);
    const result = await sweep(scenario.companyId);
    const missionResult = result.missions[0]!;
    expect(missionResult.findings.some((finding) => finding.includes("tool_step_recovery_no_op"))).toBe(true);
    expect(await planningIssues(scenario.missionId)).toHaveLength(0);
    expect(missionResult.appliedActions).toEqual([]);
    const [step] = await db!.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.stepRunId));
    expect(step.status).toBe("failed");
    const events = await db!.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.companyId, scenario.companyId));
    expect(events.some((event) => event.idempotencyKey?.startsWith("mission-native-tool-step-retry:"))).toBe(false);
  }, 120_000);
});
