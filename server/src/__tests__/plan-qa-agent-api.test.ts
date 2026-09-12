import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, issues, missionPlanQaVerdicts, qualityEvidenceRefs, workflowRuns } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { GATE_CHECK_ID, seedGateWorld } from "./helpers/plan-qa-addendum.js";
import { planQaApiApp, runEvidenceCli } from "./helpers/plan-qa-api.js";
import { readVerifiedPlanQaGate } from "../services/missions/plan-qa-verified-gate.js";

describeQualityDb("PLAN-QA registered API and real CLI", () => {
  let testDb: QualityTestDb;
  let dir: string;
  beforeAll(async () => {
    testDb = await createQualityTestDb();
    dir = await mkdtemp(path.join(tmpdir(), "plan-qa-api-files-"));
  }, 60_000);
  afterAll(async () => { await testDb?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it.each(["pass", "request_changes"] as const)("verifies %s through actual HTTP input/read/v2 submission", async (verdict) => {
    const w = await seedGateWorld(testDb.db);
    const app = planQaApiApp(testDb.db, w);
    const base = `/api/issues/${w.planQaIssueId}/mission-plan-qa`;
    const input = await request(app).get(`${base}/input`).expect(200);
    expect(input.body.data.scope.heartbeatRunId).toBe(w.runId);
    expect(input.body.data.manifest.checks).toHaveLength(1);
    const read = await request(app).post(`${base}/read`).send({ checkId: GATE_CHECK_ID, pointers: ["/missionId"] }).expect(201);
    expect(read.body.data.values).toEqual([w.missionId]);
    const checks = [{ checkId: GATE_CHECK_ID, status: verdict === "pass" ? "satisfied" : "defect", readRef: read.body.data.readRef, evidence: [] }];
    const submitted = await request(app).post(`${base}/verdict`).send({ schemaVersion: 2, verdict: "pass", checks }).expect(200);
    expect(submitted.body).toMatchObject({ status: "recorded", verdict });
    const [registry] = await testDb.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, submitted.body.evidenceRefId));
    expect(registry?.companyId).toBe(w.companyId);
    expect(await readVerifiedPlanQaGate(testDb.db, input.body.data.scope)).toEqual({ verdict, evidenceRefId: registry!.id });
    expect((await testDb.db.select().from(activityLog).where(eq(activityLog.entityId, w.planQaIssueId)))
      .some((row) => row.action === "issue.mission_plan_qa_verdict_submitted")).toBe(true);
  });

  it("returns missing evidence with exact action and no successful gate/workflow", async () => {
    const w = await seedGateWorld(testDb.db);
    const app = planQaApiApp(testDb.db, w);
    const base = `/api/issues/${w.planQaIssueId}/mission-plan-qa`;
    const out = await request(app).post(`${base}/verdict`).send({ schemaVersion: 2, verdict: "pass", checks: [] }).expect(200);
    expect(out.body).toMatchObject({ status: "missing_evidence", remainingResubmissions: 2,
      submission: { method: "POST", path: `${base}/verdict`, schemaVersion: 2 },
      scope: { companyId: w.companyId, missionId: w.missionId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 } });
    const [row] = await testDb.db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(row?.verdict).toBe("pending");
    expect((row?.qualityContract as { verdict: unknown }).verdict).toBeNull();
    expect(await testDb.db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).toEqual([]);
  });

  it("executes CLI input/read/submit against the real router, storage and isolated DB", async () => {
    const w = await seedGateWorld(testDb.db);
    const server = planQaApiApp(testDb.db, w).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test listener");
      const url = `http://127.0.0.1:${address.port}`;
      const cli = (args: string[]) => runEvidenceCli(url, w.runId, args);
      const input = await cli(["plan-qa-input", "--issue", w.planQaIssueId]);
      expect(input.code, input.stderr).toBe(0);
      expect(JSON.parse(input.stdout).scope.heartbeatRunId).toBe(w.runId);
      const read = await cli(["plan-qa-read", "--issue", w.planQaIssueId, "--check", GATE_CHECK_ID, "--pointer", "/missionId"]);
      expect(read.code, read.stderr).toBe(0);
      const readRef = JSON.parse(read.stdout).readRef;
      const file = path.join(dir, "submission.json");
      await writeFile(file, JSON.stringify({ schemaVersion: 2, verdict: "pass", checks: [] }));
      const missing = await cli(["plan-qa-submit", "--issue", w.planQaIssueId, "--file", file]);
      expect(missing.code, missing.stderr).toBe(2);
      expect(JSON.parse(missing.stdout).status).toBe("missing_evidence");
      await writeFile(file, JSON.stringify({ schemaVersion: 2, verdict: "pass", checks: [{ checkId: GATE_CHECK_ID, status: "satisfied", readRef, evidence: [] }] }));
      const submitted = await cli(["plan-qa-submit", "--issue", w.planQaIssueId, "--file", file]);
      expect(submitted.code, submitted.stderr).toBe(0);
      const out = JSON.parse(submitted.stdout);
      expect(out.verdict).toBe("pass");
      const [stored] = await testDb.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, out.evidenceRefId));
      expect(stored?.companyId).toBe(w.companyId);
      const [issue] = await testDb.db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
      expect(issue?.qualityPlanQaBinding).not.toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
