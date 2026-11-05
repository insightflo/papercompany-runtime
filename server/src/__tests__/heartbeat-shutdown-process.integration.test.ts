import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
beforeAll(async () => { f = await startRuntimeShutdownProcessFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });

describe("heartbeat shutdown with actual server restart", () => {
  it("requeues the exact unstarted wake and runs its native adapter once after restart", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
    const marker = path.join(f.root, `heartbeat-${runId}.txt`);
    await f.db.insert(companies).values({ id: companyId, name: "Heartbeat restart", issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}` });
    await f.db.insert(agents).values({ id: agentId, companyId, name: "Restart agent", status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n')`], cwd: f.root }, runtimeConfig: {} });
    await f.db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", status: "queued", runId });
    await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", invocationSource: "on_demand", wakeupRequestId: wakeId, contextSnapshot: { taskKey: `heartbeat-${runId}` } });
    const lock = await f.db.$client.reserve();
    const lockKey = 78432311;
    const [{ pid }] = await lock`select pg_backend_pid() as pid`;
    await lock`select pg_advisory_lock(${lockKey})`;
    const functionName = `hold_effect_${runId.replaceAll("-", "")}`;
    await f.db.$client.unsafe(`create function ${functionName}() returns trigger language plpgsql as $$ begin if NEW.attempt_run_id = '${runId}' then perform pg_advisory_xact_lock(${lockKey}); end if; return NEW; end $$`);
    await f.db.$client.unsafe(`create trigger ${functionName} before insert on effect_intents for each row execute function ${functionName}()`);
    let lockHeld = true;
    try {
      const server = await f.startServer(undefined, { HEARTBEAT_SCHEDULER_ENABLED: "true" });
      const blocked = await f.waitFor(async () => {
        const [row] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        if (row?.status === "failed") throw new Error(`heartbeat failed before gate: ${row.errorCode}: ${row.error}`);
        const blockers = await f.db.$client.unsafe(`select pg_blocking_pids(pid) as blockers from pg_stat_activity where application_name = $1 and query ilike '%effect_intents%'`, [server.applicationName]);
        return blockers.some((entry) => (entry.blockers as number[]).includes(Number(pid))) ? { holderPid: Number(pid), runId, wakeId } : null;
      }, "heartbeat blocked at intent gate", 20_000);
      f.recordEvidence("heartbeat-unstarted", server, blocked);
      server.signal("SIGTERM");
      await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "heartbeat signal entry");
      await lock`select pg_advisory_unlock(${lockKey})`;
      lockHeld = false;
      expect((await server.waitExit()).code).toBe(0);
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [wake] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
      expect(run).toMatchObject({ status: "queued", startedAt: null, processLossRetryCount: 0 });
      expect(wake).toMatchObject({ status: "queued", claimedAt: null, runId });
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const restarted = await f.startServer(undefined, { HEARTBEAT_SCHEDULER_ENABLED: "true" });
      f.recordEvidence("heartbeat-restart", restarted, { runId, wakeId });
      await f.waitFor(async () => (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "succeeded" ? true : null, "heartbeat restart completion");
      expect(await readFile(marker, "utf8")).toBe("started\n");
      restarted.signal("SIGTERM");
      expect((await restarted.waitExit()).code).toBe(0);
    } finally {
      if (lockHeld) await lock`select pg_advisory_unlock(${lockKey})`;
      lock.release();
      await f.db.$client.unsafe(`drop trigger if exists ${functionName} on effect_intents`);
      await f.db.$client.unsafe(`drop function if exists ${functionName}()`);
    }
  }, 180_000);
});
