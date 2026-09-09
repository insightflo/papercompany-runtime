import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toolExecutionHeartbeats } from "@paperclipai/db";
import { executeLocalToolWithProgress } from "../services/workflow/local-tool-progress-executor.js";
import { policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("owned child exit is independent from inherited pipe closure", () => {
  it("settles idle timeout before a finite descendant releases stdout/stderr/fd3", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "progress-descendant-"));
    const scope = await progressTool(fixture.db);
    let descendantPid: number | undefined;
    try {
      const source = `
        const fs = require('node:fs');
        const {spawn} = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 6500)'],
          {stdio:['ignore',1,2,3]});
        fs.writeFileSync(${JSON.stringify(path.join(dir, "pids.json"))}, JSON.stringify([process.pid,descendant.pid]));
        descendant.unref();
        process.exit(0);
      `;
      const started = Date.now();
      const outcome = await executeLocalToolWithProgress({ db: fixture.db, scope,
        policy: { ...policy, idleTimeoutMs: 1000, maxDurationMs: 15_000 },
        executable: process.execPath, args: ["-e", source], cwd: dir, env: process.env,
      }).then(() => ({ reason: "unexpected_success" }), (error: unknown) => error);
      const elapsed = Date.now() - started;
      const [ownedPid, descendant] = JSON.parse(await readFile(path.join(dir, "pids.json"), "utf8")) as number[];
      descendantPid = descendant;
      console.info("inherited pipe lifecycle", { elapsed, ownedAlive: alive(ownedPid), descendantAlive: alive(descendant) });
      expect(outcome).toMatchObject({ reason: "tool_progress_idle_timeout" });
      expect(alive(ownedPid)).toBe(false);
      expect(elapsed).toBeLessThan(4000);
      expect(alive(descendant)).toBe(true); // No claim that cancellation killed descendants.
      const [row] = await fixture.reader.select().from(toolExecutionHeartbeats)
        .where(eq(toolExecutionHeartbeats.toolId, scope.toolId));
      expect(row.state).toBe("timed_out");
    } finally {
      // Only the exact PID written by this bounded fixture; never search processes.
      if (descendantPid && alive(descendantPid)) process.kill(descendantPid, "SIGTERM");
      if (descendantPid) {
        for (let i = 0; i < 100 && alive(descendantPid); i++) await delay(20);
        expect(alive(descendantPid)).toBe(false);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("escalates only a live owned child ignoring SIGTERM and waits for closure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "progress-kill-"));
    const scope = await progressTool(fixture.db);
    try {
      const started = Date.now();
      const outcome = await executeLocalToolWithProgress({ db: fixture.db, scope,
        policy: { ...policy, idleTimeoutMs: 1000, maxDurationMs: 15_000 }, executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(process.pid));
          process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 9000);`], cwd: dir, env: process.env,
      }).catch((error: unknown) => error);
      const elapsed = Date.now() - started;
      const pid = Number(await readFile(path.join(dir, "pid"), "utf8"));
      console.info("SIGKILL lifecycle", { elapsed, ownedAlive: alive(pid) });
      expect(outcome).toMatchObject({ reason: "tool_progress_idle_timeout" });
      expect(elapsed).toBeGreaterThanOrEqual(2900);
      expect(elapsed).toBeLessThan(5500);
      expect(alive(pid)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 15_000);
});
