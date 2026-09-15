// server/src/__tests__/quality-native-reconcile.test.ts
//
// [purpose] T4 native 재조정: pending 정식 실행 복구(같은 delivery 함수), terminal run 은
// 결과만 읽고 재실행 없음, 회사별 policy batch + 개별 실패 격리, ownership 필터.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  qualityActions,
  qualityPolicyVersions,
  workflowRuns,
} from "@paperclipai/db";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { reconcileQualityIntents } from "../services/quality/native-reconcile.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";

const OWNERSHIP = "native-active-plugin-disabled";

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

describeQualityDb("Quality native reconcile", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t4-reconcile-"));
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

  async function seedBound(db: typeof owned.db) {
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    return { seeded, binding };
  }

  it("recovers a pending canonical run through the same delivery function after a lost wake", async () => {
    const db = owned.db;
    const { seeded, binding } = await seedBound(db);
    const result = await reconcileQualityIntents(db, { ownership: OWNERSHIP, now: new Date() });
    expect(result.visited).toBeGreaterThanOrEqual(1);
    expect(result.accepted).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:${binding.stepRunId}:g0:a1`)));
    expect(row).toBeDefined();
    expect((row!.qualityAcceptance as Record<string, unknown> | null)).not.toBeNull();
  });

  it("reads a terminal run without re-executing it", async () => {
    const db = owned.db;
    const { seeded, binding } = await seedBound(db);
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() })
      .where(and(eq(workflowRuns.companyId, seeded.companyId), eq(workflowRuns.id, binding.workflowRunId)));
    const before = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, seeded.companyId));
    const result = await reconcileQualityIntents(db, { ownership: OWNERSHIP, now: new Date() });
    expect(result.visited).toBeGreaterThanOrEqual(1);
    const after = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, seeded.companyId));
    expect(after).toHaveLength(before.length);
    const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns)
      .where(eq(workflowRuns.id, binding.workflowRunId));
    expect(run!.status).toBe("failed");
  });

  it("isolates per-company failures and still processes the healthy company", async () => {
    const db = owned.db;
    const healthy = await seedBound(db);
    const broken = await seedBound(db);
    // broken 회사: batch 필터(nativeOwnership·기간)는 통과하지만 정의 나머지가 비정형이라
    // 전달 중 예외가 발생한다(회사·조치 단위 격리 검증). 저장 jsonb 는 런타임까지 완전성이
    // 보장되지 않으므로 DB 경계에서 타입 없는 값으로 기록해 비정형 픽스처 의도를 재현한다.
    await db.update(qualityPolicyVersions).set({
      definition: sql`${JSON.stringify({
        nativeOwnership: OWNERSHIP,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 3_600_000).toISOString(),
      })}::jsonb`,
    }).where(and(eq(qualityPolicyVersions.companyId, broken.seeded.companyId), eq(qualityPolicyVersions.id, broken.seeded.policyVersionId)));
    const result = await reconcileQualityIntents(db, { ownership: OWNERSHIP, now: new Date() });
    expect(result.visited).toBeGreaterThanOrEqual(2);
    expect(result.accepted).toBeGreaterThanOrEqual(1);
    expect(result.blocked).toBeGreaterThanOrEqual(1);
    const [healthyRow] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, healthy.seeded.companyId), eq(agentWakeupRequests.idempotencyKey, `quality-action-wake:${healthy.seeded.actionId}:${healthy.binding.stepRunId}:g0:a1`)));
    expect(healthyRow).toBeDefined();
  });

  it("visits nothing when the ownership filter does not match the active policy", async () => {
    const db = owned.db;
    await seedBound(db);
    const result = await reconcileQualityIntents(db, { ownership: "other-ownership", now: new Date() });
    expect(result).toEqual({ visited: 0, accepted: 0, blocked: 0 });
  });

  it("skips cancelled intents during reconciliation", async () => {
    const db = owned.db;
    const { seeded } = await seedBound(db);
    await db.update(qualityActions).set({ cancelRequestedAt: new Date() })
      .where(and(eq(qualityActions.companyId, seeded.companyId), eq(qualityActions.id, seeded.actionId)));
    const result = await reconcileQualityIntents(db, { ownership: OWNERSHIP, now: new Date() });
    const rows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${seeded.actionId}:%`)));
    expect(rows).toHaveLength(0);
  });
});
