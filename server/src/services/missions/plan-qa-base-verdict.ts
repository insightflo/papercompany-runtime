import { and, eq } from "drizzle-orm";
import { activityLog, heartbeatRuns, missionPlanQaVerdicts } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { hashContract } from "../quality/contract.js";
import { buildPlanQaScope, loadPlanQaMarker, loadPlanQaVerdictRow, planQaGateMode, stateForAttempt } from "./plan-qa-addendum-gate.js";
import { lockPlanQaAttempt } from "./plan-qa-current-attempt.js";
import type { recordMissionPlanQaVerdict } from "./mission-plan-qa-verdicts.js";

/** Pin the base result to the same authenticated scope as the addendum, never a free-floating row. */
export async function recordPinnedPlanQaBase(input: Parameters<typeof recordMissionPlanQaVerdict>[0]): Promise<boolean> {
  const marker = await loadPlanQaMarker(input.db, input.companyId, input.planQaIssueId);
  if (marker && (await planQaGateMode(input.db, { companyId: input.companyId, planQaIssueId: input.planQaIssueId })).kind === "legacy") return false;
  if (!marker || input.reviewedBy.actorType !== "agent" || !input.sourceRunId || input.sourceCommentId) return false;
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId),
  )).limit(1);
  if (!run || run.executionEpoch === null) throw conflict("quality_plan_qa_attempt_mismatch");
  const actor = { companyId: input.companyId, agentId: input.reviewedBy.actorId, heartbeatRunId: run.id, executionEpoch: run.executionEpoch };
  const scope = await buildPlanQaScope(input.db, { ...actor, issueId: input.planQaIssueId });
  if (scope.missionId !== input.missionId || scope.decisionHash !== input.decisionHash) throw conflict("quality_plan_qa_attempt_mismatch");
  return input.db.transaction(async (tx) => {
    await lockPlanQaAttempt(tx, scope, actor);
    const loaded = await loadPlanQaVerdictRow(tx, scope, actor);
    const state = stateForAttempt(loaded.state, scope);
    if (state.verdict) {
      if (state.verdict.baseVerdict !== input.verdict) throw conflict("quality_plan_qa_submission_conflict");
      return true;
    }
    state.baseVerdict = { status: input.verdict, scopeHash: hashContract(scope) };
    await tx.update(missionPlanQaVerdicts).set({
      qualityContract: state, verdict: "pending", reviewerAgentId: actor.agentId, reviewerUserId: null,
      sourceRunId: run.id, sourceCommentId: null, diagnostics: input.diagnostics ?? [], updatedAt: new Date(),
    }).where(and(eq(missionPlanQaVerdicts.companyId, input.companyId), eq(missionPlanQaVerdicts.id, loaded.row.id)));
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "agent", actorId: actor.agentId,
      action: "mission.plan_qa.base_submitted", entityType: "issue", entityId: scope.issueId,
      details: { decisionHash: scope.decisionHash, reviewGeneration: scope.reviewGeneration, sourceRunId: run.id } });
    return true;
  });
}
