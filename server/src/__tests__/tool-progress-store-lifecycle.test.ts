import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, toolExecutionHeartbeats as table, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createToolProgressStore } from "../services/tools/progress-store.js";
import { progressTokenHash } from "../services/tools/progress-policy.js";
import { event, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";
import { progressRecord } from "./helpers/tool-progress-records.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
async function scoped() {
  const base = await progressTool(fixture.db);
  const [definition] = await fixture.db.insert(workflowDefinitions).values({ companyId: base.companyId, name: "progress-scope" }).returning();
  const [run] = await fixture.db.insert(workflowRuns).values({ workflowId: definition.id, companyId: base.companyId, status: "running", triggeredBy: "test" }).returning();
  const [step] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "tool", status: "running" }).returning();
  const scope = { ...base, workflowRunId: run.id, stepId: step.stepId };
  const store = createToolProgressStore(fixture.db);
  const row = await store.start(scope, policy);
  const read = async () => (await fixture.reader.select().from(table).where(eq(table.id, row.id)))[0];
  const audit = () => fixture.reader.select().from(activityLog).where(eq(activityLog.entityId, row.id)).orderBy(activityLog.createdAt, activityLog.id);
  return { scope, store, row, run, step, read, audit };
}

describe("real DB scoped lifetime and atomic terminal decisions", () => {
  it.each(["executionGeneration", "retryCount", "iterationIndex"] as const)("invalidates %s replacement even with reused requestId", async (key) => {
    const r = await scoped();
    await r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id));
    const before = await r.read();
    await fixture.db.update(workflowStepRuns).set({ [key]: r.step[key] + 1 }).where(eq(workflowStepRuns.id, r.step.id));
    await expect(r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id, 2))).rejects.toMatchObject({ reason: "tool_progress_scope_replaced" });
    expect(await r.read()).toMatchObject({ state: "failed", reason: "tool_progress_scope_replaced", sequence: 1, lastProgressAt: before.lastProgressAt });
    const terminal = await r.read(); const audit = await r.audit();
    expect((await r.store.finish(r.scope.companyId, r.row.id, "succeeded")).state).toBe("failed");
    expect(await r.read()).toEqual(terminal); expect(await r.audit()).toEqual(audit);
    const replacement = await r.store.start(r.scope, policy);
    expect(replacement.id).not.toBe(r.row.id); expect(replacement[key]).toBe(r.step[key] + 1);
    expect(replacement.requestId).toBe(r.row.requestId);
    expect(await r.store.acceptLocal(r.scope.companyId, replacement.id, event(replacement.id))).toEqual({ accepted: true });
  });

  it.each(["completed", "failed", "cancelled"])("terminal parent %s invalidates accept/check/finish", async (status) => {
    for (const action of ["accept", "check", "finish"] as const) {
      const r = await scoped(); const before = await r.read();
      await fixture.db.update(workflowRuns).set({ status }).where(eq(workflowRuns.id, r.run.id));
      if (action === "accept") await expect(r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id))).rejects.toMatchObject({ status: 409 });
      else if (action === "check") expect((await r.store.check(r.scope.companyId, r.row.id)).state).toBe("failed");
      else expect((await r.store.finish(r.scope.companyId, r.row.id, "succeeded")).state).toBe("failed");
      expect(await r.read()).toMatchObject({ reason: "tool_progress_scope_replaced", sequence: 0, lastProgressAt: before.lastProgressAt });
      await expect(r.store.start(r.scope, policy)).rejects.toMatchObject({ status: 409 });
    }
  });

  it("rejects unresolved, partial, and foreign-company scope before creating a row", async () => {
    const r = await scoped(); const foreign = await progressTool(fixture.db);
    const before = await fixture.reader.select().from(table).where(eq(table.toolId, r.scope.toolId));
    for (const scope of [
      { ...r.scope, stepId: undefined }, { ...r.scope, workflowRunId: undefined },
      { ...r.scope, workflowRunId: randomUUID() }, { ...r.scope, stepId: "missing" },
      { ...r.scope, companyId: foreign.companyId },
    ]) await expect(r.store.start(scope, policy)).rejects.toMatchObject({ status: 422 });
    expect(await fixture.reader.select().from(table).where(eq(table.toolId, r.scope.toolId))).toEqual(before);
  });

  it.each(["succeeded", "failed", "idle", "max"])("HTTP capability cannot revive %s", async (mode) => {
    const token = "lifetime-fixture-token";
    const r = await progressRecord(fixture.db, fixture.reader, "http", progressTokenHash(token));
    if (mode === "idle" || mode === "max") {
      await fixture.db.update(table).set(mode === "idle"
        ? { lastProgressAt: sql`clock_timestamp() - interval '3 seconds'` }
        : { startedAt: sql`clock_timestamp() - interval '11 seconds'` }).where(eq(table.id, r.row.id));
    } else await r.store.finish(r.scope.companyId, r.row.id, mode === "succeeded" ? "succeeded" : "failed");
    const before = await r.read();
    await expect(r.store.accept(r.scope.companyId, r.row.id, event(r.row.id), token)).rejects.toMatchObject({ status: 409 });
    const terminal = await r.read(); const audit = await r.audit();
    expect(terminal.state).toBe(mode === "idle" || mode === "max" ? "timed_out" : mode);
    expect(terminal.lastProgressAt).toEqual(before.lastProgressAt); expect(terminal.sequence).toBe(0);
    await r.store.finish(r.scope.companyId, r.row.id, "succeeded");
    await r.store.check(r.scope.companyId, r.row.id);
    expect(await r.read()).toEqual(terminal); expect(await r.audit()).toEqual(audit);
  });

  it.each([false, true])("serializes accept/finish/check with expired=%s and no post-terminal evidence", async (expired) => {
    const r = await progressRecord(fixture.db, fixture.reader);
    if (expired) await fixture.db.update(table).set({ lastProgressAt: sql`clock_timestamp() - interval '3 seconds'` }).where(eq(table.id, r.row.id));
    const results = await Promise.allSettled([
      r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id)),
      r.store.finish(r.scope.companyId, r.row.id, "succeeded"),
      r.store.check(r.scope.companyId, r.row.id),
    ]);
    const terminal = await r.read(); const audit = await r.audit();
    expect(terminal.state).toBe(expired ? "timed_out" : "succeeded");
    expect(audit.filter((a) => ["tool_progress.succeeded", "tool_progress.timed_out"].includes(a.action))).toHaveLength(1);
    const advances = audit.filter((a) => a.action === "tool_progress.advanced");
    const accepted = results[0].status === "fulfilled" && results[0].value && "accepted" in results[0].value && results[0].value.accepted;
    expect(advances).toHaveLength(accepted ? 1 : 0);
    if (expired) expect(terminal.sequence).toBe(0);
    for (const advance of advances) expect(advance.createdAt.getTime()).toBeLessThanOrEqual(terminal.finishedAt!.getTime());
    await expect(r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id, 2))).rejects.toMatchObject({ status: 409 });
    await r.store.finish(r.scope.companyId, r.row.id, "failed");
    expect(await r.read()).toEqual(terminal); expect(await r.audit()).toEqual(audit);
  });
});
