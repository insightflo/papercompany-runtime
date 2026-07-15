// Official, request-scoped structural-gate verdict ledger.

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents } from "@paperclipai/db";
import {
  readStructuralGateProducerToken,
  type StructuralGateProducerToken,
  type StructuralGateVerdict,
} from "./structural-gate.js";

type StructuralGateDb = Pick<Db, "insert" | "select">;
export type { StructuralGateVerdict };

export interface StructuralGateVerdictRecord {
  verdict: StructuralGateVerdict;
  observedAt: Date;
  reasonCode: string | null;
  reason: string | null;
  diagnostics: unknown[];
  producerToken: StructuralGateProducerToken | null;
}

export function parseStructuralGateVerdict(data: unknown): StructuralGateVerdict | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const verdict = (data as Record<string, unknown>).verdict;
  return verdict === "pass" || verdict === "request_changes" ? verdict : null;
}

function readDiagnostics(data: unknown): unknown[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const diagnostics = (data as Record<string, unknown>).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics.slice(0, 20) : [];
}

function readReason(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const reason = (data as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 1000) : null;
}

function idempotencyKey(companyId: string, workflowStepRunId: string, requestId: string | null): string {
  return requestId
    ? `structural-gate-verdict:${companyId}:${workflowStepRunId}:${requestId}`
    : `structural-gate-verdict:${companyId}:${workflowStepRunId}`;
}

function toVerdictRecord(row: {
  verdict: string | null;
  createdAt: Date | null;
  reasonCode: string | null;
  reason: string | null;
  payload: unknown;
} | undefined): StructuralGateVerdictRecord | null {
  if (!row || (row.verdict !== "pass" && row.verdict !== "request_changes")) return null;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  return {
    verdict: row.verdict,
    observedAt: row.createdAt ?? new Date(0),
    reasonCode: row.reasonCode,
    reason: row.reason,
    diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
    producerToken: readStructuralGateProducerToken(payload.producerToken),
  };
}

/** Records one exact-request verdict. Conflict resolution loads that exact row;
 * it never falls back to latest state or the incoming callback. */
export async function recordStructuralGateVerdict(input: {
  db: StructuralGateDb;
  companyId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  missionId?: string | null;
  verdict: StructuralGateVerdict;
  toolResultData: unknown;
  requestId: string;
  producerToken: StructuralGateProducerToken | null;
}): Promise<{ inserted: boolean; authoritativeVerdict: StructuralGateVerdict }> {
  const inserted = await input.db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId ?? null,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    issueId: null,
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    decision: input.verdict,
    reason: readReason(input.toolResultData),
    reasonCode: "workflow_tool_result",
    idempotencyKey: idempotencyKey(input.companyId, input.workflowStepRunId, input.requestId),
    payload: {
      kind: "structural_gate_verdict",
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      requestId: input.requestId,
      verdict: input.verdict,
      diagnostics: readDiagnostics(input.toolResultData),
      producerToken: input.producerToken,
    },
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (inserted.length > 0) return { inserted: true, authoritativeVerdict: input.verdict };

  const existing = await loadStructuralGateVerdictByRequest(
    input.db, input.companyId, input.workflowStepRunId, input.requestId,
  );
  if (!existing) {
    throw new Error(`Structural gate verdict conflict lacks exact row for ${input.workflowStepRunId}/${input.requestId}.`);
  }
  return { inserted: false, authoritativeVerdict: existing.verdict };
}

/** Exact request-scoped ledger read used by semantic launch, rework, and
 * duplicate callback resolution. */
export async function loadStructuralGateVerdictByRequest(
  db: StructuralGateDb,
  companyId: string,
  workflowStepRunId: string,
  requestId: string,
): Promise<StructuralGateVerdictRecord | null> {
  const rows = await db.select({
    verdict: workflowTransitionEvents.verdict,
    createdAt: workflowTransitionEvents.createdAt,
    reasonCode: workflowTransitionEvents.reasonCode,
    reason: workflowTransitionEvents.reason,
    payload: workflowTransitionEvents.payload,
  }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId),
    eq(workflowTransitionEvents.workflowStepRunId, workflowStepRunId),
    eq(workflowTransitionEvents.idempotencyKey, idempotencyKey(companyId, workflowStepRunId, requestId)),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.reasonCode, "workflow_tool_result"),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  return toVerdictRecord(rows[0]);
}
