import express from "express";
import request from "supertest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, approvals } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { mountWorkflowReplacementRoutes } from "../routes/workflow-replacement.js";
import { errorHandler } from "../middleware/index.js";
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-routes-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await db.$client.end(); await temp.cleanup(); roots.forEach(r => rmSync(r, { recursive: true, force: true })); });
function app(actor: Express.Request["actor"]) {
  const a = express(), router = express.Router(); a.use(express.json());
  a.use((req, _res, next) => { req.actor = actor; next(); });
  mountWorkflowReplacementRoutes(router, db); a.use("/api", router); a.use(errorHandler); return a;
}
it("dedicated routes enforce actor/company boundaries and authenticated provenance", async () => {
  const s = await seedReplacement(db, false); roots.push(s.tempRoot);
  const base = `/api/companies/${s.companyId}/workflow-replacements/${s.proposal.id}`;
  const before = await db.select().from(approvals).where(eq(approvals.id, s.proposal.id));
  for (const action of ["approve", "reject", "request-revision", "resubmit"]) {
    expect((await request(app(s.actor)).post(`${base}/${action}`).send({})).status).toBe(403);
    expect((await request(app({ type: "board", source: "session", userId: "other", companyIds: [randomUUID()] })).post(`${base}/${action}`).send({})).status).toBe(403);
    expect((await request(app(s.board)).post(`${base}/${action}`).send({ decidedByUserId: "fake" })).status).toBe(400);
  }
  expect(await db.select().from(approvals).where(eq(approvals.id, s.proposal.id))).toEqual(before);
  expect((await request(app(s.board)).post(`${base}/request-revision`).send({ decisionNote: "Check inputs" })).status).toBe(200);
  expect((await request(app(s.board)).post(`${base}/resubmit`).send({ metadata: { checked: true } })).status).toBe(200);
  const result = await request(app(s.board)).post(`${base}/approve`).send({ decisionNote: "Reviewed" });
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: "approved", decidedByUserId: "local-board", decisionNote: "Reviewed" });
  expect((await request(app(s.board)).post(`${base}/resubmit`).send({})).status).toBe(409);
});
