import { and, desc, eq } from "drizzle-orm";
import { missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { readPlanQaVerdict } from "./mission-plan-qa-completion-gate.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Derived from scoped durable definition + current structured QA authority; display marker is ignored. */
export async function loadRevisionBoardWait(db: Db, companyId: string, missionId: string) {
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)));
  if (!mission?.sourceMissionId) return null;
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, companyId),
    eq(missionPlanArtifacts.missionId, missionId), eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const refs = record(plan?.refs), paqo = record(refs.paqoWorkflow), qa = record(refs.planQa);
  const hash = record(refs.ownerPlanDecision).decisionHash;
  if (!plan || typeof paqo.workflowDefinitionId !== "string" || typeof hash !== "string"
    || paqo.decisionHash !== hash || qa.decisionHash !== hash || typeof qa.issueId !== "string") return null;
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, paqo.workflowDefinitionId),
    eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.missionId, missionId), eq(workflowDefinitions.sourceKind, "paqo")));
  if (!definition?.definitionHash) return null;
  const [run] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.missionId, missionId), eq(workflowRuns.workflowId, definition.id))).limit(1);
  if (run || (await readPlanQaVerdict({ db, companyId, missionId, missionPlanArtifactId: plan.id,
    planQaIssueId: qa.issueId, decisionHash: hash }))?.verdict !== "pass") return null;
  return { workflowDefinitionId: definition.id, sourceMissionId: mission.sourceMissionId,
    sourceWorkflowRunId: mission.sourceWorkflowRunId, planArtifactId: plan.id, decisionHash: hash };
}

export async function revisionBoardWaitingMissionIds(db: Db, companyId: string, missionIds: string[]) {
  const waiting = await Promise.all(missionIds.map(async id => await loadRevisionBoardWait(db, companyId, id) ? id : null));
  return new Set(waiting.filter((id): id is string => id !== null));
}
