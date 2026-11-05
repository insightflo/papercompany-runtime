import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";

/**
 * Wait-timeout diagnostics for the runtime-shutdown process matrix.
 *
 * Why this exists: when a real-process wait times out, fixture cleanup then deletes
 * the embedded database and tmp root, destroying the only evidence of what the queued
 * step runs / heartbeat runs / wakeup requests looked like. This helper captures a
 * SAFE, selected snapshot at timeout time, BEFORE cleanup runs, into a file under
 * os.tmpdir() that cleanup does not delete.
 *
 * Safety contract (per dispatch scope):
 * - Selected status/ID/timestamp columns only.
 * - No secret material (no secret tables, no secret_ref resolution), no full env
 *   dumps, no metadata blobs (contextSnapshot / toolQueue / stepsJson), and no
 *   process log or SQL query text — pg_stat_activity exposes only pid,
 *   application_name, state, wait_event* and pg_blocking_pids(pid) blockers
 *   (the same vetted blocker shape the fixture itself uses).
 * - Slice failures record the fixed marker "capture_failed" only — arbitrary
 *   error.message / String(error) text is never persisted (it could embed paths,
 *   connection strings, or secret-adjacent context).
 * - Never throws: total failure returns null so the original wait-timeout error
 *   is never masked.
 */
export type RuntimeShutdownDiagnosticsServer = {
  pid: number | null;
  applicationName: string;
  sourcePins: Array<{ path: string; sha256: string }>;
};

type DiagnosticsSlice = { name: string; rows?: unknown; failed?: boolean };

async function safeSlice(name: string, read: () => Promise<unknown>): Promise<DiagnosticsSlice> {
  try { return { name, rows: await read() }; }
  catch { return { name, failed: true }; }
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "wait";
}

export async function captureRuntimeShutdownDiagnostics(input: {
  db: Db;
  label: string;
  servers?: RuntimeShutdownDiagnosticsServer[];
  ownedProcessPids?: number[];
}): Promise<{ path: string; record: Record<string, unknown> } | null> {
  try {
    const db = input.db;
    const slices: DiagnosticsSlice[] = [
      await safeSlice("workflowStepRuns", () => db.select({
        id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId,
        issueId: workflowStepRuns.issueId, status: workflowStepRuns.status, retryCount: workflowStepRuns.retryCount,
        executionGeneration: workflowStepRuns.executionGeneration, iterationIndex: workflowStepRuns.iterationIndex,
        lastDispatchRequestId: workflowStepRuns.lastDispatchRequestId,
        lastDispatchAcceptedAt: workflowStepRuns.lastDispatchAcceptedAt,
        startedAt: workflowStepRuns.startedAt, completedAt: workflowStepRuns.completedAt,
      }).from(workflowStepRuns).limit(200)),
      await safeSlice("workflowRuns", () => db.select({
        id: workflowRuns.id, status: workflowRuns.status, triggeredBy: workflowRuns.triggeredBy,
        startedAt: workflowRuns.startedAt, completedAt: workflowRuns.completedAt,
      }).from(workflowRuns).limit(50)),
      await safeSlice("missions", () => db.select({
        id: missions.id, status: missions.status, startedAt: missions.startedAt, completedAt: missions.completedAt,
      }).from(missions).limit(50)),
      await safeSlice("issues", () => db.select({
        id: issues.id, missionId: issues.missionId, status: issues.status,
        assigneeAgentId: issues.assigneeAgentId, originKind: issues.originKind, completedAt: issues.completedAt,
      }).from(issues).limit(100)),
      await safeSlice("heartbeatRuns", () => db.select({
        id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId,
        invocationSource: heartbeatRuns.invocationSource, triggerDetail: heartbeatRuns.triggerDetail,
        status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId, workflowStepRunId: heartbeatRuns.workflowStepRunId,
        workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration,
      }).from(heartbeatRuns).limit(100)),
      await safeSlice("agentWakeupRequests", () => db.select({
        id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId, issueId: agentWakeupRequests.issueId,
        missionId: agentWakeupRequests.missionId, workflowRunId: agentWakeupRequests.workflowRunId,
        workflowStepRunId: agentWakeupRequests.workflowStepRunId, runId: agentWakeupRequests.runId,
        requestKind: agentWakeupRequests.requestKind, source: agentWakeupRequests.source,
        reason: agentWakeupRequests.reason, status: agentWakeupRequests.status,
        requestedAt: agentWakeupRequests.requestedAt, claimedAt: agentWakeupRequests.claimedAt,
        finishedAt: agentWakeupRequests.finishedAt,
      }).from(agentWakeupRequests).limit(100)),
      await safeSlice("pgStatActivity", () => db.$client.unsafe(
        `select pid, application_name, state, wait_event_type, wait_event,
         pg_blocking_pids(pid) as blockers
         from pg_stat_activity where datname = current_database() order by pid limit 60`)),
    ];
    const record: Record<string, unknown> = {
      schemaVersion: "runtime-shutdown-wait-diagnostics.v1",
      capturedAt: new Date().toISOString(),
      label: input.label,
      testRunnerPid: process.pid,
      servers: input.servers ?? [],
      ownedProcessPids: input.ownedProcessPids ?? [],
      database: Object.fromEntries(slices.map((slice) =>
        [slice.name, slice.failed === true ? { capture_failed: true } : slice.rows])),
    };
    const file = path.join(os.tmpdir(),
      "runtime-shutdown-diagnostics-" + process.pid + "-" + Date.now() + "-" + sanitizeLabel(input.label) + ".json");
    await writeFile(file, JSON.stringify(record, null, 2) + "\n");
    return { path: file, record };
  } catch {
    return null;
  }
}
