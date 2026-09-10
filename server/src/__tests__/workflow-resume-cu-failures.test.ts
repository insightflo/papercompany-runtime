// Ordinary-CI shorts CU evidence failures (production 아님). CI proves the CONSUMER contract only:
// durable DB/FS/readback rejections driven by the checked-in producer TEST DOUBLE (receiver.mjs)
// plus explicitly configured Node wrappers. Real producer semantics — a real receiver never
// inventing success and snapshot-mutation refusal — are proven solely by the opt-in external
// suite (tests/external/shorts-receivers.external.ts via pnpm test:shorts-external).
import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindCuJob } from "../services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../services/workflow-resume-cu-objects.js";
import { cuDatabase, cuCase, cuApp, configureCu, boardMembership, encode, digest, type CuCase } from "./workflow-resume-cu-fixture.js";

// Checked-in producer test double; ordinary CI never requires Python, ffmpeg or a sibling checkout.
const RECEIVER_FIXTURE = fileURLToPath(new URL("./fixtures/shorts-ci/receiver.mjs", import.meta.url));

let fixture: Awaited<ReturnType<typeof cuDatabase>>;
beforeAll(async () => { fixture = await cuDatabase(); }, 120_000);
afterAll(async () => { await fixture?.cleanup(); });
async function connected(change: (c: CuCase) => Promise<void>) {
  const c = await cuCase(fixture);
  try {
    configureCu(c); await boardMembership(fixture, c);
    await bindCuJob(fixture.db, { job: c.job, planObject: c.planObject },
      { readObject: createCuObjectReader(fixture.db), creatorId: "controller" });
    await change(c);
  } finally { await c.cleanup(); }
}
async function admit(c: CuCase) {
  const app = cuApp(fixture, c);
  for (const observation of c.observations) {
    expect((await request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(observation)).status).toBe(201);
  }
  return request(app).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100").send(c.intake);
}
async function expectNonSuccess(c: CuCase, reply: Awaited<ReturnType<typeof admit>>, invoked = true) {
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  expect(reply.body.state).toBe("blocked"); expect(reply.body.result).toBeNull(); expect(reply.body.resultSha256).toBeNull();
  const [row] = await fixture.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${reply.body.id}`;
  expect(row.cu_result_base64).toBeNull(); expect(row.artifact_id).toBeNull(); expect(row.verified_at).toBeNull();
  if (invoked) expect(JSON.parse(await readFile(`${c.evidence}/${row.id}/result/receiver-status.v1.json`, "utf8"))).toHaveProperty("schema", "shorts.cu-receiver-status.v1");
  return row;
}

// Explicitly configured PRODUCER-REJECTION test double (clearly flagged, intentionally small):
// a CONSTANT rejection mode — parses only the output directory and unconditionally persists a
// literal non-verified status with nonzero exit, never a result, with no conditional fallback.
// It deliberately does NOT verify missing/false snapshot semantics; the real receiver's refusal
// logic is proven solely by the external suite.
const REJECTION_RECEIVER = `// PRODUCER-REJECTION TEST DOUBLE — ordinary CI only, not the real receiver.
import { writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(path.join(arg("--output-dir"), "receiver-status.v1.json"), JSON.stringify({
  schema: "shorts.cu-receiver-status.v1", status: "needs_submission", code: "needs_submission" }), { mode: 0o600 });
process.exit(2);
`;

// Fault wrappers invoke the checked-in fixture double, then deliberately corrupt its LITERAL
// output files — proving the runtime judges durable bytes, never exit status or stdout.
const FAULT_MUTATIONS: Record<string, string> = {
  nonzero: "process.exit(7);",
  missing: "await unlink(result);",
  malformed: 'await writeFile(result, "{}");',
  "wrong-scope": `const raw = await readFile(result);
  const value = JSON.parse(raw.toString()); value.scope.step_id = "foreign";
  const mutated = Buffer.from(JSON.stringify(value)); await writeFile(result, mutated);
  const statusValue = JSON.parse((await readFile(status)).toString());
  statusValue.result_sha256 = sha256(mutated); await writeFile(status, JSON.stringify(statusValue));`,
  "mutated-bytes": "const raw = await readFile(result); await writeFile(result, Buffer.concat([raw, Buffer.from(' ')]));",
  "wrong-hash": `const statusValue = JSON.parse((await readFile(status)).toString());
  statusValue.result_sha256 = "0".repeat(64); await writeFile(status, JSON.stringify(statusValue));`,
  "affirmative-stdout": `await unlink(result);
  console.log('{"status":"verified","all_expected_clips_present":true}');`,
};
function faultReceiver(kind: string): string {
  return `// Fixture-invoking fault wrapper (ordinary CI): runs the checked-in producer test double,
// then corrupts its output files on purpose (${kind}); stdout/exit are never authority.
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const child = spawn(process.execPath, [${JSON.stringify(RECEIVER_FIXTURE)}, ...argv], { stdio: "inherit" });
if (await new Promise((resolve) => child.once("close", resolve)) !== 0) process.exit(1);
const out = arg("--output-dir");
const result = path.join(out, "clips-result.v1.json");
const status = path.join(out, "receiver-status.v1.json");
const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
${FAULT_MUTATIONS[kind]}
`;
}

test.each(["missing-comparison", "false-comparison", "missing-budget", "incomplete-budget", "missing-complete", "missing-credit"])("configured producer rejection is persisted (does NOT verify missing/false semantics — external suite does): %s", async kind => {
  await connected(async c => {
    const observations = c.observations as any[];
    if (kind === "missing-comparison") delete observations[0].fields.comparison;
    if (kind === "false-comparison") observations[0].fields.comparison.source_matches = false;
    if (kind === "missing-budget") observations.splice(2, 1);
    if (kind === "incomplete-budget") observations[2].fields.complete = false;
    if (kind === "missing-complete") delete observations[2].fields.complete;
    if (kind === "missing-credit") observations.splice(1, 1);
    const wrapper = path.join(c.root, "rejection-receiver.mjs");
    await writeFile(wrapper, REJECTION_RECEIVER);
    // Fixed trusted test configuration via explicit fixture-double arguments, never env-switched.
    configureCu(c, { executable: process.execPath, script: wrapper });
    const row = await expectNonSuccess(c, await admit(c));
    // Deficient observations stay retained verbatim in the frozen snapshot (audit boundary).
    const snapshot = JSON.parse(Buffer.from(row.cu_snapshot_base64, "base64").toString());
    if (kind === "missing-comparison") expect(snapshot.records[0]).not.toHaveProperty("comparison");
    if (kind === "false-comparison") expect(snapshot.records[0].comparison.source_matches).toBe(false);
    if (kind === "missing-budget") expect(snapshot.budget).toBeNull();
    if (kind === "incomplete-budget") expect(snapshot.budget.complete).toBe(false);
    if (kind === "missing-complete") expect(snapshot.budget).not.toHaveProperty("complete");
    if (kind === "missing-credit") expect(snapshot.records.some((record: any) => record.schema === "shorts.cu-credit.v1")).toBe(false);
  });
});
test.each(["source", "spec", "media", "manifest", "terminal-scope", "terminal-uri", "claim-scope", "manifest-unknown", "manifest-clips-cap"])("hydration validates actual bytes and exact versioned references: %s", async kind => {
  await connected(async c => {
    if (kind === "source") await c.put(c.inputs.sources[0].object, Buffer.from("mutated source"));
    if (kind === "spec") await c.put(c.specObject, Buffer.from("{}"));
    if (kind === "media") await c.put(c.clip.object, Buffer.from("mutated media"));
    if (kind === "manifest") await c.put(c.intake.manifestObject, Buffer.from("{}"));
    if (kind.startsWith("terminal")) {
      const terminal = JSON.parse(await readFile(path.join(c.objects, c.queue, "result.json"), "utf8"));
      if (kind === "terminal-scope") terminal.scope.execution_generation++;
      else terminal.manifest_key = "https://attacker.invalid/manifest.json";
      await c.put(c.queue + "result.json", encode(terminal));
    }
    if (kind === "claim-scope") {
      const claim = JSON.parse(await readFile(path.join(c.objects, c.queue, "claim.json"), "utf8"));
      claim.scope.issue_id = randomUUID(); await c.put(c.queue + "claim.json", encode(claim));
    }
    if (kind === "manifest-unknown" || kind === "manifest-clips-cap") {
      if (kind === "manifest-unknown") (c.manifest as any).trusted_records = [];
      else c.manifest.clips.push({ ...c.clip, frame: 2 });
      const raw = encode(c.manifest); c.intake.manifestSha256 = digest(raw); await c.put(c.intake.manifestObject, raw);
      const terminal = JSON.parse(await readFile(path.join(c.objects, c.queue, "result.json"), "utf8"));
      terminal.manifest_sha256 = digest(raw); await c.put(c.queue + "result.json", encode(terminal));
    }
    await expectNonSuccess(c, await admit(c), false);
  });
});
test.each(["nonzero", "missing", "malformed", "wrong-scope", "mutated-bytes", "wrong-hash", "affirmative-stdout"])("known-path independent readback rejects corrupted fixture output: %s", async kind => {
  await connected(async c => {
    const wrapper = path.join(c.root, "fault-receiver.mjs");
    await writeFile(wrapper, faultReceiver(kind));
    configureCu(c, { executable: process.execPath, script: wrapper });
    await expectNonSuccess(c, await admit(c));
  });
});
test("absent configured executable/root is a fixed 503, not defaults", async () => {
  await connected(async c => {
    for (const key of ["PAPERCLIP_CU_RECEIVER_PYTHON", "PAPERCLIP_CU_RECEIVER_SCRIPT", "PAPERCLIP_CU_EVIDENCE_ROOT"]) {
      const prior = process.env[key]; delete process.env[key];
      const reply = await request(cuApp(fixture, c)).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100").send(c.intake);
      expect(reply.status).toBe(503); expect(reply.body).toEqual({ error: "cu_evidence_unavailable" }); process.env[key] = prior;
    }
    expect((await fixture.sql`SELECT count(*)::int AS n FROM workflow_late_evidence_submissions WHERE cu_job_id=${c.job.job_id}`)[0].n).toBe(0);
  });
});
