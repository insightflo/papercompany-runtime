import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";

const EVENT_TYPE = "owner_cap_override_retry";
const P = workflowTransitionEvents.payload;

type RunRow = typeof workflowRuns.$inferSelect;
type StepRunRow = typeof workflowStepRuns.$inferSelect;

type NullableDateSnapshot = string | null;

export interface CapOverridePriorSnapshot {
  run: {
    id: string;
    status: string;
    startedAt: NullableDateSnapshot;
    completedAt: NullableDateSnapshot;
  };
  stepRun: {
    id: string;
    status: string;
    iterationIndex: number;
    startedAt: NullableDateSnapshot;
    completedAt: NullableDateSnapshot;
    lastDispatchAttemptAt: NullableDateSnapshot;
    lastDispatchAcceptedAt: NullableDateSnapshot;
    lastDispatchErrorAt: NullableDateSnapshot;
    lastDispatchErrorSummary: string | null;
    lastDispatchRequestId: string | null;
    metadata: Record<string, unknown>;
  };
  issue: {
    id: string;
    status: string;
    completedAt: NullableDateSnapshot;
    updatedAt: string;
  };
}

const iso = (value: Date | null): NullableDateSnapshot => value?.toISOString() ?? null;
const asDate = (value: NullableDateSnapshot): Date | null => value === null ? null : new Date(value);
const cas = <T>(column: T, value: unknown): SQL => value === null || value === undefined
  ? isNull(column as never)
  : eq(column as never, value as never);

export function buildCapOverridePriorSnapshot(input: {
  run: RunRow;
  stepRun: StepRunRow;
  issue: { id: string; status: string; completedAt: Date | null; updatedAt: Date };
}): CapOverridePriorSnapshot {
  return {
    run: {
      id: input.run.id,
      status: input.run.status,
      startedAt: iso(input.run.startedAt),
      completedAt: iso(input.run.completedAt),
    },
    stepRun: {
      id: input.stepRun.id,
      status: input.stepRun.status,
      iterationIndex: input.stepRun.iterationIndex,
      startedAt: iso(input.stepRun.startedAt),
      completedAt: iso(input.stepRun.completedAt),
      lastDispatchAttemptAt: iso(input.stepRun.lastDispatchAttemptAt),
      lastDispatchAcceptedAt: iso(input.stepRun.lastDispatchAcceptedAt),
      lastDispatchErrorAt: iso(input.stepRun.lastDispatchErrorAt),
      lastDispatchErrorSummary: input.stepRun.lastDispatchErrorSummary,
      lastDispatchRequestId: input.stepRun.lastDispatchRequestId,
      metadata: input.stepRun.metadata,
    },
    issue: {
      id: input.issue.id,
      status: input.issue.status,
      completedAt: iso(input.issue.completedAt),
      updatedAt: input.issue.updatedAt.toISOString(),
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function dateText(value: unknown, nullable: boolean): string | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

export function parseCapOverridePriorSnapshot(value: unknown): CapOverridePriorSnapshot | null {
  const root = record(value);
  const run = record(root?.run);
  const stepRun = record(root?.stepRun);
  const issue = record(root?.issue);
  const metadata = record(stepRun?.metadata);
  if (!run || !stepRun || !issue || !metadata) return null;

  const runStartedAt = dateText(run.startedAt, true);
  const runCompletedAt = dateText(run.completedAt, true);
  const stepStartedAt = dateText(stepRun.startedAt, true);
  const stepCompletedAt = dateText(stepRun.completedAt, true);
  const lastDispatchAttemptAt = dateText(stepRun.lastDispatchAttemptAt, true);
  const lastDispatchAcceptedAt = dateText(stepRun.lastDispatchAcceptedAt, true);
  const lastDispatchErrorAt = dateText(stepRun.lastDispatchErrorAt, true);
  const issueCompletedAt = dateText(issue.completedAt, true);
  const issueUpdatedAt = dateText(issue.updatedAt, false);
  const lastDispatchErrorSummary = nullableText(stepRun.lastDispatchErrorSummary);
  const lastDispatchRequestId = nullableText(stepRun.lastDispatchRequestId);
  if (
    runStartedAt === undefined || runCompletedAt === undefined ||
    stepStartedAt === undefined || stepCompletedAt === undefined ||
    lastDispatchAttemptAt === undefined || lastDispatchAcceptedAt === undefined ||
    lastDispatchErrorAt === undefined || issueCompletedAt === undefined ||
    issueUpdatedAt === undefined || issueUpdatedAt === null ||
    lastDispatchErrorSummary === undefined || lastDispatchRequestId === undefined ||
    !Number.isInteger(stepRun.iterationIndex)
  ) return null;

  const runId = text(run.id);
  const runStatus = text(run.status);
  const stepRunId = text(stepRun.id);
  const stepStatus = text(stepRun.status);
  const issueId = text(issue.id);
  const issueStatus = text(issue.status);
  if (!runId || !runStatus || !stepRunId || !stepStatus || !issueId || !issueStatus) return null;

  return {
    run: { id: runId, status: runStatus, startedAt: runStartedAt, completedAt: runCompletedAt },
    stepRun: {
      id: stepRunId,
      status: stepStatus,
      iterationIndex: stepRun.iterationIndex as number,
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
      lastDispatchAttemptAt,
      lastDispatchAcceptedAt,
      lastDispatchErrorAt,
      lastDispatchErrorSummary,
      lastDispatchRequestId,
      metadata,
    },
    issue: { id: issueId, status: issueStatus, completedAt: issueCompletedAt, updatedAt: issueUpdatedAt },
  };
}

export interface RestoreCapOverrideSnapshotInput {
  companyId: string;
  snapshot: CapOverridePriorSnapshot;
  cleanedMetadata: Record<string, unknown>;
  toIteration: number;
  forwardedIssueUpdatedAt: string;
  auditIdempotencyKey: string;
  auditPayload: Record<string, unknown>;
  dispatchToken?: string;
  rollbackReason?: string;
}

export async function restoreCapOverrideSnapshotInTransaction(
  db: Db,
  input: RestoreCapOverrideSnapshotInput,
): Promise<void> {
  const snapshot = input.snapshot;
  const forwardedIssueUpdatedAt = new Date(input.forwardedIssueUpdatedAt);
  if (Number.isNaN(forwardedIssueUpdatedAt.getTime())) throw new Error("cap-override-rollback-invalid-forward-time");

  const s = workflowStepRuns;
  const stepRestored = await db.update(s).set({
    status: snapshot.stepRun.status,
    iterationIndex: snapshot.stepRun.iterationIndex,
    startedAt: asDate(snapshot.stepRun.startedAt),
    completedAt: asDate(snapshot.stepRun.completedAt),
    lastDispatchAttemptAt: asDate(snapshot.stepRun.lastDispatchAttemptAt),
    lastDispatchAcceptedAt: asDate(snapshot.stepRun.lastDispatchAcceptedAt),
    lastDispatchErrorAt: asDate(snapshot.stepRun.lastDispatchErrorAt),
    lastDispatchErrorSummary: snapshot.stepRun.lastDispatchErrorSummary,
    lastDispatchRequestId: snapshot.stepRun.lastDispatchRequestId,
    metadata: snapshot.stepRun.metadata,
  }).where(and(
    eq(s.id, snapshot.stepRun.id),
    eq(s.status, "pending"),
    eq(s.iterationIndex, input.toIteration),
    isNull(s.startedAt),
    isNull(s.completedAt),
    isNull(s.lastDispatchAttemptAt),
    isNull(s.lastDispatchAcceptedAt),
    isNull(s.lastDispatchErrorAt),
    isNull(s.lastDispatchErrorSummary),
    isNull(s.lastDispatchRequestId),
    eq(s.metadata, input.cleanedMetadata),
  )).returning({ id: s.id });
  if (stepRestored.length !== 1) throw new Error("cap-override-rollback-step-cas-lost");

  const r = workflowRuns;
  const runRestored = await db.update(r).set({
    status: snapshot.run.status,
    startedAt: asDate(snapshot.run.startedAt),
    completedAt: asDate(snapshot.run.completedAt),
  }).where(and(
    eq(r.id, snapshot.run.id),
    eq(r.companyId, input.companyId),
    eq(r.status, "running"),
    cas(r.startedAt, asDate(snapshot.run.startedAt)),
    isNull(r.completedAt),
  )).returning({ id: r.id });
  if (runRestored.length !== 1) throw new Error("cap-override-rollback-run-cas-lost");

  const issueRestored = await db.update(issues).set({
    status: snapshot.issue.status,
    completedAt: asDate(snapshot.issue.completedAt),
    updatedAt: new Date(snapshot.issue.updatedAt),
  }).where(and(
    eq(issues.id, snapshot.issue.id),
    eq(issues.companyId, input.companyId),
    eq(issues.status, "todo"),
    isNull(issues.completedAt),
    eq(issues.updatedAt, forwardedIssueUpdatedAt),
  )).returning({ id: issues.id });
  if (issueRestored.length !== 1) throw new Error("cap-override-rollback-issue-cas-lost");

  const auditWhere = input.dispatchToken
    ? and(
        eq(workflowTransitionEvents.companyId, input.companyId),
        eq(workflowTransitionEvents.eventType, EVENT_TYPE),
        eq(workflowTransitionEvents.idempotencyKey, input.auditIdempotencyKey),
        sqlStatus("dispatching"),
        sqlToken(input.dispatchToken),
      )
    : and(
        eq(workflowTransitionEvents.companyId, input.companyId),
        eq(workflowTransitionEvents.eventType, EVENT_TYPE),
        eq(workflowTransitionEvents.idempotencyKey, input.auditIdempotencyKey),
        sqlStatus("pending"),
      );
  const rolled = await db.update(workflowTransitionEvents).set({
    payload: {
      ...input.auditPayload,
      status: "rolled_back",
      rollbackReason: input.rollbackReason ?? "dispatch_failed",
      dispatchToken: null,
      dispatchStartedAt: null,
      acceptedWakeupRequestId: null,
    },
  }).where(auditWhere).returning({ id: workflowTransitionEvents.id });
  if (rolled.length !== 1) throw new Error("cap-override-rollback-audit-cas-lost");
}

const sqlStatus = (status: string): SQL => sql`${P}->>'status' = ${status}`;
const sqlToken = (token: string): SQL => sql`${P}->>'dispatchToken' = ${token}`;

export async function casRestoreCapOverrideSnapshot(
  db: Db,
  input: RestoreCapOverrideSnapshotInput,
): Promise<"restored" | "lost"> {
  try {
    await db.transaction(async (tx) => {
      await restoreCapOverrideSnapshotInTransaction(tx as unknown as Db, input);
    });
    return "restored";
  } catch {
    return "lost";
  }
}
