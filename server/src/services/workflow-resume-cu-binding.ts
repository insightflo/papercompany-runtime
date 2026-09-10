import { and, eq } from "drizzle-orm";
import { activityLog, issues, missions, workflowCuJobs, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { bytes, decode, equal, fail, identifier, integer, jobSchema, originalKey, parse, scopeOf, sha,
  AGGREGATE_CAP, JSON_CAP, OBJECT_CAP, type CuJob, type CuInputs } from "./workflow-resume-cu-contract.js";
import type { CuObjectReader } from "./workflow-resume-cu-objects.js";
export type CuTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CuDb = Db | CuTx;
export type BoundJob = typeof workflowCuJobs.$inferSelect;

export async function checkCuScope(db: CuDb, job: CuJob, lock = false) {
  const query = db.select({ step: workflowStepRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .innerJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .innerJoin(missions, eq(missions.id, workflowRuns.missionId))
    .where(and(eq(workflowStepRuns.id, job.step_run_id), eq(workflowRuns.id, job.workflow_run_id),
      eq(workflowRuns.companyId, job.company_id), eq(workflowRuns.missionId, job.mission_id),
      eq(missions.companyId, job.company_id), eq(issues.companyId, job.company_id),
      eq(issues.missionId, job.mission_id), eq(issues.id, job.issue_id), eq(workflowStepRuns.stepId, job.step_id),
      eq(workflowStepRuns.executionGeneration, job.execution_generation)));
  const rows = lock ? await query.for("share") : await query;
  if (rows.length !== 1) fail("cu_scope_mismatch", 404);
}
export async function loadCuJob(db: CuDb, companyId: string, missionId: string, jobId: string, lock = false) {
  const query = db.select().from(workflowCuJobs).where(and(eq(workflowCuJobs.id, jobId),
    eq(workflowCuJobs.companyId, companyId), eq(workflowCuJobs.missionId, missionId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) fail("cu_job_not_found", 404);
  const job = parse(jobSchema, row.job);
  if (job.job_id !== row.id || job.company_id !== row.companyId || job.mission_id !== row.missionId
    || job.workflow_run_id !== row.workflowRunId || job.step_run_id !== row.stepRunId || job.step_id !== row.stepId
    || job.issue_id !== row.issueId || job.execution_generation !== row.executionGeneration || job.spec_sha256 !== row.specSha256) fail();
  await checkCuScope(db, job, lock);
  return { row, job };
}
const specSchema = z.object({ schema: z.literal("shorts.flow-clip-spec.v1"), run_id: z.string(),
  clips: z.array(z.object({ frame_no: integer.min(1), image_object: z.string(), motion: z.string().min(1), out: z.string() }).passthrough()).min(1) }).passthrough();
const planSchema = z.object({ schema: z.literal("shorts.keyframe-plan.v1"), keyframes: z.array(z.object({
  frame_no: integer.min(1) }).passthrough()) }).passthrough();

/** Explicit INTERNAL controller entrypoint. Never call with an incoming late manifest/job body.
 * Creator identity and reader are trusted controller dependencies, not request fields.
 * Original bytes (not uploader hashes) are fetched before the immutable binding is inserted.
 * Historical jobs remain usable: the Python receiver validates expiry at terminal finished_at.
 */
export async function bindCuJob(db: Db, input: { job: unknown; planObject: string },
  deps: { readObject: CuObjectReader; creatorId: string }) {
  const job = parse(jobSchema, input.job), creatorId = parse(identifier, deps.creatorId);
  await checkCuScope(db, job);
  originalKey(job, input.planObject);
  let total = 0;
  const get = async (key: string, cap: number) => {
    originalKey(job, key);
    const raw = await deps.readObject(job.company_id, key, cap);
    total += raw.length; if (raw.length > cap || total > AGGREGATE_CAP) fail("cu_evidence_limit", 422);
    return raw;
  };
  const specRaw = await get(job.clips_spec_object, JSON_CAP);
  if (sha(specRaw) !== job.spec_sha256) fail("cu_spec_mismatch", 422);
  const spec = parse(specSchema, decode(specRaw));
  if (spec.run_id !== job.workflow_run_id || spec.clips.length > job.budget.max_clips
    || new Set(spec.clips.map(c => c.frame_no)).size !== spec.clips.length) fail();
  for (const clip of spec.clips) {
    originalKey(job, clip.image_object);
    if (clip.out !== `clip-${String(clip.frame_no).padStart(3, "0")}.mp4`) fail();
  }
  const planRaw = await get(input.planObject, JSON_CAP), plan = parse(planSchema, decode(planRaw));
  if (new Set(plan.keyframes.map(f => f.frame_no)).size !== plan.keyframes.length) fail();
  const sources: CuInputs["sources"] = [];
  for (const clip of spec.clips) {
    const raw = await get(clip.image_object, OBJECT_CAP);
    if (!raw.length) fail();
    sources.push({ frame: clip.frame_no, object: clip.image_object, sha256: sha(raw) });
  }
  const inputs: CuInputs = { schema: "shorts.cu-inputs.v1", scope: scopeOf(job),
    spec: { object: job.clips_spec_object, sha256: sha(specRaw) },
    plan: { object: input.planObject, sha256: sha(planRaw) }, sources };
  bytes({ job, inputs });
  return db.transaction(async tx => {
    await checkCuScope(tx, job, true);
    const inserted = await tx.insert(workflowCuJobs).values({ id: job.job_id, companyId: job.company_id,
      missionId: job.mission_id, workflowRunId: job.workflow_run_id, stepRunId: job.step_run_id, stepId: job.step_id,
      issueId: job.issue_id, executionGeneration: job.execution_generation, specSha256: job.spec_sha256,
      job, inputs, creatorId }).onConflictDoNothing().returning();
    const [row] = await tx.select().from(workflowCuJobs).where(eq(workflowCuJobs.id, job.job_id));
    if (!row || !equal(row.job, job) || !equal(row.inputs, inputs) || row.creatorId !== creatorId) fail("cu_job_conflict", 409);
    if (inserted.length) await tx.insert(activityLog).values({ companyId: job.company_id, actorType: "system", actorId: creatorId,
      action: "workflow.cu_job_bound", entityType: "workflow_cu_job", entityId: job.job_id, details: { stepRunId: job.step_run_id } });
    return row;
  });
}
