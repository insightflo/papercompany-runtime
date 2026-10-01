import { and, desc, eq } from "drizzle-orm";
import { missions, workflowRuns, type Db } from "@paperclipai/db";
import type { MissionRevisionSource, MissionRevisionSourceInput } from "@paperclipai/shared/types/mission-revision";
import { missionRevisionSourceSchema } from "@paperclipai/shared/validators/mission-revision";
import { badRequest } from "../../errors.js";

/** Validate before the first write; pin an omitted run to a deterministic latest source run. */
export async function resolveMissionRevisionSource(db: Pick<Db, "select">,
  companyId: string, input: MissionRevisionSourceInput): Promise<MissionRevisionSource> {
  const parsed = missionRevisionSourceSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map(issue => issue.message).join("; "));
  const { sourceMissionId, sourceWorkflowRunId } = parsed.data;
  if (!sourceMissionId) return { sourceMissionId: null, sourceWorkflowRunId: null };
  const [source] = await db.select({ id: missions.id }).from(missions)
    .where(and(eq(missions.id, sourceMissionId), eq(missions.companyId, companyId))).limit(1);
  if (!source) throw badRequest("Invalid source mission: expected a mission in this company");
  const [run] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, sourceMissionId),
    ...(sourceWorkflowRunId ? [eq(workflowRuns.id, sourceWorkflowRunId)] : []),
  )).orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id)).limit(1);
  if (sourceWorkflowRunId && !run) throw badRequest("Invalid source workflow run: expected a run of the source mission in this company");
  return { sourceMissionId, sourceWorkflowRunId: run?.id ?? null };
}
