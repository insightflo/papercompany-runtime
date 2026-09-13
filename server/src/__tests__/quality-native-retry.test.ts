// server/src/__tests__/quality-native-retry.test.ts
//
// [purpose] T4 유한 재시도: 기존 step retry tx 안에서 group+policy 사용량 예약과
// generation CAS 확정(전역 finalization flag 무관), 한도 초과 거절과 원본 불변,
// stale generation CAS 거부 시 예약 없음, 새 기술 시도의 새 quality wake 키.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  qualityActionGroups,
  qualityPolicyUsage,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { qualityWakeKey } from "../services/quality/native-wake.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "../services/workflow/retry-launch-dispatch.js";

describeQualityDb("Quality native bounded retry", () => {
  let owned: QualityTestDb;

  beforeAll(async () => {
    owned = await createQualityTestDb();
  }, 180_000);
  afterAll(async () => { await owned?.close(); });

  type Seeded = { companyId: string; actionId: string; stepRunId: string; workflowRunId: string; groupId: string; policyVersionId: string };

  /** bound 상태의 quality step 을 실패 상태로 만든다(원본 시도가 실행된 뒤의 스냅숏). */
  async function seedFailedQualityStep(db: Db): Promise<Seeded> {
    const seeded = await seedQualityFixture(db);
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const failedAt = new Date();
    await db.update(workflowStepRuns).set({
      status: "failed", retryCount: 0, completedAt: failedAt, startedAt: failedAt,
      lastDispatchRequestId: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: failedAt, lastDispatchErrorSummary: "adapter failed",
      metadata: { qualityActionId: seeded.actionId }, executionGeneration: 2,
    }).where(eq(workflowStepRuns.id, binding.stepRunId));
    await db.update(workflowRuns).set({ status: "failed", completedAt: failedAt })
      .where(eq(workflowRuns.id, binding.workflowRunId));
    return {
      companyId: seeded.companyId, actionId: seeded.actionId, stepRunId: binding.stepRunId,
      workflowRunId: binding.workflowRunId, groupId: seeded.groupId, policyVersionId: seeded.policyVersionId,
    };
  }

  /** 관측 스냅숏을 실제 행과 일치시킨 retry 입력. */
  async function retryInput(db: Db, s: Seeded, overrides: Record<string, unknown> = {}) {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    return {
      companyId: s.companyId, workflowRunId: s.workflowRunId, stepRunId: s.stepRunId,
      retryNumber: 1, maxRetries: 3, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0,
      observedCompletedAt: row!.completedAt, observedLastDispatchRequestId: null,
      observedMetadataSnapshot: row!.metadata as Record<string, unknown>,
      errorSummary: "adapter failed", observedExecutionGeneration: 2,
      ...overrides,
    };
  }

  it("reserves group and policy usage and finalizes the generation CAS inside the retry transaction", async () => {
    const db = owned.db;
    const s = await seedFailedQualityStep(db);
    const result = await scheduleWorkflowStepRetry(db, await retryInput(db, s));
    expect(result.result).toBe("scheduled");
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(after!.status).toBe("pending");
    expect(after!.retryCount).toBe(1);
    expect(after!.executionGeneration).toBe(3);
    const [usage] = await db.select().from(qualityPolicyUsage)
      .where(and(eq(qualityPolicyUsage.companyId, s.companyId), eq(qualityPolicyUsage.policyVersionId, s.policyVersionId)));
    expect(usage).toBeDefined();
    expect(usage!.executionAttempts).toBeGreaterThanOrEqual(1);
    const [group] = await db.select().from(qualityActionGroups)
      .where(and(eq(qualityActionGroups.companyId, s.companyId), eq(qualityActionGroups.id, s.groupId)));
    expect(((group!.usage as Record<string, unknown>) ?? {}).executionAttempts).toBeGreaterThanOrEqual(1);
  });

  it("rejects the retry when execution attempts are exhausted and leaves the step unchanged", async () => {
    const db = owned.db;
    const s = await seedFailedQualityStep(db);
    await db.insert(qualityPolicyUsage).values({
      companyId: s.companyId, policyVersionId: s.policyVersionId,
      windowStart: new Date(Date.now() - 60_000), windowEnd: new Date(Date.now() + 3_600_000),
      reservedCostCents: 0, chargedCostCents: 0, executionAttempts: 4, revision: 1,
    });
    await expect(scheduleWorkflowStepRetry(db, await retryInput(db, s)))
      .rejects.toThrow(/quality_execution_attempts_exhausted/);
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(after!.status).toBe("failed");
    expect(after!.retryCount).toBe(0);
    const events = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId), eq(workflowTransitionEvents.eventType, "workflow_step_retry_scheduled")));
    expect(events).toHaveLength(0);
  });

  it("returns already_changed without reserving usage when the generation CAS is stale", async () => {
    const db = owned.db;
    const s = await seedFailedQualityStep(db);
    const result = await scheduleWorkflowStepRetry(db, await retryInput(db, s, { observedExecutionGeneration: 99 }));
    expect(result.result).toBe("already_changed");
    const [usage] = await db.select().from(qualityPolicyUsage)
      .where(and(eq(qualityPolicyUsage.companyId, s.companyId), eq(qualityPolicyUsage.policyVersionId, s.policyVersionId)));
    expect(usage).toBeUndefined();
  });

  it("dispatches a new technical attempt under a fresh quality wake key, not the generic retry key", async () => {
    const db = owned.db;
    const s = await seedFailedQualityStep(db);
    const scheduled = await scheduleWorkflowStepRetry(db, await retryInput(db, s));
    expect(scheduled.result).toBe("scheduled");
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(after!.executionGeneration).toBe(3);
    const wakeSpy = vi.fn().mockResolvedValue(true);
    await wakeIssueBackedRetryAndMarkDispatching({
      db, companyId: s.companyId, workflowRunId: s.workflowRunId,
      definition: { id: "def" }, run: { id: s.workflowRunId }, step: { id: "quality-execute" },
      stepRunId: s.stepRunId, stepRunMetadata: after!.metadata, issueId: randomUUID(),
      observedRetryCount: 0, resumeExistingIssue: false,
      wakeExistingWorkflowStepIssue: wakeSpy,
    } as unknown as Parameters<typeof wakeIssueBackedRetryAndMarkDispatching>[0]);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    const usedKey = wakeSpy.mock.calls[0]![0].idempotencyKey as string;
    expect(usedKey).toBe(qualityWakeKey({ actionId: s.actionId, stepRunId: s.stepRunId, generation: 3, attempt: 1 }));
    expect(usedKey.startsWith("workflow-step-retry:")).toBe(false);
  });
});
