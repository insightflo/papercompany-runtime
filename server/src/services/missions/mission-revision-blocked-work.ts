// server/src/services/missions/mission-revision-blocked-work.ts
// [Q4] 활성 계획 refs(missionPlanArtifacts status="active" 최신 revision — revision-start-options 와 동일 조회)의
//   차단 단위(revisionBlockedUnits) 잔존 여부 조회. 소비처는 owner-actions 자동 완료 정산 가드뿐이다.
import { and, desc, eq } from "drizzle-orm";
import { missionPlanArtifacts, type Db } from "@paperclipai/db";

function activePlanBlockedUnitEntries(refs: unknown): unknown[] {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return [];
  const stored = (refs as Record<string, unknown>).revisionBlockedUnits;
  return Array.isArray(stored) ? stored : [];
}

/** 활성 계획에 유효한 차단 단위(unitId 보유)가 하나라도 있으면 참 — 자동 완료 보류 판정에만 쓴다. */
export async function hasActivePlanBlockedRevisionUnits(db: Db, companyId: string, missionId: string): Promise<boolean> {
  const [activePlan] = await db.select({ refs: missionPlanArtifacts.refs }).from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  return activePlanBlockedUnitEntries(activePlan?.refs).some(entry =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as Record<string, unknown>).unitId === "string"
      && ((entry as Record<string, unknown>).unitId as string).trim() !== "");
}
