import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues, missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { hasMissionPlanQaCompletionLedger } from "./missions/mission-plan-qa-completion-gate.js";
import { hasWorkflowValidationCompletionLedger } from "./workflow/validation-verdict-ledger.js";
import { unblockIssueHasValidatedHandbackReport } from "./missions/owner-action-unblock-handback.js";

export const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);

export async function assertCanCompleteMissionOversightIssue(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.originKind !== "mission_main_executor_oversight" || !issue.missionId) return;

  const [mission] = await db
    .select({ id: missions.id, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
    .limit(1);
  if (!mission) return;
  if (!TERMINAL_MISSION_STATUSES.has(mission.status)) {
    throw unprocessable(
      `Cannot complete mission oversight while mission ${mission.id} is ${mission.status}.`,
    );
  }

  const openWork = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, issue.companyId),
      eq(issues.missionId, issue.missionId),
      isNull(issues.hiddenAt),
      ne(issues.id, issue.id),
      sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
      sql`${issues.status} not in ('done', 'cancelled')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (openWork) {
    throw unprocessable(
      `Cannot complete mission oversight while mission work remains open (${openWork.identifier ?? openWork.id}: ${openWork.status}).`,
    );
  }

  const activeWorkflowRun = await db
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, issue.companyId),
      eq(workflowRuns.missionId, issue.missionId),
      sql`${workflowRuns.status} not in ('completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'canceled', 'aborted')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (activeWorkflowRun) {
    throw unprocessable(
      `Cannot complete mission oversight while workflow run ${activeWorkflowRun.id} is ${activeWorkflowRun.status}.`,
    );
  }

  const activeWorkflowStep = await db
    .select({
      runId: workflowRuns.id,
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowRuns.companyId, issue.companyId),
      eq(workflowRuns.missionId, issue.missionId),
      sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (activeWorkflowStep) {
    throw unprocessable(
      `Cannot complete mission oversight while workflow step ${activeWorkflowStep.stepId} is ${activeWorkflowStep.status}.`,
    );
  }
}

export async function assertCanCompleteMissionPlanQaIssue(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.originKind !== "mission_plan_qa") return;
  const ledger = await hasMissionPlanQaCompletionLedger({
    db,
    companyId: issue.companyId,
    missionId: issue.missionId,
    planQaIssueId: issue.id,
  });
  if (ledger.satisfied) return;
  throw unprocessable(
    `Cannot complete mission_plan_qa issue without an official mission_plan_qa_verdicts row for ${ledger.decisionHash ? "the active plan decision hash" : "that plan QA issue"}.`,
  );
}

export async function assertCanCompleteWorkflowValidationIssue(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.originKind !== "workflow_execution") return;
  const ledger = await hasWorkflowValidationCompletionLedger({ db, issue });
  if (!ledger.isCandidate || ledger.satisfied) return;
  throw unprocessable(
    "Cannot complete workflow validation issue without an official workflow_validation_verdict ledger event for that workflow QA issue.",
  );
}

// [owner-action next-execution contract] mission_main_executor_unblock이 done으로 닫히려면
//   source(originId)로 handback 증거가 있어야 — GAZ-315 silent success(자기 unblock issue에 workflow API
//   실패 후 일반 done, source 향 wakeup 없음) 방지. evidence는 DB state 우선(source 회복/wakeup dispatch).
export async function assertCanCompleteOwnerActionWithHandback(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.originKind !== "mission_main_executor_unblock") return;
  const sourceIssueId = issue.originId;
  if (!sourceIssueId) return; // source 미지정 → 강제 불가

  const [source] = await db
    .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, issue.companyId)))
    .limit(1);
  if (!source) return; // source 회수/삭제 또는 다른 회사 → 강제 불가
  // evidence 1: source가 blocked에서 벗어남(재오픈/회복 = supervision retry 적용 효과).
  if (source.status !== "blocked") return;
  if (await unblockIssueHasValidatedHandbackReport(db, {
    companyId: issue.companyId,
    unblockIssueId: issue.id,
    expectedSourceIssueId: sourceIssueId,
  })) {
    return;
  }
  // evidence 2: source 담당자(assignee) 향 wakeup이 allowed status로 dispatch됨.
  //   assignee 없는 source는 wakeup 대상이 없으므로 evidence 불가 → conflict.
  if (!source.assigneeAgentId) {
    throw conflict(
      "Cannot complete this owner-action (mission_main_executor_unblock): the source issue is blocked and has no assignee agent to wake for handback.",
    );
  }
  const [wake] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.issueId, sourceIssueId),
      eq(agentWakeupRequests.companyId, issue.companyId),
      eq(agentWakeupRequests.agentId, source.assigneeAgentId),
      // "claimed" 포함: queue admission 이 claim 한 wakeup 도 live evidence 이다(Phase D
      //   stopped 판정과 동일 live 집합).
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced"]),
  ))
    .limit(1);
  if (wake) return;

  throw conflict(
    "Cannot complete this owner-action (mission_main_executor_unblock): the source issue is still blocked, no live wakeup has been dispatched to it, and no structured Oversight handback report is present. Post a Mission owner decision on the source issue, or complete it via the owner-action handback route so a structured report/native workflow_resume is recorded; do not use the Workflow API on this unblock issue.",
  );
}
