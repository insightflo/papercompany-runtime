import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issues, missionPlanArtifacts, type Db } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { GATE_CHECK_ID, GATE_DECISION_HASH, readAndVerify, seedGateWorld } from "./helpers/plan-qa-addendum.js";
import { closePlanQaIssue, requireOwnerPlanQaPass, updatePlanQaRef } from "../services/missions/owner-plan-qa-consumers.js";
import { readPlanQaVerdict } from "../services/missions/mission-plan-qa-completion-gate.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

describeQualityDb("PLAN-QA consumer boundary checks", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-consumer-boundaries-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb(); db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("ref updates and close reject raw PASS without changing stored state", async () => {
    const w = await seedGateWorld(db);
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId,
      planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass",
      reviewedBy: { actorType: "user", actorId: "board-user" } });
    const scope = { db, companyId: w.companyId, missionId: w.missionId,
      missionPlanArtifactId: w.planArtifactId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH };
    const snapshot = async () => ({
      plans: await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId)),
      issues: await db.select().from(issues).where(eq(issues.id, w.planQaIssueId)),
    });
    const before = await snapshot();
    await expect(requireOwnerPlanQaPass(scope)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    await expect(updatePlanQaRef({ ...scope, patch: { status: "pass", verdict: "pass" } })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    await expect(closePlanQaIssue(scope)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it("verified request_changes permits review close/ref update but never materialization", async () => {
    const w = await seedGateWorld(db);
    await expect(readAndVerify(w, "pass", { [GATE_CHECK_ID]: "defect" })).resolves.toMatchObject({ status: "request_changes" });
    const scope = { db, companyId: w.companyId, missionId: w.missionId,
      missionPlanArtifactId: w.planArtifactId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH };
    await expect(requireOwnerPlanQaPass(scope)).rejects.toMatchObject({ status: 409 });
    await expect(updatePlanQaRef({ ...scope, patch: { status: "pass", verdict: "pass" } })).rejects.toMatchObject({ status: 409 });
    await closePlanQaIssue(scope);
    await updatePlanQaRef({ ...scope, patch: { status: "request_changes", verdict: "request_changes" } });
    const [review] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(review?.status).toBe("done");
    expect((await readPlanQaVerdict(scope))?.verdict).toBe("request_changes");
  });

  it.each(["planQa", "ownerPlanDecision"])("marked no-addendum owner consumers reject missing %s identity", async (key) => {
    const w = await seedGateWorld(db, { policy: false });
    const scope = { db, companyId: w.companyId, missionId: w.missionId,
      missionPlanArtifactId: w.planArtifactId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH };
    await recordMissionPlanQaVerdict({ ...scope, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    expect((await readPlanQaVerdict(scope))?.verdict).toBe("pass");
    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    const refs = { ...plan!.refs }; delete refs[key];
    await db.update(missionPlanArtifacts).set({ refs }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    expect(await readPlanQaVerdict(scope)).toBeNull();
    await expect(requireOwnerPlanQaPass(scope)).rejects.toMatchObject({ status: 409 });
    await expect(closePlanQaIssue(scope)).rejects.toMatchObject({ status: 409 });
  });
});
