// server/src/__tests__/quality-native-delivery.test.ts
//
// [purpose] T4 실제 실행 전달: qualityWakeKey 계약, 실제 admission tx 수락 영수증,
// 빠른 완료 후 재전송 멱등, 같은 의도 동시 전달, native ownership 부재, 실행 직전 정의
// 해시 재검증, working.md 지연 자가복구, 다중 QA binding 첫 적격 채택.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  qualityActions,
  qualityPolicyVersions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import type { SourceAttempt } from "@paperclipai/shared";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { reviewItemForAction, seedCurrentOutputScenario, type CurrentOutputSeed } from "./helpers/quality-proofs.js";
import { hashContract } from "../services/quality/contract.js";
import { ensureMissionWorkingNote, resolveMissionWorkingNotePath } from "../services/missions/mission-working-note.js";
import { qualityWakeKey } from "../services/quality/native-wake.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

describeQualityDb("Quality native delivery", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t4-deliver-"));
    process.env.PAPERCLIP_HOME = home;
    executeSpy.mockResolvedValue(successfulAdapterResult());
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    await owned.db.update(agents).set({
      adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {},
    }).where(eq(agents.companyId, f.companyId));
  }, 180_000);
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await owned?.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("keeps transport redelivery on the exact same attempt key", () => {
    const x = { actionId: "a", stepRunId: "s", generation: 2, attempt: 1 };
    expect(qualityWakeKey(x)).toBe("quality-action-wake:a:s:g2:a1");
    expect(qualityWakeKey({ ...x, attempt: 2 })).not.toBe(qualityWakeKey(x));
    expect(() => qualityWakeKey({ ...x, attempt: 0 })).toThrow("quality_invalid_attempt");
    expect(() => qualityWakeKey({ ...x, generation: -1 })).toThrow("quality_invalid_attempt");
    expect(() => qualityWakeKey({ ...x, generation: 1.5 })).toThrow("quality_invalid_attempt");
  });

  it("accepts through the real admission transaction and records the acceptance receipt", async () => {
    const db = owned.db;
    const result = await deliverQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    expect(result.status).toBe("accepted");
    expect(result.receiptId).not.toBeNull();
    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, f.companyId), eq(qualityActions.id, f.actionId)));
    const binding = action!.canonicalBinding!;
    const key = qualityWakeKey({ actionId: f.actionId, stepRunId: binding.stepRunId, generation: 0, attempt: 1 });
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(row).toBeDefined();
    expect(["queued", "claimed"]).toContain(row!.status);
    expect(row!.runId).not.toBeNull();
    expect(row!.id).toBe(result.receiptId);
    const acc = row!.qualityAcceptance as Record<string, unknown>;
    expect(acc.intentKey).toBe(f.intentKey);
    expect(acc.inputHash).toBe("33".repeat(32));
    expect(acc.issueId).toBe(binding.issueId);
    expect(acc.stepRunId).toBe(binding.stepRunId);
    expect(acc.generation).toBe(0);
    expect(acc.agentId).toBe(f.authorAgentId);
    expect(acc.attempt).toBe(1);
    expect(acc.heartbeatRunId).toBe(row!.runId);
    expect(acc.acceptedAt).toBeTruthy();
    const [issue] = await db.select().from(issues).where(eq(issues.id, binding.issueId));
    expect(issue!.status).toBe("in_progress");
    expect(issue!.executionRunId).toBe(row!.runId);
    const events = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, f.companyId), eq(workflowTransitionEvents.eventType, "queue_accepted")));
    expect(events.some((e) => e.wakeupRequestId === row!.id)).toBe(true);
  });

  it("returns the same accepted receipt when the process finished before the caller saw the response", async () => {
    const db = owned.db;
    const first = await deliverQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, f.companyId), eq(qualityActions.id, f.actionId)));
    const binding = action!.canonicalBinding!;
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.idempotencyKey, qualityWakeKey({ actionId: f.actionId, stepRunId: binding.stepRunId, generation: 0, attempt: 1 }))));
    for (let i = 0; i < 150; i++) {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row!.runId!));
      if (run && run.status !== "queued" && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [runAfter] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row!.runId!));
    expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(runAfter!.status);
    const again = await deliverQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    expect(again).toEqual({ status: "accepted", receiptId: first.receiptId });
    const wakeRunId = row?.runId;
    // 영수 확인 쿼리는 구체 runId 가 있어야만 의미가 있다. null 이면 테스트를 실패로 종결한다
    // (null 로 조회해 우연히 통과하는 약화를 막는 런타임 음성 검사).
    if (!wakeRunId) throw new Error("quality wake must carry a concrete runId");
    const rows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.runId, wakeRunId)));
    expect(rows).toHaveLength(1);
  });

  it("keeps concurrent delivery of the same intent to one canonical execution and one receipt", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    // 경합 중 실행이 계속 살아 있도록 어댑터 완료를 지연시킨다(실패 종착과 무관하게
    // 동시 전달 자체의 멱등을 검증한다). 해제 함수는 mockImplementation 콜백 안에서만
    // 대입되므로 항상 호출 가능한 홀더로 관리한다(초기값 no-op, 미시작 시 호출 무해).
    const releaseGate: { release: () => void } = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { releaseGate.release = () => resolve(successfulAdapterResult()); }));
    try {
      const [a, b] = await Promise.all([
        deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId }),
        deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId }),
      ]);
      expect(a.status).toBe("accepted");
      expect(b.status).toBe("accepted");
      expect(a.receiptId).toBe(b.receiptId);
      const wakeRows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:%`)));
      expect(wakeRows).toHaveLength(1);
    } finally {
      releaseGate.release();
      executeSpy.mockResolvedValue(successfulAdapterResult());
    }
  });

  it("blocks delivery when the policy has no active native ownership", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(qualityPolicyVersions).set({ disabledAt: new Date() })
      .where(and(eq(qualityPolicyVersions.companyId, seeded.companyId), eq(qualityPolicyVersions.id, seeded.policyVersionId)));
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(result).toEqual({ status: "blocked", receiptId: null });
    const rows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:%`)));
    expect(rows).toHaveLength(0);
  });

  it("re-verifies the native definition hash just before execution and blocks a tampered definition", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const first = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(first.status).toBe("accepted");
    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, seeded.companyId), eq(qualityActions.id, seeded.actionId)));
    const binding = action!.canonicalBinding!;
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, binding.workflowRunId));
    await db.update(workflowDefinitions)
      .set({ stepsJson: [{ id: "tampered", name: "x", dependencies: [] }] })
      .where(eq(workflowDefinitions.id, run!.workflowId));
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(result.status).toBe("blocked");
    const wakeRows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:%`)));
    expect(wakeRows).toHaveLength(1);
    const [stillBound] = await db.select({ binding: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, seeded.companyId), eq(qualityActions.id, seeded.actionId)));
    expect(stillBound!.binding).toEqual(binding);
  });

  it("provisions the quality mission working note lazily and idempotently after binding", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const notePath = resolveMissionWorkingNotePath({ companyId: seeded.companyId, missionId: binding.missionId });
    await expect(readFile(notePath, "utf8")).rejects.toThrow();
    const ctx = await ensureMissionWorkingNote({ companyId: seeded.companyId, missionId: binding.missionId });
    expect(ctx.available).toBe(true);
    expect(ctx.path).toBe(notePath);
    const first = await readFile(notePath, "utf8");
    const again = await ensureMissionWorkingNote({ companyId: seeded.companyId, missionId: binding.missionId });
    expect(again.path).toBe(notePath);
    expect(await readFile(notePath, "utf8")).toBe(first);
  });

  it("binds the first qualified QA verdict, not the first verdict, when several QA runs requested changes", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const artifactUrl = path.join(home, "multi-qa", "index.html");
    const seed: CurrentOutputSeed = await seedCurrentOutputScenario(db, {
      companyId: seeded.companyId, authorAgentId: seeded.authorAgentId, verifierAgentId: seeded.verifierAgentId,
      artifactUrl, remediations: { items: [{ op: "string_replace", file: artifactUrl, find: "a", replace: "b" }] },
    });
    const earlierAt = new Date(Date.now() - 120_000);
    const [qa1Issue] = await db.insert(issues).values({
      companyId: seeded.companyId, missionId: seed.missionId, title: "[QA] earlier",
      status: "todo", assigneeAgentId: seeded.verifierAgentId,
    }).returning();
    const [qa1Run] = await db.insert(workflowStepRuns).values({
      workflowRunId: seed.workflowRunId, stepId: "qa-earlier", issueId: qa1Issue!.id,
      status: "failed", completedAt: earlierAt, executionGeneration: 1,
    }).returning();
    const [qa1Heartbeat] = await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId, agentId: seeded.verifierAgentId, issueId: qa1Issue!.id,
      executionEpoch: 1, status: "succeeded", startedAt: earlierAt, finishedAt: earlierAt, createdAt: earlierAt,
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId: seeded.companyId, missionId: seed.missionId, workflowRunId: seed.workflowRunId,
      workflowStepRunId: qa1Run!.id, issueId: qa1Issue!.id, heartbeatRunId: qa1Heartbeat!.id,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "request_changes",
      decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `verdict:${qa1Run!.id}:${qa1Heartbeat!.id}`,
      payload: { remediations: { wrong: true } }, createdAt: earlierAt,
    });
    const source = seed.source as SourceAttempt;
    const actionId = randomUUID();
    const intentKey = `co-${actionId.slice(0, 8)}`;
    const target = { kind: "current_output" as const, source };
    const effect = { kind: "repair_supported_output" as const, target };
    const { occurrenceId } = await reviewItemForAction(db, seeded.companyId, source, source.heartbeatRunId);
    await db.insert(qualityActions).values({
      id: actionId, companyId: seeded.companyId, groupId: seeded.groupId, kind: "current_output",
      occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId],
      policyVersionId: seeded.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target),
        maxExecutorAttempts: 2, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: seeded.groupId, policyVersionId: seeded.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId });
    expect(binding.stepRunId).toBe(seed.qaStepRunId);
    expect(binding.stepRunId).not.toBe(qa1Run!.id);
  });
});
