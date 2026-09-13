import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, qualityOccurrences, qualityReviewItems, qualityActions, qualityActionGroups } from "@paperclipai/db";
import type { SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { writeQualityFinding } from "../services/quality-finding-writer.js";
import { hashContract } from "../services/quality/contract.js";

it("does not change identity when JSON field order changes", () => {
  expect(hashContract({ a: 1, b: [2, 3] })).toBe(hashContract({ b: [2, 3], a: 1 }));
  expect(hashContract({ a: 1, b: [2, 3] })).not.toBe(hashContract({ a: 1, b: [3, 2] }));
});

describeQualityDb("Quality occurrence preservation", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let source: SourceAttempt;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    const [issue] = await owned.db.insert(issues).values({ companyId: f.companyId, title: "original", missionId: f.sourceMissionId }).returning();
    const [run] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: issue.id, executionEpoch: 1 }).returning();
    source = { companyId: f.companyId, issueId: issue.id, heartbeatRunId: run.id, executionEpoch: 1, inputHash: "ab".repeat(32), mission: { kind: "mission", id: f.sourceMissionId }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } };
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  function finding(key: string, attempt = source) {
    return { companyId: f.companyId, missionId: f.sourceMissionId, title: "failure", targetType: "current_output", triggerSource: "test", targetId: key, failureType: "missing_evidence", occurrence: { producerRunId: attempt.heartbeatRunId, submissionKey: key, source: attempt, evidence: [] } };
  }
  it("persists an occurrence before returning an open review, and replays without spending", async () => {
    const input = finding(randomUUID());
    const first = await writeQualityFinding(owned.db, input);
    const rows = await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, first.reviewItemId));
    expect(rows).toHaveLength(1);
    const groupBefore = await owned.db.select().from(qualityActionGroups);
    const replay = await writeQualityFinding(owned.db, input);
    expect(replay).toEqual({ reviewItemId: first.reviewItemId, created: false });
    expect(await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, first.reviewItemId))).toEqual(rows);
    expect(await owned.db.select().from(qualityActionGroups)).toEqual(groupBefore);
  });
  it("rejects changed body at the same key and leaves the original snapshot intact", async () => {
    const input = finding(randomUUID());
    const first = await writeQualityFinding(owned.db, input);
    const before = await owned.db.select().from(qualityOccurrences);
    await expect(writeQualityFinding(owned.db, { ...input, occurrence: { ...input.occurrence, source: { ...source, inputHash: "cd".repeat(32) } } })).rejects.toMatchObject({ status: 409, message: "quality_occurrence_conflict" });
    expect(await owned.db.select().from(qualityOccurrences)).toEqual(before);
    expect(first.created).toBe(true);
  });
  it("keeps next attempt separate, advances linked action snapshot, and never resets group usage", async () => {
    const input = finding(randomUUID());
    const first = await writeQualityFinding(owned.db, input);
    const [original] = await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, first.reviewItemId));
    expect(original).toBeDefined();
    await owned.db.update(qualityActions).set({ occurrenceIds: [original.id] }).where(eq(qualityActions.id, f.actionId));
    const [actionBefore] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
    const groupsBefore = await owned.db.select().from(qualityActionGroups);
    const [next] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: source.issueId, executionEpoch: 2 }).returning();
    const result = await writeQualityFinding(owned.db, finding(input.targetId, { ...source, heartbeatRunId: next.id, executionEpoch: 2 }));
    expect(result).toEqual({ reviewItemId: first.reviewItemId, created: false });
    const rows = await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, first.reviewItemId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === original.id)).toEqual(original);
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, f.actionId));
    expect(action.revision).toBe(actionBefore.revision + 1);
    expect(action.occurrenceIds.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(action.target).toEqual(actionBefore.target);
    expect(action.effect).toEqual(actionBefore.effect);
    expect(await owned.db.select().from(qualityActionGroups)).toEqual(groupsBefore);
  });
  it("serializes concurrent submissions into one occurrence and one open review", async () => {
    const input = finding(randomUUID());
    const results = await Promise.all(Array.from({ length: 3 }, () => writeQualityFinding(owned.db, input)));
    expect(new Set(results.map((r) => r.reviewItemId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, results[0].reviewItemId))).toHaveLength(1);
  });
  it("rejects foreign producer/source with no partial review or occurrence", async () => {
    const reviews = await owned.db.select().from(qualityReviewItems);
    const occurrences = await owned.db.select().from(qualityOccurrences);
    const input = finding(randomUUID(), { ...source, companyId: f.otherCompanyId });
    await expect(writeQualityFinding(owned.db, input)).rejects.toMatchObject({ message: "quality_scope_company_mismatch" });
    expect(await owned.db.select().from(qualityReviewItems)).toEqual(reviews);
    expect(await owned.db.select().from(qualityOccurrences)).toEqual(occurrences);
  });
});
