import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueAttachments, missionPlanArtifacts, missionPlanQaVerdicts, type Db } from "@paperclipai/db";
import type { AddendumCheck, CheckResult } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedGateWorld, GATE_CHECK_ID, GATE_DECISION_HASH, type GateWorld } from "./helpers/plan-qa-addendum.js";
import { buildPlanQaScope, readPlanQaCheck, readVerifiedPlanQaGate, verifyPlanQaSubmission } from "../services/missions/plan-qa-addendum-gate.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

const extraCheck = (patch: Partial<AddendumCheck> = {}): AddendumCheck => ({
  checkId: "check-extra", requirementRefs: [{ attachmentId: randomUUID(), sha256: "ab".repeat(32) }],
  applicability: { op: "always" }, expectedEvidenceKinds: ["read"], instructions: "Check pinned input", ...patch,
});
async function check(w: GateWorld, checkId: string, status: CheckResult["status"]): Promise<CheckResult> {
  const read = await readPlanQaCheck(w.db, w.actor, { issueId: w.planQaIssueId, checkId, pointers: ["/missionId"] });
  return { checkId, status, readRef: read.readRef, evidence: [] };
}
async function submit(w: GateWorld, checks: CheckResult[]) {
  await recordMissionPlanQaVerdict({ db: w.db, companyId: w.companyId, missionId: w.missionId,
    planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass",
    reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
  const scope = await buildPlanQaScope(w.db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
  return { result: await verifyPlanQaSubmission(w.db, w.actor, { scope, schemaVersion: 2, checks }), scope };
}

describeQualityDb("PLAN-QA evidence coverage", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-coverage-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb(); db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("requires full coverage and verifies non-applicability before allowing excluded", async () => {
    const extraTemplateId = randomUUID();
    const w = await seedGateWorld(db, { extraTemplateId, extraChecks: [extraCheck({ applicability: { op: "selected_templates_all", templateIds: [extraTemplateId] } })] });
    const first = await check(w, GATE_CHECK_ID, "satisfied");
    expect((await submit(w, [first])).result).toMatchObject({ status: "missing_evidence" });
    const excluded = await check(w, "check-extra", "excluded");
    const { result, scope } = await submit(w, [first, excluded]);
    expect(result).toMatchObject({ status: "pass" });
    expect(await readVerifiedPlanQaGate(db, scope)).toMatchObject({ verdict: "pass" });
  });

  it("preserves a verified defect diagnostic alongside a technical failure without making a final gate", async () => {
    const w = await seedGateWorld(db, { extraChecks: [extraCheck()] });
    const { result, scope } = await submit(w, [await check(w, GATE_CHECK_ID, "defect"), await check(w, "check-extra", "execution_error")]);
    expect(result).toMatchObject({ status: "missing_evidence" });
    const [row] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(row?.verdict).toBe("pending");
    expect(row?.diagnostics).toEqual([expect.objectContaining({ checkId: GATE_CHECK_ID, templateId: w.templateId })]);
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("requires the expected evidence kind, not an arbitrary available attachment", async () => {
    const w = await seedGateWorld(db, { extraChecks: [extraCheck({ expectedEvidenceKinds: ["tool_result"] })] });
    const { result } = await submit(w, [await check(w, GATE_CHECK_ID, "satisfied"), await check(w, "check-extra", "satisfied")]);
    expect(result).toMatchObject({ status: "missing_evidence" });
    if (result.status === "missing_evidence") expect(result.reasons).toContainEqual(expect.objectContaining({ code: "quality_evidence_kind_unavailable", requiredKind: "tool_result" }));
  });

  it("fails closed if original read evidence disappears after PASS", async () => {
    const w = await seedGateWorld(db);
    const selected = await check(w, GATE_CHECK_ID, "satisfied");
    const { result, scope } = await submit(w, [selected]);
    expect(result).toMatchObject({ status: "pass" });
    await db.delete(issueAttachments).where(eq(issueAttachments.id, selected.readRef.attachmentId));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("fails closed if the active decision hash is absent even when the issue marker remains", async () => {
    const w = await seedGateWorld(db);
    const { scope } = await submit(w, [await check(w, GATE_CHECK_ID, "satisfied")]);
    await db.update(missionPlanArtifacts).set({ refs: { ownerPlanDecision: { decisionHash: GATE_DECISION_HASH } } }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });
});
