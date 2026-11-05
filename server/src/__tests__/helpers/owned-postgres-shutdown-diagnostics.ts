// Diagnostic capture and shared cleanup support for the server-owned PostgreSQL shutdown
// integration test. Stage markers pinpoint the first failure phase (seeding, held receipt,
// SIGTERM barrier, restart, cleanup); the primary failure plus child stdout/stderr are
// persisted OUTSIDE the disposable fixture root so evidence survives afterAll root removal.
// Diagnostic persistence is strictly best-effort: it must never mask the primary error or
// alter test oracles, waits, or timing.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const diagBase = `/tmp/runtime-owned-pg-fourth-${process.pid}`;

export interface StageServerLike { logs(): string }

export interface StageRecorder {
  mark(stage: string): void;
  captureFailure(error: unknown, ...servers: Array<StageServerLike | undefined>): void;
}

export function createStageRecorder(): StageRecorder {
  const stages: string[] = [];
  const append = (stage: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(`${diagBase}-stages.jsonl`, JSON.stringify({ t: new Date().toISOString(), stage, ...extra }) + "\n");
  append("recorder-created", { pid: process.pid });
  return {
    mark(stage: string): void {
      stages.push(stage);
      append(stage, { prior: stages[stages.length - 2] ?? "none" });
    },
    captureFailure(error: unknown, ...servers: Array<StageServerLike | undefined>): void {
      // Best-effort diagnostics: a persistence failure must never mask the primary error.
      try {
        writeFileSync(`${diagBase}-primary.json`, JSON.stringify({
          t: new Date().toISOString(),
          lastStage: stages[stages.length - 1] ?? "none",
          stagesSoFar: stages,
          message: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }, null, 2));
        const names = ["first", "second"] as const;
        servers.slice(0, names.length).forEach((server, index) => {
          if (server) writeFileSync(`${diagBase}-child-${names[index]}.log`, server.logs());
        });
      } catch { /* best-effort only */ }
    },
  };
}

export function postmasterPidOf(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

// Kill a server-owned postmaster left after a failed/killed server child: the configured
// dataDir plus the real default fallback <home>/instances/default/db (resolvePaperclipHomeDir
// returns PAPERCLIP_HOME directly; observed invocation 2). Failures aggregate and throw —
// cleanup is never reported as guaranteed success.
export async function killLeakedOwnedPostgres(
  f: { waitForProcessExit(pid: number): Promise<unknown> },
  server: { dataDir: string; home: string },
): Promise<void> {
  const failures: string[] = [];
  for (const pidFile of [path.join(server.dataDir, "postmaster.pid"),
    path.join(server.home, "instances", "default", "db", "postmaster.pid")]) {
    const pid = postmasterPidOf(pidFile);
    if (!pid) continue;
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(`kill pid=${pid} pidFile=${pidFile}: ${String(error)}`); continue; }
    try { await f.waitForProcessExit(pid); }
    catch (error) { failures.push(`exit pid=${pid} pidFile=${pidFile}: ${String(error)}`); }
  }
  if (failures.length > 0) throw new Error(`owned-postgres-cleanup-failed; ${failures.join("; ")}`);
}
