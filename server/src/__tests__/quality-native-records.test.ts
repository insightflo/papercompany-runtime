// server/src/__tests__/quality-native-records.test.ts
//
// [purpose] T3 정식 실행 연결의 원자성·감사·깨우기 0회·정의 불변 검증.
// 브리프가 지정한 rollback 테스트를 그대로 포함한다.

import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  issues,
  missionAgents,
  missionPlanArtifacts,
  qualityActions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { countWakeups, readCanonicalCounts } from "./helpers/quality-proofs.js";
import {
  createCanonicalQualityExecutionInTransaction,
  ensureCanonicalQualityExecution,
} from "../services/quality/native-records.js";
import { workflowService } from "../services/workflow/engine.js";

describeQualityDb("Quality canonical native records", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); });

  it("rolls back the entire canonical creation when the caller crashes before commit", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    // QualityKey 는 strict 스키마(T1) — 브리프 스니펫처럼 fixture 전체가 아니라 정확히
    // {companyId, actionId} 두 필드만 넘긴다.
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    const before = await readCanonicalCounts(db, key.companyId);
    await expect(db.transaction(async tx => {
      await createCanonicalQualityExecutionInTransaction(tx, key);
      throw new Error('crash-before-commit');
    })).rejects.toThrow('crash-before-commit');
    expect(await readCanonicalCounts(db, key.companyId)).toEqual(before);
    const [a, b] = await Promise.all([
      ensureCanonicalQualityExecution(db, key), ensureCanonicalQualityExecution(db, key),
    ]);
    expect(a).toEqual(b);
  });

  it("binds mission/run/step/issue, audit row, and definition in one commit with zero wake requests", async () => {
    const db = owned.db;
    const key = { companyId: f.companyId, actionId: f.actionId };
    const before = await readCanonicalCounts(db, f.companyId);
    const wakeBefore = await countWakeups(db, f.companyId);
    const binding = await ensureCanonicalQualityExecution(db, key);
    expect(binding.companyId).toBe(f.companyId);
    expect(binding.actionId).toBe(f.actionId);
    const after = await readCanonicalCounts(db, f.companyId);
    expect(after.missions).toBe(before.missions + 1);
    expect(after.missionAgents).toBe(before.missionAgents + 2);
    expect(after.oversightIssues).toBe(before.oversightIssues + 1);
    expect(after.stepIssues).toBe(before.stepIssues + 1);
    expect(after.issueCounter).toBe(before.issueCounter + 2);
    expect(after.workflowRuns).toBe(before.workflowRuns + 1);
    expect(after.workflowStepRuns).toBe(before.workflowStepRuns + 1);
    expect(after.activityLog).toBeGreaterThan(before.activityLog);
    expect(after.boundActions).toBe(before.boundActions + 1);
    // 깨우기: 호출 0회(요청 행 0개) — 실행 전달은 T4다.
    expect(await countWakeups(db, f.companyId)).toBe(wakeBefore);

    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, f.companyId), eq(qualityActions.id, f.actionId)));
    expect(action!.canonicalBinding).toEqual(binding);
    const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, f.companyId), eq(workflowRuns.id, binding.workflowRunId)));
    expect(run!.missionId).toBe(binding.missionId);
    expect(run!.status).toBe("pending");
    expect(run!.triggeredBy).toBe("quality");
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, binding.stepRunId));
    expect(stepRun!.issueId).toBe(binding.issueId);
    const [stepIssue] = await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.id, binding.issueId)));
    expect(stepIssue!.missionId).toBe(binding.missionId);
    expect(stepIssue!.identifier).not.toBeNull();
    expect(stepIssue!.identifier).toMatch(/-\d+$/);
    expect(stepIssue!.assigneeAgentId).toBe(f.authorAgentId);
    const [oversight] = await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.originKind, "mission_main_executor_oversight")));
    expect(oversight!.assigneeAgentId).toBe(f.authorAgentId);
    expect(oversight!.missionId).toBe(binding.missionId);
    const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, f.companyId), eq(workflowDefinitions.id, run!.workflowId)));
    expect(definition!.sourceKind).toBe("quality");
    expect(definition!.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(definition!.missionId).toBe(binding.missionId);
    const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, f.companyId), eq(missionPlanArtifacts.missionId, binding.missionId)));
    expect(plan!.status).toBe("active");
    const [agent] = await db.select().from(missionAgents).where(eq(missionAgents.missionId, binding.missionId));
    expect(agent).toBeDefined();
    const audits = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "quality.canonical_execution_bound")));
    expect(audits.some((row) => row.entityId === f.actionId)).toBe(true);
  });

  it("keeps the quality-owned definition immutable against generic update and delete", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    const binding = await ensureCanonicalQualityExecution(db, key);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, binding.workflowRunId));
    const definitionId = run!.workflowId;
    const before = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definitionId));
    await expect(workflowService.updateDefinition(db, definitionId, { name: "tampered" })).rejects.toMatchObject({ status: 409, message: "quality_definition_immutable" });
    await expect(workflowService.deleteDefinition(db, definitionId)).rejects.toMatchObject({ status: 409, message: "quality_definition_immutable" });
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definitionId))).toEqual(before);
  });

  it("re-verifies the definition hash right before returning an existing binding", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    const binding = await ensureCanonicalQualityExecution(db, key);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, binding.workflowRunId));
    await db.update(workflowDefinitions).set({ stepsJson: [{ id: "tampered", name: "x", dependencies: [] }] }).where(eq(workflowDefinitions.id, run!.workflowId));
    await expect(ensureCanonicalQualityExecution(db, key)).rejects.toMatchObject({ status: 409, message: "quality_definition_hash_mismatch" });
    const [stillBound] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, key.actionId), isNotNull(qualityActions.canonicalBinding)));
    expect(stillBound).toBeDefined();
  });
});
