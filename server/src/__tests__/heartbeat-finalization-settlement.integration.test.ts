import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureFinalization, recordStage } from "../services/heartbeat-finalization/finalization-state.js";
import { observeQuiescenceProof } from "../services/heartbeat-finalization/quiescence-probe.js";
import { settleRunIfReady } from "../services/heartbeat-finalization/settlement.js";
import { STAGE_CLASS, Q_STAGE, C_STAGE } from "../services/heartbeat-finalization/stage-classifier.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip settlement tests: ${support.reason ?? "unsupported"}`);

async function seedRun(db: ReturnType<typeof createDb>, companyId: string, agentId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const issueId = (overrides.issueId as string | undefined) ?? randomUUID();
  await db.insert(issues).values({ id: issueId, companyId, title: "Settle issue" });
  await db.insert(heartbeatRuns).values({
    id, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
    executionScopeKind: "issue_nonworkflow", finalizationVersion: 1, executionEpoch: 0,
    executionToken: randomUUID(), executorOwnerId: "default", executorOwnerLeaseEpoch: 1,
    executorOwnerLeaseToken: randomUUID(), executorOwnerReleasedAt: new Date(),
    terminalOutcome: "succeeded", terminalDecisionSource: "adapter_success",
    processPid: null, issueId, ...overrides,
  } as never);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
  return run!;
}

describeEP("heartbeat finalization v1 settlement gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-settlement-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SettleCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Settle agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  });
  afterAll(() => { tempDb = null; });

  it("settles exactly once when all Q stages are positively observed and all C stages done", async () => {
    const run = await seedRun(db, companyId, agentId);
    const fin = await ensureFinalization(db, run, new Date());
    const now = new Date();
    for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped]) {
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: kind, idempotencyKey: `q:${kind}`, state: "done" });
    }
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "done" });

    const first = await settleRunIfReady(db, run, now);
    expect(first).toBe("settled");
    const after1 = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(after1.settledAt).toBeTruthy();

    // idempotent: re-run does not change settled_at or outcome
    const second = await settleRunIfReady(db, run, new Date(now.getTime() + 1000));
    expect(second).toBe("not_ready");
    const after2 = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(after2.settledAt).toEqual(after1.settledAt);
  });

  it("does not settle while a Q stage lacks positive observation", async () => {
    const run = await seedRun(db, companyId, agentId);
    const fin = await ensureFinalization(db, run, new Date());
    // only record ONE Q stage done; leave the others unstarted
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: Q_STAGE.executorQuiescence, idempotencyKey: "q:exec", state: "done" });
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "done" });

    const outcome = await settleRunIfReady(db, run, new Date());
    expect(outcome).toBe("not_ready");
    const row = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(row.settledAt).toBeNull();
  });

  it("never settles (blocked_noncompensable) once a Q stage is dead-lettered, even after other stages complete", async () => {
    const run = await seedRun(db, companyId, agentId);
    const fin = await ensureFinalization(db, run, new Date());
    const now = new Date();
    // dead-letter one Q stage (unrecoverable non-compensable failure)
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: Q_STAGE.executorQuiescence, idempotencyKey: "q:exec", state: "dead_letter" });
    // complete every OTHER mandatory stage
    for (const kind of [Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped]) {
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: kind, idempotencyKey: `q:${kind}`, state: "done" });
    }
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "done" });

    const first = await settleRunIfReady(db, run, now);
    expect(first).toBe("blocked_noncompensable");
    // re-call after a delay: still permanently blocked, settled_at never set
    const second = await settleRunIfReady(db, run, new Date(now.getTime() + 60_000));
    expect(second).toBe("blocked_noncompensable");
    const row = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(row.settledAt).toBeNull();
    const finRow = await db.select({ state: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(finRow).toBeTruthy();
  });

  it("accepts a compensable (C) equivalent_failed but never lets compensation satisfy a Q stage", async () => {
    const run = await seedRun(db, companyId, agentId);
    const fin = await ensureFinalization(db, run, new Date());
    for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped]) {
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: kind, idempotencyKey: `q:${kind}`, state: "done" });
    }
    // C stage compensated via equivalent structured failure -> acceptable
    await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "equivalent_failed" });
    const outcome = await settleRunIfReady(db, run, new Date());
    expect(outcome).toBe("settled");
  });

  it("quiescence probe returns null until the owner capability is released", async () => {
    const run = await seedRun(db, companyId, agentId, { executorOwnerReleasedAt: null });
    const proof = await observeQuiescenceProof(db, run);
    expect(proof).toBeNull();
    await db.update(heartbeatRuns).set({ executorOwnerReleasedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    const reloaded = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    const proof2 = await observeQuiescenceProof(db, reloaded);
    expect(proof2).not.toBeNull();
    expect(proof2!.checks[Q_STAGE.executorQuiescence]).toBe(true);
  });

  it("settles a stale queued v1 run so it no longer occupies agent capacity", async () => {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const staleAt = new Date("2026-03-19T00:00:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "queued",
      runId,
      requestedAt: staleAt,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      executionScopeKind: "legacy",
      finalizationVersion: 1,
      executionEpoch: 0,
      executionToken: randomUUID(),
      executorOwnerId: "default",
      executorOwnerLeaseEpoch: 1,
      executorOwnerLeaseToken: randomUUID(),
      createdAt: staleAt,
      updatedAt: staleAt,
    } as never);

    const result = await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 5 * 60 * 1000 });
    expect(result.runIds).toContain(runId);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("stale_queued");
    expect(run?.settledAt).not.toBeNull();
  });
});
