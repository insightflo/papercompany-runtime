import { runningProcesses } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";

type RunningProcess = NonNullable<ReturnType<typeof runningProcesses.get>>;
export interface MissionTerminalProcessStop {
  heartbeatRunId: string;
  originalEntry: RunningProcess;
  child: RunningProcess["child"];
  graceSec: number;
}

/** Capture producer-owned handles while the selected heartbeat rows are locked.
 * A numeric PID alone is never process identity or permission to signal.
 */
export function captureMissionTerminalProcesses(
  rows: Array<{ id: string; processPid: number | null }>,
): MissionTerminalProcessStop[] {
  const stops: MissionTerminalProcessStop[] = [];
  for (const row of rows) {
    const entry = runningProcesses.get(row.id);
    if (!entry) continue;
    const { child, graceSec } = entry;
    if (row.processPid !== null && row.processPid !== child.pid) continue;
    stops.push({ heartbeatRunId: row.id, originalEntry: entry, child, graceSec });
  }
  return stops;
}

/** Only called after successful commit. Never resolve a target from the map again. */
export function stopMissionTerminalProcesses(stops: MissionTerminalProcessStop[]): void {
  for (const { heartbeatRunId, originalEntry, child, graceSec } of stops) {
    const alive = () => child.exitCode == null && child.signalCode == null;
    const signal = (name: NodeJS.Signals) => {
      try {
        child.kill(name);
      } catch (err) {
        logger.warn({ err, heartbeatRunId, signal: name }, "terminal cleanup child signal failed");
      }
    };
    try {
      if (alive()) {
        signal("SIGTERM");
        const timer = setTimeout(() => {
          // child.killed records a sent signal, not process exit.
          if (alive()) signal("SIGKILL");
        }, Math.max(1, graceSec) * 1000);
        timer.unref();
      }
    } catch (err) {
      logger.warn({ err, heartbeatRunId }, "terminal cleanup process stop failed");
    } finally {
      if (runningProcesses.get(heartbeatRunId) === originalEntry) runningProcesses.delete(heartbeatRunId);
    }
  }
}
