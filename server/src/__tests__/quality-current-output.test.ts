// server/src/__tests__/quality-current-output.test.ts
//
// [purpose] T3 current_output 조치: 지원된 구조화 수정만 연결.
//   원본 상태(terminal → source_preserved)·기한/한도(unsupported_target)·범위(producer 경계)·
//   중복 수정(재패치 없음)·검증 실패(확인 승격 없음)·재실행 독립 QA 영수증으로만 확인 승격.

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  qualityActions,
  qualityEvidenceRefs,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import type { SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { countWakeups, reviewItemForAction, seedCurrentOutputScenario, type CurrentOutputSeed } from "./helpers/quality-proofs.js";
import { hashContract } from "../services/quality/contract.js";
import { getStorageService } from "../storage/index.js";
import { linkEvidence, uploadEvidence } from "../services/quality/evidence-store.js";
import { applyCurrentOutputCorrection } from "../services/quality/current-output.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";

const remediationsFor = (file: string, find: string, replace: string) => ({ items: [{ op: "string_replace", file, find, replace }] });

async function writeArtifact(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describeQualityDb("Quality current-output correction", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t3-co-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  /** current_output 조치를 실제 행으로 만든다. 시나리오 원본(진행 중) 또는 terminal 원본에 붙인다. */
  async function makeCurrentOutputAction(input: { source: SourceAttempt; groupId?: string; policyVersionId?: string; deadlineAt?: string; maxAttempts?: number }): Promise<string> {
    const db = owned.db;
    const actionId = randomUUID();
    const target = { kind: "current_output" as const, source: input.source };
    const effect = { kind: "repair_supported_output" as const, target };
    const intentKey = `co-${actionId.slice(0, 8)}`;
    const { occurrenceId } = await reviewItemForAction(db, input.source.companyId, input.source, input.source.heartbeatRunId);
    await db.insert(qualityActions).values({
      id: actionId, companyId: input.source.companyId, groupId: input.groupId ?? f.groupId, kind: "current_output",
      occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId],
      policyVersionId: input.policyVersionId ?? f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target),
        maxExecutorAttempts: input.maxAttempts ?? 2, deadlineAt: input.deadlineAt ?? new Date(Date.now() + 3_600_000).toISOString(),
        groupId: input.groupId ?? f.groupId, policyVersionId: input.policyVersionId ?? f.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    return actionId;
  }

  it("preserves a terminal original and writes nothing", async () => {
    const db = owned.db;
    // fixture 의 원본 mission 은 completed 상태다.
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "done original", missionId: f.sourceMissionId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: issue!.id, executionEpoch: 1 }).returning();
    const source: SourceAttempt = { companyId: f.companyId, issueId: issue!.id, heartbeatRunId: run!.id, executionEpoch: 1, inputHash: "ab".repeat(32), mission: { kind: "mission", id: f.sourceMissionId }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } };
    const actionId = await makeCurrentOutputAction({ source });
    const actionsBefore = await db.select().from(qualityActions).where(eq(qualityActions.companyId, f.companyId));
    const result = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(result).toEqual({ status: "source_preserved", evidenceRefId: null });
    expect(await db.select().from(qualityActions).where(eq(qualityActions.companyId, f.companyId))).toEqual(actionsBefore);
  });

  it("applies the supported correction with receipts and no wake, and stays pending verification", async () => {
    const db = owned.db;
    const file = path.join(root, "applied", "index.html");
    await writeArtifact(file, "<p>internal leads/evidence.json term</p>");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "leads/evidence.json", "선별 근거 요약") });
    const actionId = await makeCurrentOutputAction({ source: seed.source });
    const wakeBefore = await countWakeups(db, f.companyId);

    const binding = await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    expect(binding.stepRunId).toBe(seed.qaStepRunId);
    expect(binding.issueId).toBe(seed.qaIssueId);

    const result = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(result.status).toBe("verification_pending");
    expect(result.evidenceRefId).not.toBeNull();
    expect(await readFile(file, "utf8")).toBe("<p>internal 선별 근거 요약 term</p>");
    expect(await countWakeups(db, f.companyId)).toBe(wakeBefore);

    const events = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, f.companyId),
      eq(workflowTransitionEvents.workflowStepRunId, seed.qaStepRunId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    ));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.sourceVerdictEventId).toBe(seed.verdictEventId);
    expect(payload.qualityActionId).toBe(actionId);
    const hashes = payload.qualityFileHashes as Array<{ file: string; before: string; after: string }>;
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.before).toBe(createHash("sha256").update("<p>internal leads/evidence.json term</p>").digest("hex"));
    expect(hashes[0]!.after).toBe(createHash("sha256").update("<p>internal 선별 근거 요약 term</p>").digest("hex"));
    const receipts = await db.select().from(qualityEvidenceRefs).where(and(eq(qualityEvidenceRefs.companyId, f.companyId), eq(qualityEvidenceRefs.qualityActionId, actionId)));
    expect(receipts.length).toBeGreaterThan(0);
    const [action] = await db.select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.state).not.toBe("corrected");
  });

  it("does not re-patch an already applied correction (duplicate hold)", async () => {
    const db = owned.db;
    const file = path.join(root, "dup", "index.html");
    await writeArtifact(file, "dup findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "dup findme", "dup fixed") });
    const actionId = await makeCurrentOutputAction({ source: seed.source });
    await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    const first = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(first.status).toBe("verification_pending");
    const second = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(second).toEqual(first);
    expect(await readFile(file, "utf8")).toBe("dup fixed");
    const events = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, f.companyId), eq(workflowTransitionEvents.workflowStepRunId, seed.qaStepRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_applied")));
    expect(events).toHaveLength(1);
  });

  it("rejects an expired deadline without touching files", async () => {
    const db = owned.db;
    const file = path.join(root, "expired", "index.html");
    await writeArtifact(file, "expired findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "expired findme", "x") });
    const actionId = await makeCurrentOutputAction({ source: seed.source, deadlineAt: new Date(Date.now() - 1_000).toISOString() });
    const result = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(result).toEqual({ status: "unsupported_target", evidenceRefId: null });
    expect(await readFile(file, "utf8")).toBe("expired findme");
    const events = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, f.companyId), eq(workflowTransitionEvents.workflowStepRunId, seed.qaStepRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_applied")));
    expect(events).toHaveLength(0);
  });

  it("rejects a correction outside the producer artifact boundary", async () => {
    const db = owned.db;
    const registered = path.join(root, "boundary", "index.html");
    const outside = path.join(root, "boundary-out", "other.html");
    await writeArtifact(registered, "registered");
    await writeArtifact(outside, "outside findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: registered, remediations: remediationsFor(outside, "outside findme", "x") });
    const actionId = await makeCurrentOutputAction({ source: seed.source });
    await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    const result = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(result).toEqual({ status: "unsupported_target", evidenceRefId: null });
    expect(await readFile(outside, "utf8")).toBe("outside findme");
  });

  it("enforces the cumulative attempt limit on QA re-execution corrections", async () => {
    const db = owned.db;
    const file = path.join(root, "cap", "index.html");
    await writeArtifact(file, "cap findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "cap findme", "cap fixed") });
    const actionId = await makeCurrentOutputAction({ source: seed.source, maxAttempts: 1 });
    await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    const first = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(first.status).toBe("verification_pending");

    // 새 QA 세대의 새 verdict — 한도(1) 소진 후에는 unsupported_target.
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId: f.companyId, agentId: f.verifierAgentId, source: "workflow.dispatch", workflowStepRunId: seed.qaStepRunId });
    const hbAt = new Date();
    const [nextHeartbeat] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.verifierAgentId, issueId: seed.qaIssueId, executionEpoch: 2, workflowStepRunId: seed.qaStepRunId, workflowExecutionGeneration: 2, status: "succeeded", wakeupRequestId: wakeupId, startedAt: hbAt, finishedAt: hbAt, createdAt: hbAt }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId: f.companyId, missionId: seed.missionId, workflowRunId: seed.workflowRunId, workflowStepRunId: seed.qaStepRunId, issueId: seed.qaIssueId,
      heartbeatRunId: nextHeartbeat!.id, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `verdict:${seed.qaStepRunId}:${nextHeartbeat!.id}`,
      payload: { kind: "workflow_validation_verdict", verdict: "request_changes", remediations: remediationsFor(file, "cap fixed", "cap fixed2") },
    });
    await writeArtifact(file, "cap fixed");
    const second = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(second).toEqual({ status: "unsupported_target", evidenceRefId: null });
    expect(await readFile(file, "utf8")).toBe("cap fixed");
  });

  it("keeps the correction unconfirmed without a valid re-run verification receipt", async () => {
    const db = owned.db;
    const file = path.join(root, "verify-fail", "index.html");
    await writeArtifact(file, "verify findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "verify findme", "verify fixed") });
    const actionId = await makeCurrentOutputAction({ source: seed.source });
    await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    const applied = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(applied.status).toBe("verification_pending");

    // 영수증은 있어도 재실행 PASS verdict 가 없으면 — 확인 승격 없음(전용 검증 영수증 계약).
    const [existing] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, actionId)).limit(1);
    const uploadedObs = await uploadEvidence(getStorageService(), { companyId: f.companyId, body: Buffer.from("{}"), contentType: "application/json", originalFilename: "obs.json" });
    await db.transaction((tx) => linkEvidence(tx, {
      companyId: f.companyId, reviewItemId: existing!.reviewItemId,
      source: seed.source, scope: { kind: "output_correction", companyId: f.companyId, actionId, source: seed.source, verifierRunId: seed.verdictHeartbeatId, verifierEpoch: 1 },
      kind: "observation", uploaded: uploadedObs, expiresAt: null, issuedBy: "quality-t3-test",
    }));
    const again = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(again.status).toBe("verification_pending");
    const [action] = await db.select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.state).not.toBe("corrected");
  });

  it("confirms the correction only with the re-run independent QA's dedicated verification receipt", async () => {
    const db = owned.db;
    const file = path.join(root, "verify-ok", "index.html");
    await writeArtifact(file, "confirm findme");
    const seed = await seedCurrentOutputScenario(db, { companyId: f.companyId, authorAgentId: f.authorAgentId, verifierAgentId: f.verifierAgentId, artifactUrl: file, remediations: remediationsFor(file, "confirm findme", "confirm fixed") });
    const actionId = await makeCurrentOutputAction({ source: seed.source });
    await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId });
    await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });

    // 재실행 독립 QA(producer agent 와 다른 verifier)의 PASS verdict.
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId: f.companyId, agentId: f.verifierAgentId, source: "workflow.dispatch", workflowStepRunId: seed.qaStepRunId });
    const hbAt = new Date();
    const [passHeartbeat] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.verifierAgentId, issueId: seed.qaIssueId, executionEpoch: 2, workflowStepRunId: seed.qaStepRunId, workflowExecutionGeneration: 2, status: "succeeded", wakeupRequestId: wakeupId, startedAt: hbAt, finishedAt: hbAt, createdAt: hbAt }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId: f.companyId, missionId: seed.missionId, workflowRunId: seed.workflowRunId, workflowStepRunId: seed.qaStepRunId, issueId: seed.qaIssueId,
      heartbeatRunId: passHeartbeat!.id, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `verdict:${seed.qaStepRunId}:${passHeartbeat!.id}`,
      payload: { kind: "workflow_validation_verdict", verdict: "pass" },
    });
    // 전용 검증 영수증이 있어야만 확인으로 올린다. 영수증 없는 재호출은 확인 승격 없음.
    const [review] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, actionId)).limit(1);
    const beforeConfirm = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(beforeConfirm.status).toBe("verification_pending");
    const [actionBefore] = await db.select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(actionBefore!.state).not.toBe("corrected");
    // 재실행 세대로 step run generation 갱신(실제 재실행이 그렇게 한다).
    await db.update(workflowStepRuns).set({ executionGeneration: 2 }).where(eq(workflowStepRuns.id, seed.qaStepRunId));
    const uploadedVerify = await uploadEvidence(getStorageService(), { companyId: f.companyId, body: Buffer.from(JSON.stringify({ verdict: "pass" })), contentType: "application/json", originalFilename: "verification.json" });
    await db.transaction((tx) => linkEvidence(tx, {
      companyId: f.companyId, reviewItemId: review!.reviewItemId, source: seed.source,
      scope: { kind: "output_correction", companyId: f.companyId, actionId, source: seed.source, verifierRunId: passHeartbeat!.id, verifierEpoch: 2 },
      kind: "observation", uploaded: uploadedVerify, expiresAt: null, issuedBy: "quality-t3-test",
    }));
    const final = await applyCurrentOutputCorrection(db, { companyId: f.companyId, actionId });
    expect(final.status).toBe("verification_pending");
    const [actionAfter] = await db.select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(actionAfter!.state).toBe("corrected");
  });
});
