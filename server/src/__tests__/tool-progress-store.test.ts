import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { event, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
let module: typeof import("../services/tools/progress-store.js");
beforeAll(async () => {
  fixture = await progressDatabase();
  const rows = await fixture.reader.execute(sql`select to_regclass('public.tool_execution_heartbeats') as name`);
  expect(rows[0].name).toBe("tool_execution_heartbeats");
  const modulePath = "../services/tools/progress-store.js";
  module = await import(modulePath);
}, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
describe("durable tool progress", () => {
  it("persists real advances but not repeated counters on an independent connection", async () => {
    const scope = await progressTool(fixture.db);
    const store = module.createToolProgressStore(fixture.db);
    const row = await store.start(scope, policy);
    expect(row).not.toHaveProperty("tokenHash");
    expect(await store.acceptLocal(scope.companyId, row.id, event(row.id))).toEqual({ accepted: true });
    const read = async () => (await fixture.reader.select().from(schema.toolExecutionHeartbeats)
      .where(eq(schema.toolExecutionHeartbeats.id, row.id)))[0];
    const before = await read();
    expect(await store.acceptLocal(scope.companyId, row.id, event(row.id, 2, 1)))
      .toEqual({ accepted: false, reason: "no_progress" });
    expect((await read()).lastProgressAt).toEqual(before.lastProgressAt);
    expect(await store.acceptLocal(scope.companyId, row.id, event(row.id, 2, 2)))
      .toEqual({ accepted: false, reason: "throttled" });
    await fixture.db.update(schema.toolExecutionHeartbeats).set({ lastProgressAt: sql`clock_timestamp() - interval '1100 milliseconds'` })
      .where(eq(schema.toolExecutionHeartbeats.id, row.id));
    expect(await store.acceptLocal(scope.companyId, row.id, event(row.id, 2, 2))).toEqual({ accepted: true });
    expect((await read()).current).toBe(2);
    const audit = await fixture.reader.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityId, row.id), eq(schema.activityLog.action, "tool_progress.advanced")));
    expect(audit).toHaveLength(2);
    expect((await store.finish(scope.companyId, row.id, "succeeded")).state).toBe("succeeded");
    expect((await store.finish(scope.companyId, row.id, "failed")).state).toBe("succeeded");
  });
  it("late callbacks cannot revive expired rows and cannot finish successfully", async () => {
    const scope = await progressTool(fixture.db);
    const store = module.createToolProgressStore(fixture.db);
    const row = await store.start(scope, policy);
    await fixture.db.update(schema.toolExecutionHeartbeats).set({ lastProgressAt: sql`clock_timestamp() - interval '3 seconds'` })
      .where(eq(schema.toolExecutionHeartbeats.id, row.id));
    await expect(store.acceptLocal(scope.companyId, row.id, event(row.id))).rejects.toMatchObject({ status: 409 });
    expect((await store.finish(scope.companyId, row.id, "succeeded")).state).toBe("timed_out");
    const [readback] = await fixture.reader.select().from(schema.toolExecutionHeartbeats).where(eq(schema.toolExecutionHeartbeats.id, row.id));
    expect(readback.state).toBe("timed_out");
    expect(readback.sequence).toBe(0);
  });
});
