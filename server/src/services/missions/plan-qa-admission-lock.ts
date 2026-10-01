import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missionPlanArtifacts, missionPlanQaVerdicts, missions } from "@paperclipai/db";
import type { QualityDb } from "../quality/contract.js";

/** Shared ordering for PLAN-QA producers and board admission: mission → plan → issue → heartbeat → verdict.
 * Lock before reading authority, and retain the locks through the run/snapshot commit.
 */
export async function lockMissionPlanQaAuthority(db: QualityDb, companyId: string, missionId: string) {
  await lockPlanQaMission(db, companyId, missionId);
  const plans = await db.select().from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
    eq(missionPlanArtifacts.status, "active"),
  )).orderBy(missionPlanArtifacts.id).for("update");
  const ids = new Set<string>();
  for (const plan of plans) {
    const qa = plan.refs?.planQa as { issueId?: unknown } | undefined;
    if (typeof qa?.issueId === "string") ids.add(qa.issueId);
  }
  for (const issueId of [...ids].sort()) {
    await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
    await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
    )).orderBy(heartbeatRuns.id).for("update");
    await db.select({ id: missionPlanQaVerdicts.id }).from(missionPlanQaVerdicts).where(and(
      eq(missionPlanQaVerdicts.companyId, companyId), eq(missionPlanQaVerdicts.planQaIssueId, issueId),
    )).orderBy(missionPlanQaVerdicts.id).for("update");
  }
}

export async function lockPlanQaMission(db: QualityDb, companyId: string, missionId: string) {
  await db.select({ id: missions.id }).from(missions).where(and(
    eq(missions.companyId, companyId), eq(missions.id, missionId),
  )).for("update");
}

export async function lockPlanQaArtifact(db: QualityDb, companyId: string, planArtifactId: string) {
  const [plan] = await db.select({ missionId: missionPlanArtifacts.missionId }).from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.id, planArtifactId),
  ));
  if (plan) await lockPlanQaMission(db, companyId, plan.missionId);
  await db.select({ id: missionPlanArtifacts.id }).from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.id, planArtifactId),
  )).for("update");
}
