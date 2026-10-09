import { missions, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { MissionRow } from "../missions.js";
import type { createOwnerActions } from "./owner-actions.js";
import { isTerminalMissionStatus } from "./shared-types.js";
import type { MissionOwnerSupervisionResult } from "./supervision-types.js";

type OwnerActions = ReturnType<typeof createOwnerActions>;

/** Lifecycle eligibility is deliberately coarse; only the canonical reconciler decides settlement. */
export async function reconcileSupervisionMission(
  db: Db, ownerActions: OwnerActions, mission: MissionRow,
): Promise<{ mission: MissionRow; terminal: MissionOwnerSupervisionResult | null }> {
  await ownerActions.reconcileMissionStatusFromWorkflowRuns(mission);
  // Cleanup can reject a stale epoch. Never use the pre-reconcile snapshot for supervision.
  const [current] = await db.select().from(missions).where(eq(missions.id, mission.id));
  const refreshed = current ?? mission;
  return {
    mission: refreshed,
    terminal: isTerminalMissionStatus(refreshed.status) ? {
      missionId: refreshed.id,
      oversightIssueId: null,
      findings: mission.status !== refreshed.status
        ? [`mission_settled_from_workflow_runs: mission=${refreshed.id} canonical lifecycle status=${refreshed.status}`] : [],
      recommendations: [],
      appliedActions: mission.status !== refreshed.status ? [{
        type: "mission_settled_from_workflow_runs", missionId: refreshed.id, resultStatus: refreshed.status,
      }] : [],
      ownerActionExplanations: [],
      commented: false,
    } : null,
  };
}

/** Keep the old ordinary-supervision population separate from the lifecycle pass. */
export async function prepareSupervisionMissions(db: Db, ownerActions: OwnerActions, input: {
  companyId?: string; missionIds?: string[]; applySafeActions?: boolean;
}) {
  const filters = [inArray(missions.status, input.applySafeActions === true
    ? ["active", "planning", "completed"] : ["active", "planning"])];
  if (input.companyId) filters.push(eq(missions.companyId, input.companyId));
  if (input.missionIds && input.missionIds.length > 0) filters.push(inArray(missions.id, input.missionIds));
  const candidates = await db.select().from(missions).where(and(...filters))
    .orderBy(asc(missions.createdAt), asc(missions.id));
  const missionRows: MissionRow[] = [];
  const terminalResults: MissionOwnerSupervisionResult[] = [];
  const promotedPlanningMissionIds = new Set<string>();
  for (const candidate of candidates) {
    // Earlier candidates can await work while this mission is paused, cancelled or removed.
    const current = input.applySafeActions === true
      ? (await db.select().from(missions).where(and(
        eq(missions.companyId, candidate.companyId), eq(missions.id, candidate.id),
      )))[0] : candidate;
    if (!current || !["active", "planning", "completed"].includes(current.status)) continue;
    const result = input.applySafeActions === true
      ? await reconcileSupervisionMission(db, ownerActions, current)
      : { mission: current, terminal: null };
    if (current.status === "planning" && result.mission.status === "active") promotedPlanningMissionIds.add(current.id);
    if (result.terminal) {
      if (result.terminal.appliedActions.length > 0) terminalResults.push(result.terminal);
    } else if (result.mission.status === "active" || result.mission.status === "planning") missionRows.push(result.mission);
  }
  return { missionRows, terminalResults, promotedPlanningMissionIds };
}
