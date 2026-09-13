import { and, desc, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missionPlanArtifacts } from "@paperclipai/db";
import type { PlanQaScope, QualityAgentActor } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { hashContract, type QualityDb } from "../quality/contract.js";
import { verifyEvidenceScope } from "../quality/evidence-verifier.js";
import { planQaInputHashForPlan } from "./plan-qa-addendum-manifest.js";
import { planQaReviewBindingMarkerSchema } from "./plan-qa-review-binding.js";

function mismatch(): never { throw conflict("quality_plan_qa_attempt_mismatch", { code: "quality_plan_qa_attempt_mismatch" }); }

/** Both live writers and later readers validate identity; only writers require a live checkout. */
export async function assertCurrentPlanQaScope(db: QualityDb, scope: PlanQaScope, actor?: QualityAgentActor) {
  await verifyEvidenceScope(db, scope.companyId, scope);
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId))).limit(1);
  const marker = planQaReviewBindingMarkerSchema.safeParse(issue?.qualityPlanQaBinding);
  if (!issue || !marker.success || marker.data.supersededAt || issue.originKind !== "mission_plan_qa"
    || issue.status === "cancelled" || issue.hiddenAt || marker.data.companyId !== scope.companyId
    || marker.data.missionId !== scope.missionId || marker.data.planArtifactId !== scope.planArtifactId
    || marker.data.decisionHash !== scope.decisionHash || marker.data.reviewGeneration !== scope.reviewGeneration
    || hashContract(marker.data.manifestRef) !== hashContract(scope.manifestRef)) mismatch();
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, scope.companyId), eq(missionPlanArtifacts.id, scope.planArtifactId),
    eq(missionPlanArtifacts.missionId, scope.missionId), eq(missionPlanArtifacts.status, "active"),
  )).limit(1);
  if (!plan || planQaInputHashForPlan(plan, scope.decisionHash) !== marker.data.inputHash) mismatch();
  const refs = plan.refs as Record<string, unknown> | null;
  const planQa = refs?.planQa as Record<string, unknown> | undefined;
  if (!planQa || planQa.issueId !== scope.issueId || planQa.decisionHash !== scope.decisionHash) mismatch();
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.heartbeatRunId),
  )).limit(1);
  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.issueId, scope.issueId),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!run || latest?.id !== run.id || run.agentId !== issue.assigneeAgentId
    || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)
    || (issue.executionRunId !== null && issue.executionRunId !== run.id)) mismatch();
  if (actor && (actor.companyId !== scope.companyId || actor.agentId !== run.agentId
    || actor.heartbeatRunId !== run.id || actor.executionEpoch !== run.executionEpoch
    || issue.checkoutRunId !== run.id || issue.status !== "in_progress" || run.status !== "running")) mismatch();
  return { issue, run, marker: marker.data, plan };
}

/** A common issue-row lock serializes first insert, reads, and submissions for one review. */
export async function lockPlanQaAttempt(db: QualityDb, scope: PlanQaScope, actor: QualityAgentActor) {
  await db.select({ id: missionPlanArtifacts.id }).from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, scope.companyId), eq(missionPlanArtifacts.id, scope.planArtifactId),
  )).for("update").limit(1);
  await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId),
  )).for("update").limit(1);
  await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.heartbeatRunId),
  )).for("update").limit(1);
  await assertCurrentPlanQaScope(db, scope, actor);
}
