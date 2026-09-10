import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { bindCuJob } from "../services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../services/workflow-resume-cu-objects.js";
import { cuDatabase, cuCase, cuApp, configureCu, boardMembership, type CuCase } from "./workflow-resume-cu-fixture.js";

let fixture: Awaited<ReturnType<typeof cuDatabase>>, c: CuCase;
beforeAll(async () => {
  fixture = await cuDatabase(); c = await cuCase(fixture); configureCu(c); await boardMembership(fixture, c);
  await bindCuJob(fixture.db, { job: c.job, planObject: c.planObject },
    { readObject: createCuObjectReader(fixture.db), creatorId: "controller" });
}, 120_000);
afterAll(async () => { await c?.cleanup(); await fixture?.cleanup(); });
const setPrincipal = (value: unknown) => { process.env.PAPERCLIP_CU_OBSERVERS_JSON = JSON.stringify(value); };
async function count() { return (await fixture.sql`SELECT count(*)::int AS n FROM workflow_cu_observations`)[0].n; }

test("actual middleware: absent/wrong observer bearer and board session never fall back", async () => {
  const app = cuApp(fixture, c);
  for (const token of [undefined, "wrong", ""]) {
    let req = request(app).post(c.observerUrl).send(c.observations[0]);
    if (token !== undefined) req = req.set("Authorization", `Bearer ${token}`);
    expect((await req).status).toBe(401);
  }
  const board = await request(app).post(c.observerUrl).set("x-fixture-board", "1")
    .set("Origin", "http://localhost:3100").send(c.observations[0]);
  expect(board.status).toBe(401);
  expect(await count()).toBe(0);
});
test("ordinary authenticated agent cannot act as observer or board", async () => {
  process.env.PAPERCLIP_AGENT_JWT_SECRET = "cu-test-jwt-secret";
  const token = createLocalAgentJwt(c.agentId, c.companyId, "process", randomUUID());
  expect(token).toBeTruthy(); const app = cuApp(fixture, c);
  expect((await request(app).post(c.observerUrl).set("Authorization", `Bearer ${token}`).send(c.observations[0])).status).toBe(401);
  expect((await request(app).post(c.intakeUrl).set("Authorization", `Bearer ${token}`).send(c.intake)).status).toBe(403);
  expect(await count()).toBe(0);
});
test.each(["absent", "invalid-json", "plaintext", "upper-digest", "unknown-key", "duplicate-id", "duplicate-token"])("strict observer configuration fails closed: %s", async kind => {
  configureCu(c);
  const p = structuredClone(c.principal) as any;
  if (kind === "absent") delete process.env.PAPERCLIP_CU_OBSERVERS_JSON;
  if (kind === "invalid-json") process.env.PAPERCLIP_CU_OBSERVERS_JSON = "no";
  if (kind === "plaintext") { p.token = "observer-secret"; delete p.tokenSha256; setPrincipal([p]); }
  if (kind === "upper-digest") { p.tokenSha256 = p.tokenSha256.toUpperCase(); setPrincipal([p]); }
  if (kind === "unknown-key") setPrincipal([{ ...p, approved: true }]);
  if (kind === "duplicate-id") setPrincipal([p, { ...p, tokenSha256: "f".repeat(64) }]);
  if (kind === "duplicate-token") setPrincipal([p, { ...p, id: "other" }]);
  const reply = await request(cuApp(fixture, c)).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(c.observations[0]);
  expect(reply.status).toBe(401); expect(reply.body).toEqual({ error: "cu_observer_unauthorized" });
  expect(await count()).toBe(0); configureCu(c);
});
test.each(["company", "job", "generation", "no-grant", "human"])("valid observer without exact receiver grant rejects: %s", async kind => {
  configureCu(c); const p = structuredClone(c.principal);
  if (kind === "company") p.grants[0].companyId = randomUUID();
  if (kind === "job") p.grants[0].jobId = randomUUID();
  if (kind === "generation") p.grants[0].executionGeneration++;
  if (kind === "no-grant") p.grants = [];
  if (kind === "human") p.observationKind = "human_attestation";
  setPrincipal([p]);
  expect((await request(cuApp(fixture, c)).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(c.observations[0])).status).toBe(403);
  expect(await count()).toBe(0); configureCu(c);
});
test("scope mismatch and unknown observer fields reject before writes", async () => {
  const app = cuApp(fixture, c);
  for (const body of [{ ...c.observations[0], jobId: randomUUID() }, { ...c.observations[0], records: [] },
    { ...c.observations[0], observerId: "board" }, { ...c.observations[0], screenshotSha256: "0".repeat(64) },
    { ...c.observations[0], fields: { ...c.observations[0].fields, reviewer_id: "forged" } }]) {
    expect((await request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(body)).status).toBe(400);
  }
  expect((await request(app).post(c.observerUrl.replace(c.missionId, randomUUID()))
    .set("Authorization", "Bearer observer-secret").send(c.observations[0])).status).toBe(404);
  expect(await count()).toBe(0);
});
test("board intake rejects unauthenticated/observer actors, raw trusted records and private paths", async () => {
  const app = cuApp(fixture, c);
  expect((await request(app).post(c.intakeUrl).send(c.intake)).status).toBe(401);
  expect((await request(app).post(c.intakeUrl).set("Authorization", "Bearer observer-secret").send(c.intake)).status).toBe(401);
  // The real global session mutation guard remains in force.
  expect((await request(app).post(c.intakeUrl).set("x-fixture-board", "1").send(c.intake)).status).toBe(403);
  for (const extra of [{ job: c.job }, { records: [] }, { snapshot: {} }, { snapshotSha256: "f".repeat(64) }, { path: c.root }]) {
    expect((await request(app).post(c.intakeUrl).set("x-fixture-board", "1")
      .set("Origin", "http://localhost:3100").send({ ...c.intake, ...extra })).status).toBe(400);
  }
  expect((await request(app).post(c.intakeUrl).set("x-fixture-board", "1").set("Origin", "http://localhost:3100")
    .send({ ...c.intake, manifestObject: c.queue + "../manifest.json" })).status).toBe(400);
  expect((await fixture.sql`SELECT count(*)::int AS n FROM workflow_late_evidence_submissions`)[0].n).toBe(0);
});
test("canonical screenshot encoding/signature, observer timestamp and strict comparison are required", async () => {
  const app = cuApp(fixture, c);
  const original = c.observations[0];
  for (const change of [{ screenshotBase64: "!!!!" }, { screenshotBase64: Buffer.from("prose").toString("base64") },
    { screenshotBase64: original.screenshotBase64 + "\n" }, { observedAt: "2026-09-08" },
    { observedAt: new Date(Date.now() + 3600_000).toISOString() },
    { fields: { ...original.fields, comparison: { source_matches: "true", download_matches: true, reviewed_at: original.observedAt } } },
    { fields: { ...original.fields, comparison: { source_matches: true, download_matches: true, reviewed_at: "2000-01-01T00:00:00Z" } } }]) {
    expect((await request(app).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send({ ...original, ...change })).status).toBe(400);
  }
  expect(await count()).toBe(0);
});
