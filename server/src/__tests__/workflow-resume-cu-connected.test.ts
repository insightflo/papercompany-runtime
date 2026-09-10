import { afterAll, beforeAll, expect, test } from "vitest";
import request from "supertest";
import { readFile, readdir } from "node:fs/promises";
import { cuDatabase, cuCase, cuApp, configureCu, boardMembership, digest, type CuCase } from "./workflow-resume-cu-fixture.js";

let fixture: Awaited<ReturnType<typeof cuDatabase>>, c: CuCase;
beforeAll(async () => { fixture = await cuDatabase(); c = await cuCase(fixture); configureCu(c); await boardMembership(fixture, c); }, 120_000);
afterAll(async () => { await c?.cleanup(); await fixture?.cleanup(); });

test("connected controller bind -> observer HTTP persisted screenshots -> board HTTP -> producer test-double subprocess -> independent durable DB result", async () => {
  const { bindCuJob } = await import("../services/workflow-resume-cu-evidence.js");
  const { createCuObjectReader } = await import("../services/workflow-resume-cu-objects.js");
  await bindCuJob(fixture.db, { job: c.job, planObject: c.planObject },
    { readObject: createCuObjectReader(fixture.db), creatorId: "fixture-controller" });
  const [bound] = await fixture.sql`SELECT * FROM workflow_cu_jobs WHERE id=${c.job.job_id}`;
  expect(bound.inputs).toEqual(c.inputs);
  const [stepBefore] = await fixture.sql`SELECT * FROM workflow_step_runs WHERE id=${c.job.step_run_id}`;
  const [runBefore] = await fixture.sql`SELECT * FROM workflow_runs WHERE id=${c.job.workflow_run_id}`;
  const app = cuApp(fixture, c);
  for (const observation of c.observations) {
    const reply = await request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(observation);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  }
  const rows = await fixture.sql`SELECT * FROM workflow_cu_observations WHERE job_id=${c.job.job_id}`;
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.observer_id).toBe(c.principal.id);
    expect(Buffer.from(row.screenshot_base64, "base64")).toEqual(c.screenshot);
    expect(row.screenshot_sha256).toBe(digest(c.screenshot));
  }
  const reply = await request(app).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100").send(c.intake);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  const statusDiagnostic = await readFile(`${c.evidence}/${reply.body.id}/result/receiver-status.v1.json`, "utf8").catch(() => "no status");
  const filesDiagnostic = await readdir(`${c.evidence}/${reply.body.id}`, { recursive: true }).catch(() => []);
  expect(reply.body.state, JSON.stringify({ reply: reply.body, statusDiagnostic, filesDiagnostic })).toBe("verified");
  expect(reply.body.code).toBe("cu_artifact_verified");
  expect(reply.body.result.scope).toEqual(c.scope);
  const [submission] = await fixture.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${reply.body.id}`;
  expect(submission.artifact_id).toBe(reply.body.artifactId); expect(submission.verified_at).not.toBeNull();
  expect(submission.readback_hash).toBe(submission.cu_result_sha256);
  const raw = Buffer.from(submission.cu_result_base64, "base64");
  expect(digest(raw)).toBe(submission.cu_result_sha256);
  expect(JSON.parse(raw.toString())).toEqual(reply.body.result);
  const snapshot = Buffer.from(submission.cu_snapshot_base64, "base64");
  expect(digest(snapshot)).toBe(submission.cu_snapshot_sha256);
  expect(JSON.parse(snapshot.toString()).records).toHaveLength(2);
  expect(JSON.parse(snapshot.toString()).budget.complete).toBe(true);
  expect(await readFile(`${c.evidence}/${submission.id}/snapshot.json`)).toEqual(snapshot);
  expect(await readFile(`${c.evidence}/${submission.id}/result/clips-result.v1.json`)).toEqual(raw);
  const readback = await request(app).get(`${c.intakeUrl}/${submission.id}`).set("x-fixture-board", "1");
  expect(readback.body).toEqual(reply.body);
  expect(JSON.stringify(reply.body)).not.toContain(c.root);
  const replay = await request(app).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100").send(c.intake);
  expect(replay.body).toEqual(reply.body);
  expect((await fixture.sql`SELECT * FROM workflow_step_runs WHERE id=${c.job.step_run_id}`)[0]).toEqual(stepBefore);
  expect((await fixture.sql`SELECT * FROM workflow_runs WHERE id=${c.job.workflow_run_id}`)[0]).toEqual(runBefore);
  expect(await fixture.sql`SELECT id FROM issue_work_products WHERE company_id=${c.companyId}`).toHaveLength(1);
  for (const table of ["heartbeat_runs", "agent_wakeup_requests"]) {
    const [count] = await fixture.sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`, [c.companyId]);
    expect(count.n).toBe(0);
  }
}, 120_000);
