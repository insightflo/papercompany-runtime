// PRODUCER TEST DOUBLE ONLY. Emits the literal consumer contract, not Python semantics.
// No media, source, comparison, snapshot-hash, evidence or budget verification occurs here.
// Runtime still spawns this process, hydrates actual bytes and independently reads output.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(Array.from({ length: 4 }, (_, i) =>
  [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
const sha256 = raw => createHash("sha256").update(raw).digest("hex");
// Snapshot supplies job scope only; --snapshot-sha256 is deliberately not verified.
const { job } = JSON.parse(readFileSync(args["--snapshot"], "utf8"));
const queue = `shorts/cu-v3/${job.company_id}/${job.workflow_run_id}/${job.job_id}/`;
const manifestRaw = readFileSync(path.join(args["--object-root"], queue, "manifest.json"));
const manifest = JSON.parse(manifestRaw.toString());
const resultRaw = Buffer.from(JSON.stringify({
  schema: "shorts.clips-result.v1", status: "ok", scope: manifest.scope,
  manifest_key: queue + "manifest.json", manifest_sha256: sha256(manifestRaw),
  clips: manifest.clips, credits_total: manifest.credits.total,
  all_expected_clips_present: true, within_budget: true,
}));
writeFileSync(path.join(args["--output-dir"], "clips-result.v1.json"), resultRaw, { mode: 0o600 });
writeFileSync(path.join(args["--output-dir"], "receiver-status.v1.json"), JSON.stringify({
  schema: "shorts.cu-receiver-status.v1", status: "verified", code: null,
  result_sha256: sha256(resultRaw),
}), { mode: 0o600 });
