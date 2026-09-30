import { and, eq, inArray } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
  workflowDefinitions, workflowRecoveryAuthorities, type Db } from "@paperclipai/db";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "./replacement-execution-safety.js";
import { conflict } from "../../errors.js";
import { loadLatestMissionOwnerDecision } from "../missions/mission-owner-recovery-ledger.js";

export async function lockReplacementScope(db: Db, companyId: string, sourceRunId: string, decisionEventId: string) {
  const [observed] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, sourceRunId), eq(workflowRuns.companyId, companyId)));
  if (!observed?.missionId) throw conflict("replacement_source_missing");
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, observed.missionId), eq(missions.companyId, companyId))).for("update");
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, sourceRunId)).for("update");
  if (!mission || mission.status !== "active" || !run || run.missionId !== mission.id || run.status !== "failed"
    || run.parentRunId || run.parentStepRunId || run.triggeredBy === "workflow-step") throw conflict("replacement_source_ineligible");
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).for("update");
  const [terminal] = await db.select().from(workflowTerminalDecisions).where(and(eq(workflowTerminalDecisions.workflowRunId, run.id),
    eq(workflowTerminalDecisions.companyId, companyId), eq(workflowTerminalDecisions.decidedAuthorityVersion, run.dispatchAuthorityVersion)));
  if (!terminal || terminal.decision !== "failed") throw conflict("replacement_terminal_decision_missing");
  await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, decisionEventId)).for("share");
  const owner = await loadLatestMissionOwnerDecision({ db, companyId, missionId: mission.id });
  const target = owner?.decision.recoveryTarget;
  if (!owner || owner.eventId !== decisionEventId || owner.authorAgentId !== mission.ownerAgentId
    || owner.decision.decision !== "restart_from_start" || target?.kind !== "tool_step"
    || target.workflowRunId !== run.id || target.expectedAuthorityVersion !== run.dispatchAuthorityVersion) throw conflict("replacement_owner_decision_invalid");
  const step = steps.find((s) => s.id === target.stepRunId);
  if (!step || step.status !== "failed" || step.executionGeneration !== target.expectedExecutionGeneration
    || step.lastDispatchRequestId !== target.failedDispatchRequestId) throw conflict("replacement_generation_stale");
  const live = await replacementExecutionInFlight(db, companyId, run.id, steps);
  if (await replacementBudgetBlocked(db, companyId, mission.ownerAgentId)) throw conflict("replacement_budget_hard_stop");
  const [competing] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.missionId, mission.id), eq(workflowRuns.workflowId, run.workflowId), inArray(workflowRuns.status, ["pending", "running"]))).limit(1);
  if (live || competing) throw conflict("replacement_execution_in_flight");
  const [consumed] = await db.select().from(workflowRecoveryAuthorities).where(and(eq(workflowRecoveryAuthorities.workflowRunId, run.id),
    eq(workflowRecoveryAuthorities.targetAuthorityVersion, run.dispatchAuthorityVersion))).limit(1);
  if (consumed) throw conflict("replacement_authority_consumed");
  return { mission, run, steps, step, terminal, owner };
}

// Call after approval/decision locks. Never acquire definition before the approval being consumed.
export async function lockReplacementDefinition(db: Db, companyId: string, workflowId: string) {
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, workflowId),
    eq(workflowDefinitions.companyId, companyId))).for("share");
  if (!definition || definition.status !== "active") throw conflict("replacement_definition_ineligible");
  return definition;
}
