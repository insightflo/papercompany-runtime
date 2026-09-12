// server/src/__tests__/quality-native-delivery-current-output.test.ts
//
// [purpose] T4 fix(current_output 전달 경로): repair_supported_output 조치가 binding 이
//   가리키는 원본 실행의 QA 단계로 실제 admission 까지 전달되는지, 그리고 브리프 RED
//   '원본 시도 변경'(binding 후 원본 시도 A→B 교체)이 수락 없이 거부되는지를 검사한다.
//   qa_addendum 용 quality-execute 요구 때문에 current_output 이 항상 blocked 되던
//   결함(I-1)과 binding 재사용 경로의 원본 시도 미재검증(I-2)을 고정한다.

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
  workflowStepRuns,
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
import { qualityWakeKey } from "../services/quality/native-wake.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

describeQualityDb("Quality native delivery (current_output)", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t4-co-deliver-"));
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

  /** 진행 중 원본 + request_changes verdict + current_output 조치를 실제 행으로 만든다. */
  async function seedCurrentOutputAction(): Promise<{ seeded: QualityFixture; seed: CurrentOutputSeed; actionId: string; intentKey: string }> {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const artifactUrl = path.join(home, "co-delivery", `index-${randomUUID().slice(0, 6)}.html`);
    const seed = await seedCurrentOutputScenario(db, {
      companyId: seeded.companyId, authorAgentId: seeded.authorAgentId, verifierAgentId: seeded.verifierAgentId,
      artifactUrl, remediations: { items: [{ op: "string_replace", file: artifactUrl, find: "a", replace: "b" }] },
    });
    const source = seed.source as SourceAttempt;
    const actionId = randomUUID();
    const intentKey = `co-deliver-${actionId.slice(0, 8)}`;
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
    return { seeded, seed, actionId, intentKey };
  }

  it("delivers a current_output repair through the bound source QA step with a real acceptance receipt", async () => {
    const db = owned.db;
    const { seeded, seed, actionId, intentKey } = await seedCurrentOutputAction();
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId });
    expect(result.status).toBe("accepted");
    expect(result.receiptId).not.toBeNull();
    const key = qualityWakeKey({ actionId, stepRunId: seed.qaStepRunId, generation: 1, attempt: 1 });
    const [row] = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    expect(row).toBeDefined();
    expect(row!.id).toBe(result.receiptId);
    const acc = row!.qualityAcceptance as Record<string, unknown>;
    expect(acc.intentKey).toBe(intentKey);
    expect(acc.inputHash).toBe("ab".repeat(32));
    expect(acc.issueId).toBe(seed.qaIssueId);
    expect(acc.stepRunId).toBe(seed.qaStepRunId);
    expect(acc.workflowRunId).toBe(seed.workflowRunId);
    expect(acc.generation).toBe(1);
    expect(acc.agentId).toBe(seeded.verifierAgentId);
    expect(acc.attempt).toBe(1);
    expect(acc.heartbeatRunId).toBe(row!.runId);
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, seed.qaIssueId));
    expect(qaIssue!.status).toBe("in_progress");
    expect(qaIssue!.executionRunId).toBe(row!.runId);
  });

  it("refuses delivery when the original source attempt changed after binding (원본 시도 변경)", async () => {
    const db = owned.db;
    const { seeded, seed, actionId } = await seedCurrentOutputAction();
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId });
    expect(binding.stepRunId).toBe(seed.qaStepRunId);
    // 원본 시도 A(producer generation 1) → B(generation 2) 교체: 승인된 적 없는 새 시도다.
    await db.update(workflowStepRuns).set({ executionGeneration: 2 })
      .where(and(eq(workflowStepRuns.workflowRunId, seed.workflowRunId), eq(workflowStepRuns.id, seed.producerStepRunId)));
    const result = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId });
    expect(result).toEqual({ status: "blocked", receiptId: null });
    // 새 수락·실행 없음: quality wake 행 0개, QA 이슈에 새 heartbeat run 0개(seed verdict 제외).
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${actionId}:%`)));
    expect(wakes).toHaveLength(0);
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, seeded.companyId), eq(heartbeatRuns.issueId, seed.qaIssueId)));
    expect(runs.map((run) => run.id)).toEqual([seed.verdictHeartbeatId]);
    const [action] = await db.select({ b: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, seeded.companyId), eq(qualityActions.id, actionId)));
    expect(action!.b).toEqual(binding);
  });
});
