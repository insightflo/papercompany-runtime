import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { HttpError } from "../errors.js";

export const JSON_CAP = 4 * 1024 * 1024, OBJECT_CAP = 256 * 1024 * 1024, AGGREGATE_CAP = 1024 * 1024 * 1024;
export function fail(code = "cu_evidence_invalid", status = 400): never { throw new HttpError(status, code); }
export const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
export const equal = isDeepStrictEqual;
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const integer = z.number().int().safe().nonnegative();
export const time = z.string().datetime({ offset: true });
export const objectKey = z.string().min(1).max(2048).refine(key => !/[\\%?#\x00-\x1f\x7f]/.test(key)
  && key.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."));
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); return result.success ? result.data : fail();
}
export const scopeSchema = z.object({ job_id: uuid, company_id: uuid, mission_id: uuid, workflow_run_id: uuid,
  step_run_id: uuid, step_id: identifier, issue_id: uuid, execution_generation: integer, attempt: integer.min(1), spec_sha256: hash }).strict();
export const jobSchema = scopeSchema.extend({ schema: z.literal("shorts.flow-runner-job.v3"),
  max_attempts: integer.min(1), type: z.literal("flow_clips_computer_use"), mode: z.enum(["generate", "reuse"]),
  worker_host_id: identifier, clips_spec_object: objectKey, expires_at: time,
  budget: z.object({ max_clips: integer.min(1), max_credits_total: integer }).strict(), report: z.object({ issue_id: uuid }).strict(),
}).strict().refine(j => j.attempt <= j.max_attempts && j.report.issue_id === j.issue_id
  && j.clips_spec_object.startsWith(`shorts/runs/${j.workflow_run_id}/`));
export type CuJob = z.infer<typeof jobSchema>;
export const scopeOf = (job: CuJob) => scopeSchema.parse(Object.fromEntries(Object.keys(scopeSchema.shape).map(k => [k, job[k as keyof CuJob]])));
export const queueRoot = (job: CuJob) => `shorts/cu-v3/${job.company_id}/${job.workflow_run_id}/${job.job_id}/`;
export function originalKey(job: CuJob, key: string) {
  parse(objectKey, key); if (!key.startsWith(`shorts/runs/${job.workflow_run_id}/`)) fail(); return key;
}
const reference = z.object({ object: objectKey, sha256: hash }).strict();
export const inputsSchema = z.object({ schema: z.literal("shorts.cu-inputs.v1"), scope: scopeSchema,
  spec: reference, plan: reference, sources: z.array(reference.extend({ frame: integer.min(1) }).strict()).min(1) }).strict();
export type CuInputs = z.infer<typeof inputsSchema>;
export const eventSchema = z.object({ event_id: identifier, amount: integer, evidence_record: identifier,
  generation_id: identifier, card_id: identifier, origin: z.enum(["historical", "current"]) }).strict();
export const clipSchema = z.object({ frame: integer.min(1), object: objectKey, source_object: objectKey, source_sha256: hash,
  file_sha256: hash, provenance_record: identifier, card_id: identifier, generation_id: identifier, download_id: identifier,
  duration_sec: z.number().finite().positive(), required_sec: z.number().finite().positive(), width: integer.min(1),
  height: integer.min(1), bytes: integer.min(1).max(OBJECT_CAP) }).strict();
export const creditsSchema = z.object({ historical: integer, total_new: integer, total: integer, events: z.array(eventSchema) }).strict();
export const manifestSchema = z.object({ schema: z.literal("shorts.cu-manifest.v1"), scope: scopeSchema, claim_id: uuid,
  inputs: inputsSchema, clips: z.array(clipSchema).min(1), credits: creditsSchema }).strict();
export type CuManifest = z.infer<typeof manifestSchema>;

/** Bounded strict UTF-8 JSON; reject duplicate keys before JSON.parse can discard identity. */
export function decode(raw: Buffer): unknown {
  if (raw.length > JSON_CAP) fail("cu_evidence_limit", 422);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return fail(); }
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  const string = (): string => {
    const start = i++; while (i < text.length) { if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)); }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 80) fail(); whitespace();
    if (text[i] === '"') { string(); return; }
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i++] === "{", end = object ? "}" : "]", seen = new Set<string>();
      whitespace(); if (text[i] === end) { i++; return; }
      for (;;) {
        whitespace(); if (object) { if (text[i] !== '"') fail(); const key = string();
          if (seen.has(key)) fail(); seen.add(key); whitespace(); if (text[i++] !== ":") fail(); }
        value(depth + 1); whitespace(); if (text[i] === end) { i++; return; }
        if (text[i++] !== ",") fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!token) fail(); i += token[0].length;
    if (/^-?\d/.test(token[0]) && !Number.isFinite(Number(token[0]))) fail();
  };
  try { value(0); whitespace(); if (i !== text.length) fail(); return JSON.parse(text); } catch { return fail(); }
}
export function bytes(value: unknown): Buffer {
  const raw = Buffer.from(JSON.stringify(value)); if (raw.length > JSON_CAP) fail("cu_evidence_limit", 422); return raw;
}
