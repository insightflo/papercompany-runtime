// server/src/__tests__/quality-native-admission.test.ts
//
// [purpose] T4 공통 admission 병합 규칙: 다른 agent ID/동명 agent 실행과 병합 금지,
// generic wake 의 quality 행 병합 금지, 거절(skipped) 행은 acceptance 없음,
// paused 대기 행의 승격 시점 수락 기록.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
} from "@paperclipai/db";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { qualityWakeKey } from "../services/quality/native-wake.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { heartbeatService } from "../services/heartbeat.js";

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

describeQualityDb("Quality native admission", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t4-admit-"));
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

  async function holdIssueWithRun(input: { issueId: string; agentId: string; agentName: string }) {
    // 이슈는 여전히 todo(깨우기 가능)지만 실행 lock(executionRunId)을 다른 실행이 점유한다.
    const [run] = await owned.db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: input.agentId, issueId: input.issueId,
      invocationSource: "assignment", status: "running", startedAt: new Date(),
    }).returning();
    await owned.db.update(issues).set({
      executionRunId: run!.id, executionAgentNameKey: input.agentName, executionLockedAt: new Date(),
    }).where(eq(issues.id, input.issueId));
    return run!.id;
  }

  it("defers instead of merging when a different agent id holds the issue execution lock", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const [other] = await db.insert(agents).values({ id: randomUUID(), companyId: seeded.companyId, name: "Other Holder Agent" }).returning();
    await holdIssueWithRun({ issueId: binding.issueId, agentId: other!.id, agentName: "Other Holder Agent" });
    // 다른 실행이 lock 를 점유한 상태에서 첫 전달과 같은 attempt 재전송 — 별도 대기로 격리되고 행은 하나다.
    const first = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(first.status).toBe("waiting");
    expect(first.receiptId).not.toBeNull();
    const key = qualityWakeKey({ actionId: seeded.actionId, stepRunId: binding.stepRunId, generation: 0, attempt: 1 });
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(row!.status).toBe("deferred_issue_execution");
    expect(row!.qualityAcceptance).toBeNull();
    const again = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(again).toEqual(first);
    const rows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(rows).toHaveLength(1);
  });

  it("never coalesces a quality wake into a same-name different-id agent execution", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const [owner] = await db.select().from(agents).where(eq(agents.id, seeded.authorAgentId));
    const [twin] = await db.insert(agents).values({ companyId: seeded.companyId, name: owner!.name }).returning();
    await holdIssueWithRun({ issueId: binding.issueId, agentId: twin!.id, agentName: owner!.name });
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(result.status).toBe("waiting");
    const key = qualityWakeKey({ actionId: seeded.actionId, stepRunId: binding.stepRunId, generation: 0, attempt: 1 });
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(row).toBeDefined();
    expect(row!.status).toBe("deferred_issue_execution");
    expect(row!.qualityAcceptance).toBeNull();
    expect(row!.runId).toBeNull();
  });

  it("keeps a generic wakeup from merging into a stored quality deferred row", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const [other] = await db.insert(agents).values({ companyId: seeded.companyId, name: "Generic Holder Agent" }).returning();
    await holdIssueWithRun({ issueId: binding.issueId, agentId: other!.id, agentName: "Generic Holder Agent" });
    await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const key = qualityWakeKey({ actionId: seeded.actionId, stepRunId: binding.stepRunId, generation: 0, attempt: 1 });
    const [qualityRowBefore] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(qualityRowBefore!.status).toBe("deferred_issue_execution");
    const payloadBefore = qualityRowBefore!.payload;

    await heartbeatService(db).wakeup(seeded.authorAgentId, {
      source: "assignment", triggerDetail: "system", reason: "generic_test_wake",
      payload: { issueId: binding.issueId, mutation: "workflow_resume", missionId: binding.missionId },
      contextSnapshot: { issueId: binding.issueId, missionId: binding.missionId, source: "test" },
    });

    const [qualityRowAfter] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(qualityRowAfter!.coalescedCount).toBe(0);
    expect(qualityRowAfter!.payload).toEqual(payloadBefore);
    const issueRows = await db.select({ id: agentWakeupRequests.id, key: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, binding.issueId));
    expect(issueRows.filter((r) => r.key === null || !r.key.startsWith("quality-action-wake:")).length).toBeGreaterThan(0);
  });

  it("writes no acceptance for a refused (skipped) delivery", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({
      adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {},
    }).where(eq(agents.companyId, seeded.companyId));
    await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.authorAgentId));
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(result).toEqual({ status: "blocked", receiptId: null });
    const rows = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:%`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.qualityAcceptance).toBeNull();
  });

  it("records acceptance only when a paused agent's queued wakeup is promoted to a run", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({
      adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {},
    }).where(eq(agents.companyId, seeded.companyId));
    await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    await db.update(agents).set({ status: "paused", pauseReason: "reauth_required", pausedAt: new Date() })
      .where(eq(agents.id, seeded.authorAgentId));
    const waiting = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(waiting.status).toBe("waiting");
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.status, "queued")));
    expect(row).toBeDefined();
    expect(row!.runId).toBeNull();
    expect(row!.qualityAcceptance).toBeNull();

    await db.update(agents).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(agents.id, seeded.authorAgentId));
    await heartbeatService(db).resumeQueuedRuns(seeded.authorAgentId);
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row!.id));
    expect(promoted!.runId).not.toBeNull();
    const acc = promoted!.qualityAcceptance as Record<string, unknown> | null;
    expect(acc).not.toBeNull();
    expect(acc!.heartbeatRunId).toBe(promoted!.runId);
    expect(acc!.attempt).toBe(1);
    const accepted = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(accepted).toEqual({ status: "accepted", receiptId: promoted!.id });
  });
});
