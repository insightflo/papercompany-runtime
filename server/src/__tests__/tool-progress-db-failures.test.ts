import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, toolExecutionHeartbeats, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createToolProgressStore } from "../services/tools/progress-store.js";
import { executeLocalToolWithProgress } from "../services/workflow/local-tool-progress-executor.js";
import { event, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";
import { progressRecord } from "./helpers/tool-progress-records.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

// Inject method failures inside a REAL transaction; rollback/readback use PostgreSQL.
function failingDb(method: "insert" | "update", table: unknown): Db {
  return new Proxy(fixture.db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      const transaction: Db["transaction"] = (operation, config) => target.transaction((tx) => operation(new Proxy(tx, {
        get(inner, prop, recv) {
          if (prop === method) return (selected: unknown) => {
            if (selected === table) throw new Error("injected-db-write-failure");
            return Reflect.apply(Reflect.get(inner, prop, inner), inner, [selected]);
          };
          return Reflect.get(inner, prop, recv);
        },
      })), config);
      return transaction;
    },
  });
}

describe("injected DB write failures with real transaction rollback", () => {
  it("start insert failure prevents child dispatch and leaves no heartbeat/audit", async () => {
    const scope = await progressTool(fixture.db);
    const dir = await mkdtemp(path.join(tmpdir(), "tool-progress-no-dispatch-"));
    const marker = path.join(dir, "dispatched");
    try {
      await expect(executeLocalToolWithProgress({ db: failingDb("insert", toolExecutionHeartbeats), scope, policy,
        executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        cwd: dir, env: process.env,
      })).rejects.toThrow("injected-db-write-failure");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fixture.reader.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.toolId, scope.toolId))).toHaveLength(0);
      expect(await fixture.reader.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId))).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["update", "audit"] as const)("accept %s failure rolls back both counter and audit", async (failure) => {
    const r = await progressRecord(fixture.db, fixture.reader);
    const before = await r.read(); const audit = await r.audit();
    const store = createToolProgressStore(failure === "update" ? failingDb("update", toolExecutionHeartbeats) : failingDb("insert", activityLog));
    await expect(store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id))).rejects.toThrow("injected-db-write-failure");
    expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    expect(await r.store.acceptLocal(r.scope.companyId, r.row.id, event(r.row.id))).toEqual({ accepted: true });
    expect((await r.read()).sequence).toBe(1);
  });
});
