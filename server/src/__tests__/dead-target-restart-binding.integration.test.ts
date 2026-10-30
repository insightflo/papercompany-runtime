import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanQaVerdicts,
  missionQualityVerdicts,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowQaRebindClaims,
  workflowRecoveryAuthorities,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureDeadTargetHumanEscalation } from "../services/missions/mission-owner-dead-target-loop.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

async function snapshotDeadTargetState(db: ReturnType<typeof createDb>, companyId: string, decisionId: string) {
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId))
    .orderBy(asc(workflowRuns.id));
  const runIds = runs.map((run) => run.id);
  const [decisions, issueRows, stepRuns, invocations, products, events, continuations, wakeups,
    heartbeats, comments, activity, planQa, missionQa, rebindClaims, terminalDecisions, terminalEffects,
    recoveryAuthorities] = await Promise.all([
    db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId)).orderBy(asc(operatorDecisions.id)),
    db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(asc(issues.id)),
    db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds)).orderBy(asc(workflowStepRuns.id)),
    db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)).orderBy(asc(workflowStepInvocations.id)),
    db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)).orderBy(asc(issueWorkProducts.id)),
    db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)).orderBy(asc(workflowTransitionEvents.id)),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId))
      .orderBy(asc(operatorDecisionContinuations.id)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).orderBy(asc(agentWakeupRequests.id)),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.id)),
    db.select().from(issueComments).where(eq(issueComments.companyId, companyId)).orderBy(asc(issueComments.id)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(asc(activityLog.id)),
    db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.companyId, companyId)).orderBy(asc(missionPlanQaVerdicts.id)),
    db.select().from(missionQualityVerdicts).where(eq(missionQualityVerdicts.companyId, companyId)).orderBy(asc(missionQualityVerdicts.id)),
    db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, companyId)).orderBy(asc(workflowQaRebindClaims.id)),
    db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, companyId)).orderBy(asc(workflowTerminalDecisions.id)),
    db.select().from(workflowTerminalEffectIntents).where(eq(workflowTerminalEffectIntents.companyId, companyId)).orderBy(asc(workflowTerminalEffectIntents.id)),
    db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, companyId)).orderBy(asc(workflowRecoveryAuthorities.id)),
  ]);
  return { decisions, issues: issueRows, runs, stepRuns, invocations, products, events, continuations, wakeups,
    heartbeats, comments, activity, planQa, missionQa, rebindClaims, terminalDecisions, terminalEffects,
    recoveryAuthorities };
}

describe("dead-target card structured restart binding", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("dead-target-binding-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
  });

  it("keeps the failed-run-bound escalation pending when restart scope is unproven", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), workflowRunId = randomUUID();
    const sourceIssueId = randomUUID(), anchorIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dead target binding", issuePrefix: "DTB" });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "Recover dead source", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId,
      name: "Recovery workflow", stepsJson: [{ id: "collect", name: "Collect", dependencies: [] }] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId,
      status: "failed", triggeredBy: "test", completedAt: new Date() });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Dead source", status: "done",
        originKind: "workflow_execution", assigneeAgentId: ownerAgentId },
      { id: anchorIssueId, companyId, missionId, title: "Recovery oversight", status: "blocked",
        originKind: "mission_main_executor_oversight", assigneeAgentId: ownerAgentId },
    ]);
    await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "collect", status: "failed",
      issueId: sourceIssueId });

    const result = await ensureDeadTargetHumanEscalation(db, {
      companyId, missionId, ownerAgentId, loopKey: "retry_source_issue",
      anchors: [{ id: anchorIssueId, status: "blocked", title: "Recovery oversight", identifier: null }],
      ownerActionIssueId: anchorIssueId, sourceIssueId,
      reason: "dead target", evidence: "source_terminal",
    });
    expect(result).toEqual({ ensured: true, reason: "card-created" });
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, companyId));
    expect(card.sourceContext.workflowRunId).toBe(workflowRunId);
    expect(card.definition.options.map((option) => option.id)).toEqual([
      WORKFLOW_RESTART_FROM_START_OPTION_ID,
    ]);
    expect(card.definition.approvedScope).toContain("workflow_run.restart_from_start");
    expect(card.definition.options.some((option) => option.id === "retry-a-different-live-source"))
      .toBe(false);

    const before = await snapshotDeadTargetState(db, companyId, card.id);
    await expect(operatorDecisionWriteService(db).resolve(card.id, {
      actionId: "submit",
      selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID],
      comment: "restart with the bound failed run",
    }, "board-user")).rejects.toMatchObject({
      status: 409,
      message: "이미 수행한 작업을 보존하기 위해 재시작하지 않았습니다. 현재 결정은 전체 수집 또는 처음부터 재시작할 권한과 근거를 확인해 주지 못합니다.",
      details: { code: "recovery_restart_scope_unproven", operatorDecisionId: card.id },
    });
    const after = await snapshotDeadTargetState(db, companyId, card.id);
    expect(after).toEqual(before);
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toEqual(card);
    expect(after.decisions[0]!.status).toBe("pending");
    expect(after.issues.find((issue) => issue.id === sourceIssueId)!.status).toBe("done");
    expect(after.issues.find((issue) => issue.id === anchorIssueId)!.status).toBe("blocked");
    expect(after.runs.map((run) => run.id)).toEqual([workflowRunId]);
  });
});
