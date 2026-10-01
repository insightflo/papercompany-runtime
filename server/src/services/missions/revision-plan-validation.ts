import { and, eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { checkMissionRevisionSteps } from "./mission-revision-guard.js";
import { buildWorkflowExecutionSteps } from "../workflow/execution-steps.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";

export async function loadMissionRow(db: Db, companyId: string, missionId: string) {
  const [row] = await db.select().from(missions).where(and(eq(missions.companyId, companyId), eq(missions.id, missionId))).limit(1);
  return row ?? null;
}
export async function revisionPlanDiagnostics(db: Db, companyId: string, missionId: string,
  units: Record<string, unknown>[], build: (mission: typeof missions.$inferSelect) => WorkflowStep[]) {
  const mission = await loadMissionRow(db, companyId, missionId);
  if (!mission?.sourceWorkflowRunId) return [];
  try {
    await checkMissionRevisionSteps(db, { companyId, missionId, units,
      steps: buildWorkflowExecutionSteps({ name: mission.title, stepsJson: build(mission) }) });
    return [];
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return [{ code: e.message, message: e.message, severity: "invalid" as const, details: e.details }];
  }
}
