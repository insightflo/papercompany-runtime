import { createHash } from "node:crypto";
import { stat, watch } from "node:fs/promises";
import path from "node:path";
import type { QualityTestDb } from "./quality-db.js";
import type { QualityFixture } from "./quality-fixture.js";
import type { CurrentOutputSeed } from "./quality-proofs.js";
import type { ensureCanonicalQualityExecution } from "../../services/quality/native-records.js";

export type TestAction = {
  seeded: QualityFixture;
  seed: CurrentOutputSeed;
  actionId: string;
  intentKey: string;
  files: { file: string; before: string; after: string }[];
  producerReleasePath: string;
  qaReleasePath: string;
  binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typedHoldDiagnostic(error: unknown): { outcome: string; reason?: string } | undefined {
  if (!isRecord(error) || !isRecord(error.result)) return undefined;
  const safe = (value: unknown) => typeof value === "string" && /^[a-z0-9_:-]{1,96}$/.test(value) ? value : undefined;
  const outcome = safe(error.result.outcome), reason = safe(error.result.reason);
  return outcome ? { outcome, ...(reason ? { reason } : {}) } : undefined;
}

export function emitStage(stage: string, phase: "before" | "after" | "error", details: Record<string, unknown>, error?: unknown): void {
  const errorName = error instanceof Error ? error.name : error === undefined ? undefined : "unknown";
  const postgres = error instanceof Error ? error as Error & { code?: unknown; position?: unknown; query?: unknown } : null;
  process.stderr.write(`[c5-f-scoped-drain] ${JSON.stringify({ stage, phase, at: new Date().toISOString(), ...details,
    ...(errorName ? { errorName } : {}),
    ...(typeof postgres?.code === "string" ? { postgresCode: postgres.code } : {}),
    ...(typeof postgres?.position === "string" || typeof postgres?.position === "number"
      ? { postgresPosition: postgres.position } : {}),
    ...(typeof postgres?.query === "string" ? { postgresQuery: postgres.query.slice(0, 2000) } : {}),
    ...(error ? { typedHoldResult: typedHoldDiagnostic(error) } : {}) })}\n`);
}

export async function traceStage<T>(stage: string, details: Record<string, unknown>, run: () => Promise<T>,
  completedDetails?: (result: T) => Record<string, unknown>): Promise<T> {
  emitStage(stage, "before", details);
  try {
    const result = await run();
    emitStage(stage, "after", { ...details, ...(completedDetails?.(result) ?? {}) });
    return result;
  } catch (error) {
    emitStage(stage, "error", details, error);
    throw error;
  }
}

export function scenarioTraceIds(label: string, scenario: TestAction): Record<string, unknown> {
  return { label, companyId: scenario.seeded.companyId, actionId: scenario.actionId,
    missionId: scenario.seed.missionId, workflowRunId: scenario.seed.workflowRunId,
    producerIssueId: scenario.seed.producerIssueId, initialQaIssueId: scenario.seed.qaIssueId,
    producerStepRunId: scenario.seed.producerStepRunId, initialQaStepRunId: scenario.seed.qaStepRunId,
    producerHeartbeatRunId: scenario.seed.source.heartbeatRunId,
    initialQaHeartbeatRunId: scenario.seed.verdictHeartbeatId };
}

export function armOneShotReleaseRunReadFailure(db: QualityTestDb["db"], heartbeatRunId: string) {
  type PostgresClient = Pick<typeof db.$client, "unsafe">;
  type QueryDb = { select: (...args: unknown[]) => unknown };
  const client = db.$client as unknown as PostgresClient;
  const queryDb = db as unknown as QueryDb;
  const originalSelectDescriptor = Object.getOwnPropertyDescriptor(queryDb, "select");
  const originalSelect = queryDb.select;
  const originalDescriptor = Object.getOwnPropertyDescriptor(client, "unsafe");
  const originalUnsafe = client.unsafe;
  let armed = false;
  let consumed = false;
  let releaseGetRunCallerCaptured = false;
  let releaseGetRunCallerWasCaptured = false;
  queryDb.select = function (...args) {
    const stack = new Error().stack ?? "";
    if (armed && stack.includes("releaseFinishedRun") && stack.includes("getRun")) {
      releaseGetRunCallerCaptured = true;
      releaseGetRunCallerWasCaptured = true;
    }
    return originalSelect.apply(queryDb, args);
  };
  client.unsafe = function (...args: Parameters<PostgresClient["unsafe"]>) {
    const [query, params] = args;
    const isExactRunRead = query.trimStart().toUpperCase().startsWith("SELECT")
      && query.includes('from "heartbeat_runs"')
      && query.includes('"heartbeat_runs"."id" = $1')
      && params?.[0] === heartbeatRunId;
    const releaseGetRunRead = releaseGetRunCallerCaptured;
    releaseGetRunCallerCaptured = false;
    if (armed && releaseGetRunRead && isExactRunRead) {
      armed = false;
      consumed = true;
      process.stderr.write(`[c5-held-settlement-fault] ${JSON.stringify({
        fault: "one_shot_exact_release_run_read",
        heartbeatRunId,
        caller: "releaseFinishedRun.getRun",
        querySha256: createHash("sha256").update(query).digest("hex"),
      })}\n`);
      throw new Error("c5_transient_exact_release_run_read_failure");
    }
    return Reflect.apply(originalUnsafe, client, args);
  };
  return {
    arm: () => { armed = true; },
    get consumed() { return consumed; },
    get callerCaptured() { return releaseGetRunCallerWasCaptured; },
    restore: () => {
      if (originalSelectDescriptor) Object.defineProperty(queryDb, "select", originalSelectDescriptor);
      else Reflect.deleteProperty(queryDb, "select");
      if (originalDescriptor) Object.defineProperty(client, "unsafe", originalDescriptor);
      else Reflect.deleteProperty(client, "unsafe");
    },
  };
}

export async function waitForMarker(markerPath: string, label: string): Promise<void> {
  const exists = async () => { try { await stat(markerPath); return true; } catch { return false; } };
  if (await exists()) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const events = watch(path.dirname(markerPath), { signal: controller.signal });
  try {
    if (await exists()) return;
    for await (const _event of events) if (await exists()) return;
    throw new Error(`${label} exited before its start marker`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`timed out waiting for ${label} start marker`);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
