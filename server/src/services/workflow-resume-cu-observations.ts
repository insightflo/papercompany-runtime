import { timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, workflowCuObservations, type Db } from "@paperclipai/db";
import { z } from "zod";
import { bytes, equal, eventSchema, fail, hash, identifier, integer, parse, scopeOf, sha, time, uuid,
  type CuJob, type CuInputs } from "./workflow-resume-cu-contract.js";
import { loadCuJob } from "./workflow-resume-cu-binding.js";

const principalSchema = z.object({ id: identifier, tokenSha256: hash,
  observationKind: z.enum(["computer_use_observation", "human_attestation"]), grants: z.array(z.object({
    companyId: uuid, jobId: uuid, executionGeneration: integer }).strict()) }).strict();
export type CuPrincipal = z.infer<typeof principalSchema>;
/** Dedicated bearer authentication. There is deliberately no req.actor/session/agent fallback. */
export function authenticateCuObserver(authorization: string | undefined): CuPrincipal {
  let configured: unknown;
  try { configured = JSON.parse(process.env.PAPERCLIP_CU_OBSERVERS_JSON ?? "null"); } catch { fail("cu_observer_unauthorized", 401); }
  const parsed = z.array(principalSchema).max(100).safeParse(configured);
  if (!parsed.success || !/^Bearer [^\s]+$/i.test(authorization ?? "")) fail("cu_observer_unauthorized", 401);
  if (new Set(parsed.data.map(p => p.id)).size !== parsed.data.length
    || new Set(parsed.data.map(p => p.tokenSha256)).size !== parsed.data.length) fail("cu_observer_unauthorized", 401);
  const digest = Buffer.from(sha(Buffer.from(authorization!.slice(7))), "hex");
  let selected: CuPrincipal | undefined;
  for (const principal of parsed.data) if (timingSafeEqual(digest, Buffer.from(principal.tokenSha256, "hex"))) selected = principal;
  return selected ?? fail("cu_observer_unauthorized", 401);
}
export function grantCuObserver(principal: CuPrincipal, job: CuJob) {
  if (principal.observationKind !== "computer_use_observation" || !principal.grants.some(g =>
    g.companyId === job.company_id && g.jobId === job.job_id && g.executionGeneration === job.execution_generation)) fail("cu_observer_forbidden", 403);
}
const comparison = z.object({ source_matches: z.boolean(), download_matches: z.boolean(), reviewed_at: time }).strict();
const provenance = z.object({ frame: integer.min(1), source_object: z.string(), source_sha256: hash, file_sha256: hash,
  card_id: identifier, generation_id: identifier, download_id: identifier, comparison: comparison.optional() }).strict();
const credit = eventSchema.omit({ evidence_record: true }).strict();
const budget = z.object({ complete: z.boolean().optional(), events: z.array(eventSchema) }).strict();
const common = { jobId: uuid, recordId: identifier, observedAt: time, screenshotBase64: z.string().max(12 * 1024 * 1024) };
export const observationSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("provenance"), fields: provenance }).strict(),
  z.object({ ...common, kind: z.literal("credit"), fields: credit }).strict(),
  z.object({ ...common, kind: z.literal("budget"), fields: budget }).strict(),
]);
export type ObservationInput = z.infer<typeof observationSchema>;
export function screenshotBytes(base64: string) {
  const raw = Buffer.from(base64, "base64");
  if (!raw.length || raw.length > 8 * 1024 * 1024 || raw.toString("base64") !== base64) fail("cu_screenshot_invalid");
  const png = raw.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = raw.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  if (!png && !jpeg) fail("cu_screenshot_invalid");
  return raw; // Signature sanity ONLY: no OCR, image-semantic inference, or truth certification.
}
function record(job: CuJob, inputs: CuInputs, principal: CuPrincipal, input: ObservationInput, digest: string) {
  const now = Date.now(), observed = Date.parse(input.observedAt);
  if (observed > now) fail();
  if (input.kind === "provenance") {
    const f = input.fields, comparison = f.comparison;
    if (!inputs.sources.some(s => s.frame === f.frame && s.object === f.source_object && s.sha256 === f.source_sha256)) fail("cu_scope_mismatch");
    if (comparison && (Date.parse(comparison.reviewed_at) < observed || Date.parse(comparison.reviewed_at) > now)) fail();
    return { schema: "shorts.cu-provenance.v1", record_id: input.recordId, scope: scopeOf(job),
      observer_id: principal.id, observed_at: input.observedAt, screenshot_sha256: digest, ...f,
      ...(comparison ? { comparison: { ...comparison, reviewer_id: principal.id } } : {}) };
  }
  if (input.kind === "credit") return { schema: "shorts.cu-credit.v1", record_id: input.recordId, scope: scopeOf(job),
    observer_id: principal.id, observed_at: input.observedAt, screenshot_sha256: digest, ...input.fields };
  return { schema: "shorts.cu-budget.v1", scope: scopeOf(job), observed_at: input.observedAt, ...input.fields };
}
export function validateStoredObservation(job: CuJob, inputs: CuInputs, row: typeof workflowCuObservations.$inferSelect) {
  const digest = sha(screenshotBytes(row.screenshotBase64));
  if (row.jobId !== job.job_id || row.companyId !== job.company_id || row.observationKind !== "computer_use_observation"
    || digest !== row.screenshotSha256) fail("cu_observation_readback_failed", 422);
  const { schema: _schema, scope: _scope, record_id: _id, observer_id: _observer, screenshot_sha256: _screenshot,
    observed_at: observedAt, ...fields } = row.payload;
  if (row.kind === "provenance" && fields.comparison) {
    const { reviewer_id: _reviewer, ...comparison } = fields.comparison as Record<string, unknown>;
    fields.comparison = comparison;
  }
  const input = parse(observationSchema, { jobId: row.jobId, recordId: row.recordId, kind: row.kind,
    observedAt, screenshotBase64: row.screenshotBase64, fields });
  const principal: CuPrincipal = { id: parse(identifier, row.observerId), tokenSha256: "0".repeat(64),
    observationKind: "computer_use_observation", grants: [] };
  if (!equal(record(job, inputs, principal, input, digest), row.payload)) fail("cu_observation_readback_failed", 422);
  return row.payload;
}
export async function writeCuObservation(db: Db, principal: CuPrincipal, scope: { companyId: string; missionId: string }, raw: unknown) {
  const input = parse(observationSchema, raw);
  return db.transaction(async tx => {
    const { row, job } = await loadCuJob(tx, scope.companyId, scope.missionId, input.jobId, true);
    grantCuObserver(principal, job);
    const screenshot = screenshotBytes(input.screenshotBase64), digest = sha(screenshot);
    const payload = record(job, row.inputs as CuInputs, principal, input, digest);
    bytes(payload);
    const [prior] = await tx.select().from(workflowCuObservations).where(and(eq(workflowCuObservations.jobId, job.job_id),
      eq(workflowCuObservations.recordId, input.recordId)));
    if (prior) {
      if (prior.observerId !== principal.id || prior.screenshotBase64 !== input.screenshotBase64 || prior.screenshotSha256 !== digest
        || !equal(prior.payload, payload)) fail("cu_observation_conflict", 409);
      return { id: prior.id, recordId: prior.recordId, revision: prior.revision };
    }
    const [latest] = await tx.select().from(workflowCuObservations).where(eq(workflowCuObservations.jobId, job.job_id))
      .orderBy(desc(workflowCuObservations.revision)).limit(1);
    const [inserted] = await tx.insert(workflowCuObservations).values({ jobId: job.job_id, companyId: job.company_id,
      recordId: input.recordId, kind: input.kind, observerId: principal.id, observationKind: principal.observationKind,
      revision: (latest?.revision ?? 0) + 1, payload, screenshotBase64: input.screenshotBase64, screenshotSha256: digest }).returning();
    const [stored] = await tx.select().from(workflowCuObservations).where(eq(workflowCuObservations.id, inserted.id));
    if (!stored || !equal(stored.payload, payload) || sha(screenshotBytes(stored.screenshotBase64)) !== stored.screenshotSha256
      || stored.observerId !== principal.id) fail("cu_observation_readback_failed", 422);
    await tx.insert(activityLog).values({ companyId: job.company_id, actorType: "system", actorId: principal.id,
      action: "workflow.cu_observation_written", entityType: "workflow_cu_observation", entityId: stored.id,
      details: { jobId: job.job_id, kind: input.kind, revision: stored.revision } });
    return { id: stored.id, recordId: stored.recordId, revision: stored.revision };
  });
}
