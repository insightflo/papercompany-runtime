import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { clipSchema, decode, equal, fail, hash, integer, JSON_CAP, parse, scopeOf, scopeSchema, sha,
  type CuJob, type CuManifest } from "./workflow-resume-cu-contract.js";
import { readRegular } from "./workflow-resume-cu-files.js";

export function receiverConfiguration() {
  const python = process.env.PAPERCLIP_CU_RECEIVER_PYTHON, script = process.env.PAPERCLIP_CU_RECEIVER_SCRIPT,
    root = process.env.PAPERCLIP_CU_EVIDENCE_ROOT;
  if (!python || !script || !root || ![python, script, root].every(p => path.isAbsolute(p))) fail("cu_evidence_unavailable", 503);
  return { python, script, root };
}
export type ReceiverConfiguration = ReturnType<typeof receiverConfiguration>;
/** No shell, caller arguments, clock override, stdout parsing, or inherited provider credentials. */
export function runCuReceiver(config: ReceiverConfiguration, directory: string, snapshotSha256: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [config.script, "--snapshot", path.join(directory, "snapshot.json"),
      "--snapshot-sha256", snapshotSha256, "--object-root", path.join(directory, "object-cache"),
      "--output-dir", path.join(directory, "result")], { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", LANG: "C.UTF-8" } });
    let size = 0, failed = false;
    const kill = () => {
      failed = true;
      // Kill only this invocation's process group, including receiver-owned ffmpeg children.
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(kill, 120_000);
    const diagnostic = (raw: Buffer) => { size += raw.length; if (size > 1024 * 1024) kill(); };
    child.stdout.on("data", diagnostic); child.stderr.on("data", diagnostic);
    child.once("error", () => { clearTimeout(timer); reject(new Error("cu_receiver_failed")); });
    child.once("close", code => { clearTimeout(timer); resolve(failed ? -1 : code ?? -1); });
  });
}
const resultSchema = z.object({ schema: z.literal("shorts.clips-result.v1"), status: z.literal("ok"),
  all_expected_clips_present: z.literal(true), within_budget: z.literal(true), scope: scopeSchema,
  manifest_key: z.string(), manifest_sha256: hash, clips: z.array(clipSchema).min(1), credits_total: integer }).strict();
const statusSchema = z.object({ schema: z.literal("shorts.cu-receiver-status.v1"), status: z.literal("verified"),
  code: z.null(), result_sha256: hash }).strict();

/** Always read the fixed durable result; a successful exit/status/stdout cannot substitute for bytes. */
export async function readCuResult(directory: string, exit: number, job: CuJob, manifest: CuManifest,
  pinned: { manifestObject: string; manifestSha256: string }) {
  if (exit !== 0) fail("cu_receiver_failed", 422);
  const raw = await readRegular(path.join(directory, "result", "clips-result.v1.json"), JSON_CAP);
  const result = parse(resultSchema, decode(raw));
  if (!equal(result.scope, scopeOf(job)) || result.manifest_key !== pinned.manifestObject || result.manifest_sha256 !== pinned.manifestSha256
    || !equal(result.clips, manifest.clips) || result.credits_total !== manifest.credits.total
    || result.clips.length > job.budget.max_clips || result.credits_total > job.budget.max_credits_total) fail("cu_result_mismatch", 422);
  const status = parse(statusSchema, decode(await readRegular(path.join(directory, "result", "receiver-status.v1.json"), 4096)));
  if (status.result_sha256 !== sha(raw)) fail("cu_result_mismatch", 422);
  return { raw, digest: sha(raw), result };
}
export function decodeStoredCuResult(base64: string, digest: string) {
  const raw = Buffer.from(base64, "base64");
  if (raw.toString("base64") !== base64 || sha(raw) !== digest) fail("cu_result_mismatch", 422);
  return parse(resultSchema, decode(raw));
}
