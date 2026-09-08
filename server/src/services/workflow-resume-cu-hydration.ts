import path from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { z } from "zod";
import { decode, equal, fail, hash, identifier, inputsSchema, manifestSchema, parse, queueRoot, scopeOf, scopeSchema, sha,
  time, uuid, AGGREGATE_CAP, JSON_CAP, OBJECT_CAP, type CuJob, type CuManifest } from "./workflow-resume-cu-contract.js";
import { writePrivate } from "./workflow-resume-cu-files.js";
import type { CuObjectReader } from "./workflow-resume-cu-objects.js";

const terminalSchema = z.object({ schema: z.literal("shorts.flow-runner-result.v3"), scope: scopeSchema, claim_id: uuid,
  status: z.literal("ok"), manifest_key: z.string(), manifest_sha256: hash, finished_at: time, code: z.literal("ok") }).strict();
const claimSchema = z.object({ schema: z.literal("shorts.cu-claim.v1"), scope: scopeSchema, claim_id: uuid,
  owner_id: identifier, host_id: identifier, expires_at: time }).strict();

/** Remote references are downloader inputs, NEVER provenance. Fixed queue names; no terminal URI following. */
export async function hydrateCuCache(job: CuJob, rawInputs: unknown, pinned: { manifestObject: string; manifestSha256: string },
  cache: string, readObject: CuObjectReader): Promise<CuManifest> {
  const inputs = parse(inputsSchema, rawInputs), scope = scopeOf(job), root = queueRoot(job);
  if (!equal(inputs.scope, scope) || inputs.spec.object !== job.clips_spec_object || inputs.spec.sha256 !== job.spec_sha256
    || pinned.manifestObject !== root + "manifest.json") fail();
  const originals = [inputs.spec, inputs.plan, ...inputs.sources];
  const allowed = new Set([root + "result.json", root + "claim.json", root + "manifest.json", ...originals.map(r => r.object)]);
  let aggregate = 0;
  const mirrored = new Map<string, Buffer>();
  const get = async (key: string, cap: number, expected?: string) => {
    if (!allowed.has(key)) fail();
    let raw = mirrored.get(key);
    if (!raw) {
      raw = await readObject(job.company_id, key, cap);
      aggregate += raw.length;
      if (raw.length > cap || aggregate > AGGREGATE_CAP) fail("cu_evidence_limit", 422);
      if (expected && sha(raw) !== expected) fail("cu_object_mismatch", 422);
      const destination = path.join(cache, key);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writePrivate(destination, raw); await chmod(destination, 0o400);
      mirrored.set(key, raw);
    }
    if (raw.length > cap) fail("cu_evidence_limit", 422);
    if (expected && sha(raw) !== expected) fail("cu_object_mismatch", 422);
    return raw;
  };
  const terminal = parse(terminalSchema, decode(await get(root + "result.json", JSON_CAP)));
  if (!equal(terminal.scope, scope) || terminal.manifest_key !== pinned.manifestObject
    || terminal.manifest_sha256 !== pinned.manifestSha256) fail("cu_terminal_mismatch", 422);
  const claim = parse(claimSchema, decode(await get(root + "claim.json", JSON_CAP)));
  if (!equal(claim.scope, scope) || claim.claim_id !== terminal.claim_id || claim.host_id !== job.worker_host_id) fail();
  const manifest = parse(manifestSchema, decode(await get(pinned.manifestObject, JSON_CAP, pinned.manifestSha256)));
  if (!equal(manifest.scope, scope) || !equal(manifest.inputs, inputs) || manifest.claim_id !== claim.claim_id
    || manifest.clips.length > job.budget.max_clips || new Set(manifest.clips.map(c => c.frame)).size !== manifest.clips.length
    || new Set(manifest.credits.events.map(e => e.event_id)).size !== manifest.credits.events.length) fail();
  for (const ref of originals) {
    if (!ref.object.startsWith(`shorts/runs/${job.workflow_run_id}/`)) fail();
    await get(ref.object, ref === inputs.spec || ref === inputs.plan ? JSON_CAP : OBJECT_CAP, ref.sha256);
  }
  for (const clip of manifest.clips) {
    const key = root + `clips/${clip.file_sha256}.mp4`;
    if (clip.object !== key || !inputs.sources.some(s => s.frame === clip.frame && s.object === clip.source_object && s.sha256 === clip.source_sha256)) fail();
    allowed.add(key);
    const raw = await get(key, OBJECT_CAP, clip.file_sha256);
    if (raw.length !== clip.bytes) fail("cu_object_mismatch", 422);
  }
  return manifest;
}
