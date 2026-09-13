import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { heartbeatRuns, issues, qualityActions, workflowDefinitions, workflowRuns, workflowStepRuns, evaluatorVersions, evaluatorCandidateRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { verifySourceAttempt, verifyEvidenceScope } from "../services/quality/evidence-verifier.js";

describeQualityDb("Quality source and evidence scope DB relationships", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let source: SourceAttempt;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    const [issue] = await owned.db.insert(issues).values({ companyId: f.companyId, title: "source" }).returning();
    const [run] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: issue.id, executionEpoch: 3 }).returning();
    source = { companyId: f.companyId, issueId: issue.id, heartbeatRunId: run.id, executionEpoch: 3, inputHash: "aa".repeat(32), mission: { kind: "not_applicable", reason: "no_source_mission" }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } };
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  it("accepts a real same-company attempt without inventing a mission or workflow", async () => {
    await expect(verifySourceAttempt(owned.db, f.companyId, source)).resolves.toBeUndefined();
  });
  it.each(["company", "issue", "run", "epoch", "mission", "workflow"] as const)("rejects invalid %s independently and leaves source rows unchanged", async (fault) => {
    const before = await owned.db.select().from(heartbeatRuns);
    const invalid = { ...source };
    if (fault === "company") invalid.companyId = f.otherCompanyId;
    if (fault === "issue") invalid.issueId = randomUUID();
    if (fault === "run") invalid.heartbeatRunId = randomUUID();
    if (fault === "epoch") invalid.executionEpoch = 2;
    if (fault === "mission") invalid.mission = { kind: "mission", id: f.sourceMissionId };
    if (fault === "workflow") invalid.workflow = { kind: "workflow_step", runId: randomUUID(), stepRunId: randomUUID(), generation: 1, dispatchAuthorityVersion: 1 };
    await expect(verifySourceAttempt(owned.db, f.companyId, invalid)).rejects.toMatchObject({ status: 422 });
    expect(await owned.db.select().from(heartbeatRuns)).toEqual(before);
  });
  it("checks real workflow generation, authority version and evaluation ownership independently", async () => {
    const [issue] = await owned.db.insert(issues).values({ companyId: f.companyId, title: "evaluation", missionId: f.sourceMissionId }).returning();
    const [definition] = await owned.db.insert(workflowDefinitions).values({ companyId: f.companyId, name: "local fixture" }).returning();
    const [workflow] = await owned.db.insert(workflowRuns).values({ companyId: f.companyId, workflowId: definition.id, missionId: f.sourceMissionId, triggeredBy: "test", dispatchAuthorityVersion: 4 }).returning();
    const [step] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: workflow.id, stepId: "verify", issueId: issue.id, executionGeneration: 2 }).returning();
    const [run] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.verifierAgentId, issueId: issue.id, executionEpoch: 1, workflowStepRunId: step.id, workflowExecutionGeneration: 2 }).returning();
    const attempt: SourceAttempt = { ...source, issueId: issue.id, heartbeatRunId: run.id, executionEpoch: 1, mission: { kind: "mission", id: f.sourceMissionId }, workflow: { kind: "workflow_step", runId: workflow.id, stepRunId: step.id, generation: 2, dispatchAuthorityVersion: 4 } };
    await expect(verifySourceAttempt(owned.db, f.companyId, attempt)).resolves.toBeUndefined();
    for (const change of [{ generation: 1 }, { dispatchAuthorityVersion: 3 }, { stepRunId: randomUUID() }]) {
      const workflowRef = { kind: "workflow_step" as const, runId: workflow.id, stepRunId: step.id, generation: 2, dispatchAuthorityVersion: 4, ...change };
      await expect(verifySourceAttempt(owned.db, f.companyId, { ...attempt, workflow: workflowRef })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
    }
    const [version] = await owned.db.insert(evaluatorVersions).values({ companyId: f.companyId, name: "fixture" }).returning();
    const [evaluation] = await owned.db.insert(evaluatorCandidateRuns).values({ companyId: f.companyId, evaluatorVersionId: version.id, qualityActionId: f.actionId }).returning();
    await owned.db.update(qualityActions).set({ currentEvaluationId: evaluation.id }).where(eq(qualityActions.id, f.actionId));
    const scope = { kind: "evaluation" as const, companyId: f.companyId, actionId: f.actionId, evaluationId: evaluation.id, missionId: f.sourceMissionId, workflowRunId: workflow.id, stepRunId: step.id, generation: 2, issueId: issue.id, heartbeatRunId: run.id, executionEpoch: 1 };
    await expect(verifyEvidenceScope(owned.db, f.companyId, scope)).resolves.toBeUndefined();
    await owned.db.update(qualityActions).set({ currentEvaluationId: null }).where(eq(qualityActions.id, f.actionId));
    await expect(verifyEvidenceScope(owned.db, f.companyId, scope)).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
  });
  it("rejects a nonexistent action even when source and verifier are real", async () => {
    await expect(verifyEvidenceScope(owned.db, f.companyId, { kind: "output_correction", companyId: f.companyId, actionId: randomUUID(), source, verifierRunId: source.heartbeatRunId, verifierEpoch: 3 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
  });
  it("does not let a same-company unrelated action authorize a correction scope", async () => {
    await expect(verifyEvidenceScope(owned.db, f.companyId, { kind: "output_correction", companyId: f.companyId, actionId: f.actionId, source, verifierRunId: source.heartbeatRunId, verifierEpoch: 3 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
  });
  it("rejects a verifier from an unrelated issue, not just a foreign company", async () => {
    const target = { kind: "current_output" as const, source };
    await owned.db.update(qualityActions).set({ kind: "current_output", target }).where(eq(qualityActions.id, f.actionId));
    const [otherIssue] = await owned.db.insert(issues).values({ companyId: f.companyId, title: "unrelated" }).returning();
    const [otherRun] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.verifierAgentId, issueId: otherIssue.id, executionEpoch: 3 }).returning();
    await expect(verifyEvidenceScope(owned.db, f.companyId, { kind: "output_correction", companyId: f.companyId, actionId: f.actionId, source, verifierRunId: otherRun.id, verifierEpoch: 3 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
  });
  it("rejects a foreign verifier even when source and action are real", async () => {
    await expect(verifyEvidenceScope(owned.db, f.companyId, { kind: "output_correction", companyId: f.companyId, actionId: f.actionId, source, verifierRunId: randomUUID(), verifierEpoch: 3 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
  });
});
