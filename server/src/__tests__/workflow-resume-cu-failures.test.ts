import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindCuJob } from "../services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../services/workflow-resume-cu-objects.js";
import { cuDatabase, cuCase, cuApp, configureCu, boardMembership, encode, digest, type CuCase } from "./workflow-resume-cu-fixture.js";

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
test.each(["missing-comparison", "false-comparison", "missing-budget", "incomplete-budget", "missing-complete", "missing-credit"])("real receiver never invents success: %s", async kind => {
  await connected(async c => {
    const observations = c.observations as any[];
    if (kind === "missing-comparison") delete observations[0].fields.comparison;
    if (kind === "false-comparison") observations[0].fields.comparison.source_matches = false;
    if (kind === "missing-budget") observations.splice(2, 1);
    if (kind === "incomplete-budget") observations[2].fields.complete = false;
    if (kind === "missing-complete") delete observations[2].fields.complete;
    if (kind === "missing-credit") observations.splice(1, 1);
    const row = await expectNonSuccess(c, await admit(c));
    const snapshot = JSON.parse(Buffer.from(row.cu_snapshot_base64, "base64").toString());
    if (kind === "missing-comparison") expect(snapshot.records[0]).not.toHaveProperty("comparison");
    if (kind === "false-comparison") expect(snapshot.records[0].comparison.source_matches).toBe(false);
    if (kind === "missing-budget") expect(snapshot.budget).toBeNull();
    if (kind === "incomplete-budget") expect(snapshot.budget.complete).toBe(false);
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
test.each(["nonzero", "missing", "malformed", "wrong-scope", "mutated-bytes", "wrong-hash", "affirmative-stdout", "snapshot-mutation"])("known-path independent readback rejects receiver/byte failure: %s", async kind => {
  await connected(async c => {
    const originalScript = process.env.PAPERCLIP_CU_RECEIVER_SCRIPT!;
    const wrapper = path.join(c.root, "fault-receiver.py");
    const mutations: Record<string, string> = {
      nonzero: "sys.exit(7)", missing: "result.unlink()", malformed: "result.write_text('{}')",
      "wrong-scope": "value=json.loads(result.read_bytes()); value['scope']['step_id']='foreign'; result.write_text(json.dumps(value)); status_value=json.loads(status.read_bytes()); status_value['result_sha256']=hashlib.sha256(result.read_bytes()).hexdigest(); status.write_text(json.dumps(status_value))",
      "mutated-bytes": "result.write_bytes(result.read_bytes()+b' ')",
      "wrong-hash": "value=json.loads(status.read_bytes()); value['result_sha256']='0'*64; status.write_text(json.dumps(value))",
      "affirmative-stdout": "result.unlink(); print('{\"status\":\"verified\",\"all_expected_clips_present\":true}')",
    };
    const before = kind === "snapshot-mutation" ? "snapshot=pathlib.Path(sys.argv[sys.argv.index('--snapshot')+1]); snapshot.write_bytes(snapshot.read_bytes()+b' ')\n" : "";
    await writeFile(wrapper, `import sys,runpy,pathlib,json,hashlib\nsys.path.insert(0,${JSON.stringify(path.dirname(originalScript))})\n${before}try:\n runpy.run_path(${JSON.stringify(originalScript)},run_name='__main__')\nexcept SystemExit as e:\n if e.code != 0: raise\nroot=pathlib.Path(sys.argv[sys.argv.index('--output-dir')+1])\nresult=root/'clips-result.v1.json'\nstatus=root/'receiver-status.v1.json'\n${mutations[kind] ?? "pass"}\n`);
    // Fixed trusted test configuration, not a request executable override. Actual Task1 runs first.
    process.env.PAPERCLIP_CU_RECEIVER_SCRIPT = wrapper;
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
