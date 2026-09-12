import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, missionPlanQaVerdicts, type Db } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedGateWorld, checkoutReviewer, readAndVerify, GATE_CHECK_ID, GATE_DECISION_HASH } from "./helpers/plan-qa-addendum.js";
import { buildPlanQaScope, readPlanQaCheck, verifyPlanQaSubmission, readVerifiedPlanQaGate, planQaGateMode } from "../services/missions/plan-qa-addendum-gate.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

// Each assertion exercises the real persisted scope, not a mocked database call.
describeQualityDb("PLAN-QA core attempt boundaries", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-core-boundaries-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb(); db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("rejects another agent impersonating the checked-out run before ledger writes", async () => {
    const w = await seedGateWorld(db);
    const before = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    await expect(readPlanQaCheck(db, { ...w.actor, agentId: w.ownerAgentId }, {
      issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"],
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId))).toEqual(before);
  });

  it("rejects a terminal producer even if checkout still points at its run", async () => {
    const w = await seedGateWorld(db);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.runId));
    await expect(readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not treat a malformed non-null issue marker as legacy", async () => {
    const w = await seedGateWorld(db);
    await db.update(issues).set({ qualityPlanQaBinding: { kind: "damaged" } }).where(eq(issues.id, w.planQaIssueId));
    expect(await planQaGateMode(db, { companyId: w.companyId, planQaIssueId: w.planQaIssueId })).toMatchObject({ kind: "fail_closed" });
  });

  it("rejects duplicate checks at the service boundary", async () => {
    const w = await seedGateWorld(db);
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    const read = await readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
    const check = { checkId: GATE_CHECK_ID, status: "satisfied" as const, readRef: read.readRef, evidence: [] };
    await expect(verifyPlanQaSubmission(db, w.actor, { scope, schemaVersion: 2, checks: [check, check] }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("requires a base verdict from the current agent and attempt, not a previous run", async () => {
    const w = await seedGateWorld(db);
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId,
      decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    const runId = await checkoutReviewer(db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    const actor = { ...w.actor, heartbeatRunId: runId, executionEpoch: 2 };
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: runId, executionEpoch: 2 });
    const read = await readPlanQaCheck(db, actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
    const result = await verifyPlanQaSubmission(db, actor, { scope, schemaVersion: 2, checks: [{ checkId: GATE_CHECK_ID, status: "satisfied", readRef: read.readRef, evidence: [] }] });
    expect(result).toMatchObject({ status: "missing_evidence" });
    if (result.status === "missing_evidence") expect(result.reasons.some((r) => r.code === "quality_plan_qa_base_verdict_missing")).toBe(true);
  });

  it("rejects a different pointer request rather than silently returning the first read", async () => {
    const w = await seedGateWorld(db);
    await readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
    await expect(readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/companyId"] }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not consume a prior attempt's PASS after a new checkout", async () => {
    const w = await seedGateWorld(db);
    await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" });
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    await checkoutReviewer(db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("rejects changed final submissions and preserves the original receipt", async () => {
    const w = await seedGateWorld(db);
    const result = await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" });
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    const [row] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    await expect(readAndVerify(w, "pass", { [GATE_CHECK_ID]: "defect" })).rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(after?.qualityContract).toEqual(row?.qualityContract);
    expect(await readVerifiedPlanQaGate(db, scope)).toMatchObject({ verdict: "pass", evidenceRefId: "evidenceRefId" in result ? result.evidenceRefId : randomUUID() });
  });
});
