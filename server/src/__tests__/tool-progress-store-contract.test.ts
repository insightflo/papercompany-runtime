import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toolDefinitions } from "@paperclipai/db";
import type { ToolProgressEvent } from "@paperclipai/shared";
import { progressTokenHash } from "../services/tools/progress-policy.js";
import { event, policy, progressDatabase } from "./helpers/tool-progress.js";
import { progressRecord } from "./helpers/tool-progress-records.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
const token = "fixture-capability-never-persist-plaintext";
const record = (adapter = "builtin", hash?: string) => progressRecord(fixture.db, fixture.reader, adapter, hash);

describe("real DB progress counter and capability contract (independent reader)", () => {
  it("binds HTTP token to exact company and execution and denies local internal entry", async () => {
    const r = await record("http", progressTokenHash(token));
    const attempts = [
      () => r.store.accept(randomUUID(), r.row.id, event(r.row.id), token),
      () => r.store.accept(r.scope.companyId, randomUUID(), event(r.row.id), token),
      () => r.store.accept(r.scope.companyId, r.row.id, event(randomUUID()), token),
      () => r.store.accept(r.scope.companyId, r.row.id, event(r.row.id), "wrong"),
      () => r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id)),
    ];
    const before = await r.read(); const audit = await r.audit();
    for (const [index, attempt] of attempts.entries()) {
      await expect(attempt()).rejects.toMatchObject({ status: index < 3 ? 404 : 401 });
      expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    }
    expect(await r.store.accept(r.scope.companyId, r.row.id, event(r.row.id), token)).toEqual({ accepted: true });
    expect(r.row).not.toHaveProperty("tokenHash");
    expect(await r.store.check(r.scope.companyId, r.row.id)).not.toHaveProperty("tokenHash");
    const persisted = await r.read();
    expect(persisted.tokenHash).toBe(progressTokenHash(token));
    expect(JSON.stringify(persisted)).not.toContain(token);
    const serializedAudit = JSON.stringify(await r.audit());
    expect(serializedAudit).not.toContain(token); expect(serializedAudit).not.toContain(persisted.tokenHash!);
    expect(serializedAudit).not.toContain("tokenHash");
  });

  it("does not write timestamps/audit for same/lower counters or replay/out-of-order sequences", async () => {
    const r = await record(); const send = (seq: number, current: number) => r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id, seq, current));
    await send(5, 5); await r.eligible();
    const before = await r.read(); const audit = await r.audit();
    for (const [seq, current] of [[6, 5], [7, 4], [4, 6], [5, 6]]) {
      expect(await send(seq, current)).toEqual({ accepted: false, reason: "no_progress" });
      expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    }
    expect(await send(6, 6)).toEqual({ accepted: true });
    expect((await r.read()).lastProgressAt.getTime()).toBeGreaterThan(before.lastProgressAt.getTime());
  });

  it.each([-1, NaN, Number.MAX_SAFE_INTEGER + 1, 1.25])("rejects invalid count %s before any write", async (current) => {
    const r = await record(); const before = await r.read(); const audit = await r.audit();
    for (const field of ["current", "sequence", "total"]) {
      await expect(r.store.acceptLocal(r.scope.companyId, r.row.id, { ...event(r.row.id), [field]: current }))
        .rejects.toMatchObject({ status: 400 });
      expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    }
  });

  it("enforces first stage/current>0, exact next stage, units, immutable totals and per-stage reset", async () => {
    const r = await record();
    const send = (patch: Partial<ToolProgressEvent>) => r.store.acceptLocal(r.scope.companyId, r.row.id, { ...event(r.row.id), ...patch });
    const rejected = async (patch: Partial<ToolProgressEvent>) => {
      const before = await r.read(); const audit = await r.audit();
      expect(await send(patch)).toEqual({ accepted: false, reason: "no_progress" });
      expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    };
    await rejected({ current: 0 });
    await rejected({ stage: "encode", unit: "frames" }); // Cannot skip first stage.
    await rejected({ stage: "undeclared" }); await rejected({ unit: "bytes" });
    expect(await send({ current: 2 })).toEqual({ accepted: true });
    await r.eligible();
    expect(await send({ sequence: 2, current: 3, total: 10 })).toEqual({ accepted: true }); // Introduced once.
    await r.eligible();
    await rejected({ sequence: 3, current: 4, total: 11 });
    await rejected({ sequence: 3, current: 4 }); // Cannot disappear.
    await rejected({ sequence: 3, current: 4, unit: "frames", total: 10 });
    expect(await send({ sequence: 3, current: 10, total: 10 })).toEqual({ accepted: true });
    expect((await r.read()).state).toBe("active"); // Reaching total is not completion.
    await r.eligible();
    await rejected({ sequence: 4, stage: "encode", unit: "frames", current: 0 });
    expect(await send({ sequence: 4, stage: "encode", unit: "frames", current: 1 })).toEqual({ accepted: true });
    expect(await r.read()).toMatchObject({ stageIndex: 1, current: 1, total: null });
    await r.eligible();
    await rejected({ sequence: 5, current: 11, total: 12 }); // Backwards stage.
  });

  it("throttles without consuming sequence and keeps the frozen policy after caller/tool edits", async () => {
    const r = await record();
    await r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id));
    const before = await r.read(); const audit = await r.audit();
    expect(await r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id, 2)))
      .toEqual({ accepted: false, reason: "throttled" });
    expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    await r.eligible();
    expect(await r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id, 2))).toEqual({ accepted: true });
    const mutable = structuredClone(policy);
    const second = await r.store.start({ ...r.scope, requestId: randomUUID() }, mutable);
    mutable.idleTimeoutMs = 1000; mutable.stages[0].key = "changed";
    await fixture.db.update(toolDefinitions).set({ adapterConfig: { progress: mutable } }).where(eq(toolDefinitions.id, r.scope.toolId));
    expect((await r.store.check(r.scope.companyId, second.id)).policy).toEqual(policy);
    expect(await r.store.acceptLocal(r.scope.companyId, second.id, event(second.id))).toEqual({ accepted: true });
  });
});
