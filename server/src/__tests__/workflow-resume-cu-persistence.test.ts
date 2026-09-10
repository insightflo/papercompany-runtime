import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { bindCuJob } from "../services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../services/workflow-resume-cu-objects.js";
import { cuDatabase, cuCase, cuApp, configureCu, boardMembership, type CuCase } from "./workflow-resume-cu-fixture.js";

let fixture: Awaited<ReturnType<typeof cuDatabase>>, c: CuCase;
beforeAll(async () => { fixture = await cuDatabase(); c = await cuCase(fixture); configureCu(c); await boardMembership(fixture, c); }, 120_000);
afterAll(async () => { await c?.cleanup(); await fixture?.cleanup(); });
const bind = (job: unknown = c.job, planObject = c.planObject) => bindCuJob(fixture.db, { job, planObject },
  { readObject: createCuObjectReader(fixture.db), creatorId: "controller" });

test("original spec digest and exact DB scope checked before any binding", async () => {
  await expect(bind({ ...c.job, spec_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 422 });
  for (const change of [{ company_id: randomUUID() }, { mission_id: randomUUID() }, { workflow_run_id: randomUUID() },
    { step_run_id: randomUUID() }, { issue_id: randomUUID(), report: { issue_id: randomUUID() } },
    { execution_generation: 3 }, { step_id: "other" }]) {
    await expect(bind({ ...c.job, ...change })).rejects.toHaveProperty("status");
  }
  await expect(bind(c.job, c.planObject + "/../plan.json")).rejects.toHaveProperty("status");
  expect((await fixture.sql`SELECT count(*)::int AS n FROM workflow_cu_jobs`)[0].n).toBe(0);
});
test("real concurrent controller binding exact replay, creator/input/job conflicts never replace", async () => {
  const results = await Promise.all([bind(), bind()]);
  expect(results[0]).toEqual(results[1]); expect(results[0].inputs).toEqual(c.inputs);
  await expect(bind({ ...c.job, mode: "generate" })).rejects.toMatchObject({ status: 409 });
  await expect(bindCuJob(fixture.db, { job: c.job, planObject: c.planObject },
    { readObject: createCuObjectReader(fixture.db), creatorId: "other-controller" })).rejects.toMatchObject({ status: 409 });
  await c.put(c.inputs.sources[0].object, Buffer.from("changed original"));
  await expect(bind()).rejects.toMatchObject({ status: 409 });
  await c.put(c.inputs.sources[0].object, c.screenshot);
  const [row] = await fixture.sql`SELECT * FROM workflow_cu_jobs WHERE id=${c.job.job_id}`;
  expect(row.inputs).toEqual(c.inputs); expect(row.job).toEqual(c.job);
});
test("observer immutable concurrent replay and conflicting screenshot/identity/fields", async () => {
  const app = cuApp(fixture, c), send = (body: unknown) => request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(body);
  const replies = await Promise.all([send(c.observations[0]), send(c.observations[0])]);
  expect(replies.map(r => r.status)).toEqual([201, 201]); expect(replies[0].body).toEqual(replies[1].body);
  const screenshot = Buffer.concat([c.screenshot, Buffer.from("changed bytes")]).toString("base64");
  expect((await send({ ...c.observations[0], screenshotBase64: screenshot })).status).toBe(409);
  expect((await send({ ...c.observations[0], fields: { ...c.observations[0].fields, download_id: "different" } })).status).toBe(409);
  process.env.PAPERCLIP_CU_OBSERVERS_JSON = JSON.stringify([{ ...c.principal, id: "other-observer" }]);
  expect((await send(c.observations[0])).status).toBe(409); configureCu(c);
  const rows = await fixture.sql`SELECT * FROM workflow_cu_observations WHERE job_id=${c.job.job_id}`;
  expect(rows).toHaveLength(1); expect(rows[0].observer_id).toBe(c.principal.id);
  expect(rows[0].screenshot_base64).toBe(c.screenshot.toString("base64"));
  expect(rows[0].payload.comparison.reviewer_id).toBe(c.principal.id);
});
test("DB immutable tables reject mutation, not merely HTTP upsert avoidance", async () => {
  await expect(fixture.sql`UPDATE workflow_cu_jobs SET creator_id='changed' WHERE id=${c.job.job_id}`).rejects.toThrow();
  await expect(fixture.sql`UPDATE workflow_cu_observations SET screenshot_sha256=${"0".repeat(64)} WHERE job_id=${c.job.job_id}`).rejects.toThrow();
  await expect(fixture.sql`DELETE FROM workflow_cu_observations WHERE job_id=${c.job.job_id}`).rejects.toThrow();
});
test("intake replay never changes its pinned snapshot under explicit producer rejection, new explicit budget revision uses a new submission", async () => {
  const app = cuApp(fixture, c), observer = (body: unknown) => request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(body);
  expect((await observer(c.observations[1])).status).toBe(201);
  const incomplete = { ...c.observations[2], fields: { events: c.manifest.credits.events } };
  expect((await observer(incomplete)).status).toBe(201);
  const board = (body: unknown) => request(app).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100").send(body);
  // Explicit CONSTANT producer-rejection double for the first intake only: proves the existing
  // pinned blocked result cannot become success merely because the producer later returns success.
  const wrapper = path.join(c.root, "rejection-receiver.mjs");
  await writeFile(wrapper, `// PRODUCER-REJECTION TEST DOUBLE — ordinary CI only, not the real receiver.
import { writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
writeFileSync(path.join(arg("--output-dir"), "receiver-status.v1.json"), JSON.stringify({
  schema: "shorts.cu-receiver-status.v1", status: "needs_submission", code: "needs_submission" }), { mode: 0o600 });
process.exit(2);
`);
  configureCu(c, { executable: process.execPath, script: wrapper });
  const first = await board(c.intake); expect(first.body.state).toBe("blocked");
  // Restore the default success fixture BEFORE replay/revision checks; the new idempotency key
  // below admits the valid fixture.
  configureCu(c);
  const [before] = await fixture.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${first.body.id}`;
  expect(JSON.parse(Buffer.from(before.cu_snapshot_base64, "base64").toString()).budget).not.toHaveProperty("complete");
  expect((await observer(c.observations[2])).status).toBe(409);
  expect((await observer({ ...c.observations[2], recordId: "budget-2" })).status).toBe(201);
  expect((await board(c.intake)).body).toEqual(first.body);
  expect((await board({ ...c.intake, manifestSha256: "0".repeat(64) })).status).toBe(409);
  const second = await board({ ...c.intake, idempotencyKey: randomUUID() });
  expect(second.body.code).toBe("cu_artifact_verified"); expect(second.body.state).toBe("verified");
  const [after] = await fixture.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${first.body.id}`;
  expect(after).toEqual(before);
  await expect(fixture.sql`UPDATE workflow_late_evidence_submissions SET cu_snapshot_sha256=${"0".repeat(64)} WHERE id=${first.body.id}`).rejects.toThrow();
  await expect(fixture.sql`UPDATE workflow_late_evidence_submissions SET cu_result_sha256=${"0".repeat(64)} WHERE id=${second.body.id}`).rejects.toThrow();
  const [activity] = await fixture.sql`SELECT json_agg(details)::text AS details FROM activity_log WHERE action LIKE 'workflow.cu_%'`;
  expect(activity.details).not.toContain("observer-secret"); expect(activity.details).not.toContain(c.screenshot.toString("base64"));
});
test("fresh DB screenshot bytes/hash corruption blocks export even after valid authenticated admission", async () => {
  const corrupt = Buffer.concat([c.screenshot, Buffer.from("fault-injection")]).toString("base64");
  // Deliberate test-only storage fault, bypassing the tested immutable trigger. No trusted record insertion.
  const replace = async (value: string) => fixture.sql.begin(async sql => {
    await sql`SET LOCAL session_replication_role = replica`;
    await sql`UPDATE workflow_cu_observations SET screenshot_base64=${value} WHERE job_id=${c.job.job_id} AND record_id='prov-1'`;
  });
  await replace(corrupt);
  try {
    const reply = await request(cuApp(fixture, c)).post(c.intakeUrl).set("x-fixture-board", "1")
      .set("Origin", "http://localhost:3100").send({ ...c.intake, idempotencyKey: randomUUID() });
    expect(reply.status).toBe(422); expect(reply.body).toEqual({ error: "cu_observation_readback_failed" });
  } finally { await replace(c.screenshot.toString("base64")); }
});
