import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  issues,
  createDb,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureFinalization, recordStage } from "../services/heartbeat-finalization/finalization-state.js";
import { observeQuiescenceProof } from "../services/heartbeat-finalization/quiescence-probe.js";
import { releaseExecutorOwnerCapability } from "../services/heartbeat-finalization/owner-capability.js";
import { settleRunIfReady } from "../services/heartbeat-finalization/settlement.js";
import { STAGE_CLASS, Q_STAGE, C_STAGE } from "../services/heartbeat-finalization/stage-classifier.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip blocker fix tests: ${support.reason ?? "unsupported"}`);

describeEP("PR #55 blocker fixes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("blocker-fixes-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "FixCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Fix agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  });
  afterAll(() => { tempDb = null; });

  async function seedV1Run(status: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    if (overrides.issueId) {
      await db.insert(issues).values({ id: overrides.issueId as string, companyId, title: "Fix issue" });
    }
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, invocationSource: "on_demand", status,
      finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerReleasedAt: null, processPid: null, ...overrides,
    } as never);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return run!;
  }

  describe("Blocker 1: normal-termination release CAS", () => {
    it("releaseExecutorOwnerCapability sets executorOwnerReleasedAt via CAS", async () => {
      const run = await seedV1Run("succeeded");
      const ok = await releaseExecutorOwnerCapability(db, run, new Date());
      expect(ok).toBe(true);
      const after = await db.select({ releasedAt: heartbeatRuns.executorOwnerReleasedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
      expect(after.releasedAt).not.toBeNull();
    });

    it("quiescence probe returns null before release and a proof after release", async () => {
      const run = await seedV1Run("succeeded");
      const beforeRelease = await observeQuiescenceProof(db, run);
      expect(beforeRelease).toBeNull();
      await releaseExecutorOwnerCapability(db, run, new Date());
      const reloaded = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
      const afterRelease = await observeQuiescenceProof(db, reloaded);
      expect(afterRelease).not.toBeNull();
      expect(afterRelease!.checks[Q_STAGE.executorQuiescence]).toBe(true);
    });

    it("release is idempotent — second call returns false (already released)", async () => {
      const run = await seedV1Run("succeeded");
      await releaseExecutorOwnerCapability(db, run, new Date());
      const reloaded = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
      const second = await releaseExecutorOwnerCapability(db, reloaded, new Date());
      expect(second).toBe(false);
    });
  });

  describe("Blocker 2: Q dead-letter fail-closed aggregation", () => {
    it("detects dead_letter even when a done row coexists for the same stageKind", async () => {
      const run = await seedV1Run("succeeded", { issueId: randomUUID() });
      const fin = await ensureFinalization(db, run, new Date());
      // Record executor_quiescence as done (idempotency key A)
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: Q_STAGE.executorQuiescence, idempotencyKey: "A", state: "done" });
      // Record executor_quiescence as dead_letter (idempotency key B) — same stageKind, different key
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: Q_STAGE.executorQuiescence, idempotencyKey: "B", state: "dead_letter" });
      // Complete the other Q + C stages
      for (const kind of [Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped]) {
        await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: kind, idempotencyKey: `q:${kind}`, state: "done" });
      }
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "done" });

      const outcome = await settleRunIfReady(db, run, new Date());
      // Must be blocked_noncompensable — the dead_letter must NOT be missed
      expect(outcome).toBe("blocked_noncompensable");
      const row = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
      expect(row.settledAt).toBeNull();
    });

    it("still settles when all Q stages are done and no dead_letter exists", async () => {
      const run = await seedV1Run("succeeded", { issueId: randomUUID() });
      const fin = await ensureFinalization(db, run, new Date());
      for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped]) {
        await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.quiescence, stageKind: kind, idempotencyKey: `q:${kind}`, state: "done" });
      }
      await recordStage(db, { companyId, runId: run.id, finalizationId: fin.id, stageClass: STAGE_CLASS.compensable, stageKind: C_STAGE.issuePromotion, idempotencyKey: "c:issue", state: "done" });
      const outcome = await settleRunIfReady(db, run, new Date());
      expect(outcome).toBe("settled");
    });
  });

  describe("Blocker 3: finalization parent uniqueness", () => {
    it("concurrent ensureFinalization calls produce exactly one parent", async () => {
      const run = await seedV1Run("succeeded");
      // Simulate two concurrent terminal hooks calling ensureFinalization
      const [a, b] = await Promise.all([
        ensureFinalization(db, run, new Date()),
        ensureFinalization(db, run, new Date()),
      ]);
      // Both should return a parent (possibly the same row)
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Exactly ONE parent row in the DB
      const parents = await db.select({ id: heartbeatRunFinalizations.id }).from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
      expect(parents).toHaveLength(1);
    });

    it("repeated ensureFinalization returns the existing parent (no duplicate)", async () => {
      const run = await seedV1Run("succeeded");
      const first = await ensureFinalization(db, run, new Date());
      const second = await ensureFinalization(db, run, new Date());
      const third = await ensureFinalization(db, run, new Date());
      expect(first.id).toBe(second.id);
      expect(second.id).toBe(third.id);
      const count = await db.select({ id: heartbeatRunFinalizations.id }).from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
      expect(count).toHaveLength(1);
    });
  });
});
