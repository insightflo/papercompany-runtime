import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import * as followups from "../services/workflow/control-flow/qa-correction-followup.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { createCommitSourceHarness, issueC02, issueNextC02, issueDeliveryC02, deliveryInput, deliveryWriter, deliver,
  deliveryState, correctionRows, blockDelivery, waitForDeliveryLocks, invalidateDelivery, corruptDelivery, installReceiptCollision,
} from "./helpers/c02-delivery-fixture.js";

// C02: one delivery per issued request, response-loss replay has NO new start.
// C03/C12: real files/PG/writers, atomic rollback, quality use/cost and cancellation remain authoritative.
// This is the 12A-1 root boundary; public wakeup/resume/cancel and actual claim are separate stages.
describe("C02 correction delivery root", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "delivery-storage"));
  }, 120000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await owned?.close(); }
    finally { vi.unstubAllEnvs(); }
  }, 120000);

  it.each(["todo", "done"] as const)(
    "%s QA persists only the two identity columns after the real NULL-identity writer, with one receipt time", async status => {
    const c = await issueDeliveryC02(owned, status), i = await deliveryInput(c);
    i.request.payload!.__paperclipWorkflowProducerAttempt = { forged: true };
    const before = await deliveryState(c);
    expect(before.issue).toMatchObject({ status, completedAt: status === "done" ? expect.any(Date) : null });
    let written: typeof heartbeatRuns.$inferSelect | undefined;
    const writer = vi.fn(deliveryWriter(c, async (_tx, _wake, hb) => { written = structuredClone(hb); }));
    const result = await deliver(c, i, c.s.db, writer), rows = await correctionRows(c);
    expect(result.kind).toBe("new_delivery");
    expect(result.startRunId).toBe(rows.heartbeats[0]!.id);
    expect([c.s.f.verdictHeartbeatId, c.s.f.producerHeartbeatId]).not.toContain(result.startRunId);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(rows.wakes).toHaveLength(1);
    expect(rows.heartbeats).toHaveLength(1);
    expect(rows.receipts).toHaveLength(1);
    const hb = rows.heartbeats[0]!, w = rows.wakes[0]!, event = rows.receipts[0]!;
    expect(written).toMatchObject({ workflowStepRunId: null, workflowExecutionGeneration: null });
    expect(hb).toEqual({ ...written, workflowStepRunId: c.followup.target.stepRunId,
      workflowExecutionGeneration: c.followup.target.executionGeneration });
    expect(hb).toMatchObject({ status: "queued", startedAt: null, finishedAt: null, finalizationVersion: 0 });
    expect(readWorkflowAttemptProof(w)).toMatchObject({ retryCount: 1, iterationIndex: 2, parentHeartbeatRunId: null });
    expect(event.createdAt.toISOString()).toBe(event.payload.deliveredAt);
    expect(event).toMatchObject({ heartbeatRunId: hb.id, wakeupRequestId: w.id,
      payload: { ref: c.ref, followupEventId: c.followupRow.id, heartbeatRunId: hb.id, wakeupRequestId: w.id } });
    const after = await deliveryState(c);
    expect(after.issue).toMatchObject({ status: "in_progress", checkoutRunId: hb.id, executionRunId: hb.id,
      startedAt: expect.any(Date), completedAt: null });
    expect(after.usage).toEqual(before.usage);
    expect(after.groups).toEqual(before.groups);
    expect(after.receipts).toEqual(before.receipts);
    const observed = vi.spyOn(followups, "observeQaCorrectionFollowup");
    const replay = await deliver(c, i, owned.connect(), writer);
    expect(replay).toEqual({ ...result, kind: "existing_receipt", startRunId: null });
    expect(observed).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await deliveryState(c)).toEqual(after);
  }, 30000);

  it("serializes two actual PostgreSQL backends: one callback/link/receipt/start grant, one historical result", async () => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), i = await deliveryInput(c);
    const before = await deliveryState(c), observer = owned.connect();
    const observation = vi.spyOn(followups, "observeQaCorrectionFollowup");
    const writer = vi.fn(deliveryWriter(c));
    let pending: Promise<Awaited<ReturnType<typeof deliver>>[]> | undefined;
    try {
      await owned.connect().transaction(async tx => {
        await tx.select().from(workflowRuns).where(eq(workflowRuns.id, i.workflowRunId)).for("no key update");
        const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        pending = Promise.all([deliver(c, i, owned.connect(), writer), deliver(c, i, owned.connect(), writer)]);
        void pending.catch(() => {});
        const pids = await waitForDeliveryLocks(observer, Number(holder!.pid), 2);
        expect(new Set(pids).size).toBe(2);
      });
      const results = await pending!;
      expect(results.map(r => r.kind).sort()).toEqual(["existing_receipt", "new_delivery"]);
      expect(results.filter(r => r.startRunId !== null)).toHaveLength(1);
      expect(observation).toHaveBeenCalledTimes(2);
      expect(writer).toHaveBeenCalledTimes(1);
      const rows = await correctionRows(c), first = structuredClone(rows);
      expect(rows.wakes).toHaveLength(1);
      expect(rows.heartbeats).toHaveLength(1);
      expect(rows.receipts).toHaveLength(1);
      const replay = await deliver(c, i, owned.connect(), writer);
      expect(replay.startRunId).toBeNull();
      expect(await correctionRows(c)).toEqual(first);
      const after = await deliveryState(c);
      expect(after.usage).toEqual(before.usage);
      expect(after.groups).toEqual(before.groups);
      expect(after.receipts).toEqual(before.receipts);
    } finally {
      if (pending) await Promise.allSettled([pending]);
    }
  }, 30000);

  it.each(["queued", "deferred"] as const)(
    "%s pending race reobserves once (three real observations) and later explicitly promotes the SAME wake", async mode => {
      const c = await issueC02(owned, { mode: "content-only", quality: true }), i = await deliveryInput(c);
      const unblock = await blockDelivery(c, i, mode), observation = vi.spyOn(followups, "observeQaCorrectionFollowup");
      const writer = vi.fn(deliveryWriter(c)), observer = owned.connect(), before = await deliveryState(c);
      let pending: Promise<Awaited<ReturnType<typeof deliver>>[]> | undefined;
      try {
        await owned.connect().transaction(async tx => {
          await tx.select().from(workflowRuns).where(eq(workflowRuns.id, i.workflowRunId)).for("no key update");
          const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          pending = Promise.all([deliver(c, i, owned.connect(), writer), deliver(c, i, owned.connect(), writer)]);
          void pending.catch(() => {});
          expect(await waitForDeliveryLocks(observer, Number(holder!.pid), 2)).toHaveLength(2);
        });
        const results = await pending!, rows = await correctionRows(c), saved = structuredClone(rows.wakes[0]!);
        expect(results).toEqual(Array(2).fill({ kind: "waiting", wakeupRequestId: saved.id, startRunId: null }));
        expect(observation).toHaveBeenCalledTimes(3);
        expect(writer).not.toHaveBeenCalled();
        expect(rows.wakes).toHaveLength(1);
        expect(rows.heartbeats).toHaveLength(0);
        expect(rows.receipts).toHaveLength(0);
        const after = await deliveryState(c);
        expect(after.usage).toEqual(before.usage);
        expect(after.groups).toEqual(before.groups);
        expect(after.receipts).toEqual(before.receipts);
        for (const field of ["actor", "source", "payload"]) {
          const bad = structuredClone(i);
          if (field === "actor") bad.request.requestedByActorId = "different";
          if (field === "source") bad.request.source = "assignment";
          if (field === "payload") bad.request.payload!.callerField = { changed: true };
          await expect(deliver(c, bad, c.s.db, writer)).rejects.toThrow();
          expect((await correctionRows(c)).wakes).toEqual([saved]);
        }
        await unblock();
        const promoted = await deliver(c, { ...i, mode, candidateWakeupRequestId: saved.id }, c.s.db, writer);
        expect(promoted.kind).toBe("new_delivery");
        expect(promoted.wakeupRequestId).toBe(saved.id);
        expect(writer).toHaveBeenCalledTimes(1);
        const linked = await correctionRows(c);
        expect(linked.heartbeats).toHaveLength(1);
        expect(linked.receipts).toHaveLength(1);
        expect(linked.wakes[0]).toMatchObject({ payload: saved.payload, coalescedCount: saved.coalescedCount,
          requestedAt: saved.requestedAt, createdAt: saved.createdAt });
        expect(await deliver(c, i, owned.connect(), writer)).toEqual({ ...promoted, kind: "existing_receipt", startRunId: null });
        expect(writer).toHaveBeenCalledTimes(1);
      } finally {
        if (pending) await Promise.allSettled([pending]);
        await unblock();
      }
    }, 30000);

  it("returns B's effect after real C issuance, terminal/pause/budget rejection and newer counters, without IO or writes", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), i = await deliveryInput(b);
    const writer = vi.fn(deliveryWriter(b)), delivered = await deliver(b, i, b.s.db, writer);
    await issueNextC02(b);
    await b.peer.update(workflowStepRuns).set({ executionGeneration: i.workflowExecutionGeneration + 1, retryCount: 9 })
      .where(eq(workflowStepRuns.id, i.workflowStepRunId));
    await b.peer.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, i.workflowRunId));
    await b.peer.update(missions).set({ status: "completed" }).where(eq(missions.id, i.missionId));
    await b.peer.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, i.agentId));
    await b.peer.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, i.companyId));
    const before = await deliveryState(b), observation = vi.spyOn(followups, "observeQaCorrectionFollowup");
    expect(await deliver(b, i, owned.connect(), writer)).toEqual({ ...delivered, kind: "existing_receipt", startRunId: null });
    expect(observation).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await deliveryState(b)).toEqual(before);
    const [author] = await b.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, b.s.f.producerHeartbeatId));
    await expect(deliver(b, { ...i, agentId: author!.agentId }, b.s.db, writer)).rejects.toThrow();
    await b.peer.update(issues).set({ assigneeAgentId: author!.agentId }).where(eq(issues.id, i.issueId));
    const reassigned = await deliveryState(b);
    await expect(deliver(b, i, owned.connect(), writer)).rejects.toThrow("qa_correction_delivery_agent");
    expect(await deliveryState(b)).toEqual(reassigned);
  }, 30000);

  it("rejects an undelivered old B after C and never turns terminal refusal into waiting", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), i = await deliveryInput(b);
    await issueNextC02(b);
    const before = await deliveryState(b), writer = vi.fn(deliveryWriter(b));
    await expect(deliver(b, i, b.s.db, writer)).rejects.toThrow();
    expect(await deliveryState(b)).toEqual(before);
    expect(writer).not.toHaveBeenCalled();
    const c = await issueC02(owned, { mode: "content-only" }), ci = await deliveryInput(c);
    await invalidateDelivery(c, ci, "terminal");
    const terminal = await deliveryState(c);
    await expect(deliver(c, ci)).rejects.toThrow();
    expect(await deliveryState(c)).toEqual(terminal);
  }, 30000);

  it.each(["ref", "key", "company", "mission", "step", "generation"] as const)("rejects malformed or wrong %s", async fault => {
    const c = await issueC02(owned, { mode: "content-only" }), i = await deliveryInput(c), before = await deliveryState(c);
    if (fault === "ref") i.ref = { ...i.ref, extra: true } as typeof i.ref;
    if (fault === "key") i.request.idempotencyKey += ":wrong";
    if (fault === "company") i.companyId = c.s.f.otherCompanyId;
    if (fault === "mission") i.missionId = randomUUID();
    if (fault === "step") i.workflowStepRunId = c.s.p.producer.stepRunId;
    if (fault === "generation") i.workflowExecutionGeneration++;
    const writer = vi.fn(deliveryWriter(c));
    await expect(deliver(c, i, c.s.db, writer)).rejects.toThrow();
    expect(writer).not.toHaveBeenCalled();
    expect(await deliveryState(c)).toEqual(before);
  }, 30000);

  it.each(["cancel", "owner", "binding", "quality"] as const)("rechecks %s changed after real file observation", async fault => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), i = await deliveryInput(c);
    const real = followups.observeQaCorrectionFollowup;
    let changed: Awaited<ReturnType<typeof deliveryState>> | undefined;
    vi.spyOn(followups, "observeQaCorrectionFollowup").mockImplementationOnce(async (...args) => {
      const token = await real(...args);
      await invalidateDelivery(c, i, fault);
      changed = await deliveryState(c);
      return token;
    });
    const writer = vi.fn(deliveryWriter(c));
    await expect(deliver(c, i, c.s.db, writer)).rejects.toThrow();
    expect(writer).not.toHaveBeenCalled();
    expect(await deliveryState(c)).toEqual(changed);
  }, 30000);

  it("aborts on a newly observed owner after waiting for the run lock, instead of locking that owner late", async () => {
    const c = await issueC02(owned, { mode: "content-only" }), i = await deliveryInput(c), observer = owned.connect();
    const writer = vi.fn(deliveryWriter(c));
    let pending: PromiseSettledResult<Awaited<ReturnType<typeof deliver>>>[] | undefined;
    let running: Promise<PromiseSettledResult<Awaited<ReturnType<typeof deliver>>>[]> | undefined;
    let changed: Awaited<ReturnType<typeof deliveryState>> | undefined;
    try {
      await owned.connect().transaction(async tx => {
        await tx.select().from(workflowRuns).where(eq(workflowRuns.id, i.workflowRunId)).for("no key update");
        const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        running = Promise.allSettled([deliver(c, i, owned.connect(), writer)]);
        await waitForDeliveryLocks(observer, Number(holder!.pid), 1);
        await invalidateDelivery(c, i, "owner");
        changed = await deliveryState(c);
      });
      pending = await running!;
      expect(pending[0]!.status).toBe("rejected");
      if (pending[0]!.status === "rejected") expect(pending[0]!.reason.message).toBe("qa_correction_delivery_owner_changed");
      expect(writer).not.toHaveBeenCalled();
      expect(await deliveryState(c)).toEqual(changed);
    } finally {
      if (running) await running;
    }
  }, 30000);

  it.each(["proof", "scope", "identity", "partial", "failure"] as const)(
    "rolls the actual writer, heartbeat, issue, receipt and all quality state back after %s", async fault => {
      const c = await issueC02(owned, { mode: "content-only", quality: true }), i = await deliveryInput(c);
      const before = await deliveryState(c), writer = vi.fn(deliveryWriter(c, async (tx, wake, hb) => {
        if (fault === "failure") throw Error("c02_real_writer_failure");
        if (fault === "proof") await tx.update(agentWakeupRequests).set({ payload: { ...wake.payload,
          __paperclipWorkflowProducerAttempt: { forged: true } } }).where(eq(agentWakeupRequests.id, wake.id));
        if (fault === "scope") await tx.update(agentWakeupRequests).set({ issueId: c.s.p.producer.issueId }).where(eq(agentWakeupRequests.id, wake.id));
        if (fault === "identity") await tx.update(heartbeatRuns).set({ workflowStepRunId: c.s.p.producer.stepRunId,
          workflowExecutionGeneration: c.s.p.producer.executionGeneration }).where(eq(heartbeatRuns.id, hb.id));
        if (fault === "partial") await tx.update(heartbeatRuns).set({ workflowExecutionGeneration: 0 }).where(eq(heartbeatRuns.id, hb.id));
      }));
      await expect(deliver(c, i, c.s.db, writer)).rejects.toThrow();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(await deliveryState(c)).toEqual(before);
      expect(await correctionRows(c)).toEqual({ wakes: [], heartbeats: [], receipts: [] });
    }, 30000);

  it("rolls back a real receipt unique-key collision and refuses a key without a committed complete history", async () => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), i = await deliveryInput(c);
    const before = await deliveryState(c), remove = await installReceiptCollision(c);
    const writer = vi.fn(deliveryWriter(c)), observation = vi.spyOn(followups, "observeQaCorrectionFollowup");
    try {
      await expect(deliver(c, i, c.s.db, writer)).rejects.toThrow("qa_correction_delivery_receipt_missing");
      expect(writer).toHaveBeenCalledTimes(1);
      expect(observation).toHaveBeenCalledTimes(1);
      expect(await deliveryState(c)).toEqual(before);
    } finally { await remove(); }
  }, 30000);

  it.each(["proof", "target", "backref", "time", "order", "context", "duplicate_wake", "duplicate_hb"] as const)(
    "rejects %s corruption of a real delivered result without another callback or file observation", async fault => {
      const c = await issueC02(owned, { mode: "content-only" }), i = await deliveryInput(c);
      const writer = vi.fn(deliveryWriter(c));
      await deliver(c, i, c.s.db, writer);
      await corruptDelivery(c, fault);
      const before = await deliveryState(c), observation = vi.spyOn(followups, "observeQaCorrectionFollowup");
      await expect(deliver(c, i, owned.connect(), writer)).rejects.toThrow();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(observation).not.toHaveBeenCalled();
      expect(await deliveryState(c)).toEqual(before);
    }, 30000);
});
