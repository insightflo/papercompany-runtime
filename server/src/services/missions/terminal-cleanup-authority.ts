import { and, eq, inArray } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MissionSnapshot = Pick<typeof missions.$inferSelect, "status" | "updatedAt">;

/** Exact scoped epoch, including terminal runs and the empty run set. */
export interface MissionTerminalAuthority {
  companyId: string;
  missionId: string;
  missionStatus: string;
  missionUpdatedAt: Date;
  runs: Array<{ id: string; dispatchAuthorityVersion: number }>;
}

function runScope(companyId: string, missionId: string) {
  return and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId));
}

/** Capture before any status write. update() supplies its original mission read, not a later one. */
export async function captureMissionTerminalAuthority(
  db: Db,
  companyId: string,
  missionId: string,
  missionSnapshot?: MissionSnapshot,
): Promise<MissionTerminalAuthority> {
  const mission = missionSnapshot ?? (await db.select().from(missions)
    .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId))).limit(1))[0];
  if (!mission) throw notFound(`Mission not found: ${missionId}`);
  const runs = await db.select({ id: workflowRuns.id, dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
    .from(workflowRuns).where(runScope(companyId, missionId)).orderBy(workflowRuns.id);
  return { companyId, missionId, missionStatus: mission.status, missionUpdatedAt: mission.updatedAt, runs };
}

/**
 * Same mission -> run -> steps lock order as resume apply. Lock ALL runs (ordered by id),
 * then their steps (ordered by run/id), even when the observed epoch will be rejected.
 * Request/execution history is not a veto: a fresh explicit terminal action remains valid.
 */
export async function lockAndCheckMissionTerminalAuthority(
  tx: Transaction,
  companyId: string,
  missionId: string,
  captured: MissionTerminalAuthority,
): Promise<boolean> {
  const [mission] = await tx.select().from(missions)
    .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId))).for("update");
  const runs = await tx.select({ id: workflowRuns.id, dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
    .from(workflowRuns).where(runScope(companyId, missionId)).orderBy(workflowRuns.id).for("update");
  if (runs.length) {
    await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .where(inArray(workflowStepRuns.workflowRunId, runs.map((run) => run.id)))
      .orderBy(workflowStepRuns.workflowRunId, workflowStepRuns.id).for("update");
  }
  return captured.companyId === companyId && captured.missionId === missionId
    && mission !== undefined
    && mission.status === captured.missionStatus
    && mission.updatedAt.getTime() === captured.missionUpdatedAt.getTime()
    && runs.length === captured.runs.length
    && runs.every((run, index) => run.id === captured.runs[index].id
      && run.dispatchAuthorityVersion === captured.runs[index].dispatchAuthorityVersion);
}
