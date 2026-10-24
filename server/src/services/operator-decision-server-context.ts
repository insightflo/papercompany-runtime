import { and, desc, eq } from "drizzle-orm";
import { missionPlanArtifacts, type Db } from "@paperclipai/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-owned context is excluded when rebuilding the caller-authored immutable card input. */
export function stripOperatorDecisionServerContext(sourceContext: unknown): Record<string, unknown> {
  if (sourceContext === null || typeof sourceContext !== "object" || Array.isArray(sourceContext)) return {};
  const { planDecisionHash: _plan, missionOwnerHumanInput: _display, ...publicContext }
    = sourceContext as Record<string, unknown>;
  return publicContext;
}

/** Current active owner-plan decision hash used to bind a human approval to one revision. */
export async function activePlanDecisionHash(db: Pick<Db, "select">, companyId: string, missionId: string) {
  if (!UUID_RE.test(missionId)) return null;
  const [plan] = await db.select({ refs: missionPlanArtifacts.refs }).from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const refs = plan?.refs !== null && typeof plan?.refs === "object" && !Array.isArray(plan.refs)
    ? plan.refs as Record<string, unknown> : {};
  const owner = refs.ownerPlanDecision !== null && typeof refs.ownerPlanDecision === "object"
    && !Array.isArray(refs.ownerPlanDecision) ? refs.ownerPlanDecision as Record<string, unknown> : {};
  return typeof owner.decisionHash === "string" && owner.decisionHash.trim() ? owner.decisionHash : null;
}
