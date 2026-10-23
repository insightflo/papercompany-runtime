import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, operatorDecisionContinuations, operatorDecisions,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict } from "../../errors.js";
import { readPauseChildProof } from "../heartbeat-pause-admission.js";
import { assertOwnerHumanDecisionCurrent, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "../operator-decision-currentness.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "../operator-decision-continuation-store.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, sameOwnerHumanValue,
  type OwnerHumanTx } from "./owner-human-request-contract.js";

export type OwnerResponseScope = {
  companyId: string; agentId: string; issueId?: string | null; missionId?: string | null;
  workflowRunId?: string | null; workflowStepRunId?: string | null; contextSnapshot?: unknown;
  wakeupRequestId?: string | null; idempotencyKey?: string | null; source?: string | null;
  reason?: string | null; payload?: unknown; requestedByActorType?: string | null;
  requestedByActorId?: string | null; operatorDecisionInitialAdmission?: boolean;
  operatorDecisionStoredAdmission?: boolean;
  operatorDecisionAdapterBoundary?: boolean;
};
type Run = typeof heartbeatRuns.$inferSelect;
export type OwnerResponseRun = Run;
type Wake = typeof agentWakeupRequests.$inferSelect;
const resolutionRef = z.object({ operatorDecisionId: z.string().uuid(), options: z.array(z.object({
  id: z.string(), label: z.string(), description: z.string().nullable(),
}).strict()) }).strict();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function readMarker(input: OwnerResponseScope, context: Record<string, unknown>) {
  if (!input.operatorDecisionInitialAdmission && !input.operatorDecisionStoredAdmission) return null;
  const payload = record(input.payload), rawPayload = payload.paperclipOperatorDecisionResolution;
  const rawContext = context.paperclipOperatorDecisionResolution;
  const marked = input.idempotencyKey?.startsWith(OPERATOR_DECISION_WAKE_PREFIX)
    || input.reason === "operator_decision_resolved" || payload.kind === "operator_decision_resolution"
    || context.wakeReason === "operator_decision_resolved" || payload.operatorDecisionId !== undefined
    || context.operatorDecisionId !== undefined || rawPayload !== undefined || rawContext !== undefined;
  if (!marked) return null;
  const keyId = input.idempotencyKey?.startsWith(OPERATOR_DECISION_WAKE_PREFIX)
    ? input.idempotencyKey.slice(OPERATOR_DECISION_WAKE_PREFIX.length).split(":g")[0] : null;
  const ids = [...new Set([payload.operatorDecisionId, context.operatorDecisionId,
    record(rawPayload).operatorDecisionId, record(rawContext).operatorDecisionId, keyId]
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
  return { ids, rawPayload, rawContext };
}

/** Validate an exact current C08 response. Non-owner decision wakes return null. */
export async function assertOwnerHumanResponseDelivery(db: Db, input: OwnerResponseScope) {
  const context = record(input.contextSnapshot), marker = readMarker(input, context);
  if (!marker) return null;
  const validIds = marker.ids.filter(id => z.string().uuid().safeParse(id).success);
  const decisions = validIds.length ? await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId), inArray(operatorDecisions.id, validIds))) : [];
  if (!marker.ids.length || validIds.length !== marker.ids.length || !decisions.length) {
    throw conflict("operator_decision_delivery_reference_invalid");
  }
  const ownerCards = decisions.filter(row => row.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE);
  if (!ownerCards.length) return null;
  const decision = ownerCards[0]!, decisionId = decision.id;
  const fromPayload = resolutionRef.safeParse(marker.rawPayload);
  const fromContext = resolutionRef.safeParse(marker.rawContext);
  if (ownerCards.length !== 1 || marker.ids.some(id => id !== decisionId) || !fromPayload.success
    || !fromContext.success || !same(fromPayload.data, fromContext.data)) {
    throw conflict("operator_decision_delivery_reference_invalid");
  }
  await assertOwnerHumanDecisionCurrent(db as unknown as OwnerHumanTx, decision);
  let [continuation] = await db.select().from(operatorDecisionContinuations).where(and(
    eq(operatorDecisionContinuations.companyId, input.companyId),
    eq(operatorDecisionContinuations.operatorDecisionId, decisionId))).for("update");
  const payload = record(input.payload), selectedOptionIds = decision.result?.selectedOptionIds ?? [];
  const byId = new Map(decision.definition.options.map(option => [option.id, option]));
  const expectedResolution = { operatorDecisionId: decision.id, options: selectedOptionIds.map(id => {
    const option = byId.get(id);
    return option ? { id: option.id, label: option.label, description: option.description }
      : { id, label: id, description: null };
  }) };
  const expectedKey = continuation
    ? `${OPERATOR_DECISION_WAKE_PREFIX}${decisionId}:g${continuation.generation}:a${continuation.attemptCount}` : null;
  const storedPending = input.operatorDecisionStoredAdmission && continuation?.state === "leased"
    && continuation.wakeupRequestId === null;
  if (decision.status !== "resolved" || !decision.result || !same(fromPayload.data, expectedResolution)
    || payload.operatorDecisionId !== decisionId || context.operatorDecisionId !== decisionId
    || input.missionId !== decision.sourceContext.missionId || context.missionId !== decision.sourceContext.missionId
    || payload.actionId !== decision.result.actionId || !same(payload.selectedOptionIds, selectedOptionIds)
    || context.wakeReason !== "operator_decision_resolved" || !continuation
    || (input.operatorDecisionStoredAdmission ? !storedPending && (continuation.state !== "accepted"
      || continuation.wakeupRequestId !== input.wakeupRequestId) : continuation.state !== "leased")
    || continuation.targetAgentId !== input.agentId || !continuation.issueId
    || continuation.issueId !== input.issueId || continuation.issueId !== text(payload.issueId)
    || continuation.issueId !== text(context.issueId) || continuation.idempotencyKey !== expectedKey
    || input.idempotencyKey !== expectedKey || input.source !== "automation"
    || (input.operatorDecisionStoredAdmission
      ? !["operator_decision_resolved", "issue_execution_deferred", "issue_execution_promoted"].includes(input.reason ?? "")
      : input.reason !== "operator_decision_resolved")
    || payload.kind !== "operator_decision_resolution" || input.requestedByActorType !== "user"
    || input.requestedByActorId !== decision.resolvedByUserId) {
    throw conflict("operator_decision_delivery_identity_mismatch");
  }
  if (storedPending && input.operatorDecisionAdapterBoundary) {
    const now = new Date();
    const [accepted] = await db.update(operatorDecisionContinuations).set({ state: "accepted",
      wakeupRequestId: input.wakeupRequestId, acceptedAt: now, leaseOwner: null,
      leaseExpiresAt: null, errorCode: null, errorSummary: null, updatedAt: now,
    }).where(and(eq(operatorDecisionContinuations.id, continuation.id),
      eq(operatorDecisionContinuations.state, "leased"),
      eq(operatorDecisionContinuations.generation, continuation.generation),
      eq(operatorDecisionContinuations.attemptCount, continuation.attemptCount),
      eq(operatorDecisionContinuations.idempotencyKey, expectedKey!),
      eq(operatorDecisionContinuations.targetAgentId, input.agentId),
      eq(operatorDecisionContinuations.issueId, input.issueId!),
    )).returning();
    if (accepted) {
      continuation = accepted;
      await db.insert(activityLog).values({ companyId: accepted.companyId, actorType: "system",
        actorId: "owner-human-response-boundary", action: "operator_decision.continuation_accepted",
        entityType: "operator_decision", entityId: decisionId, details: { schemaVersion: 1,
          operatorDecisionId: decisionId, continuationId: accepted.id, generation: accepted.generation,
          attempt: accepted.attemptCount, targetAgentId: accepted.targetAgentId,
          wakeupRequestId: accepted.wakeupRequestId, effectiveStatus: "claimed", errorCode: null },
      });
    } else {
      [continuation] = await db.select().from(operatorDecisionContinuations).where(and(
        eq(operatorDecisionContinuations.companyId, input.companyId),
        eq(operatorDecisionContinuations.operatorDecisionId, decisionId)));
      if (continuation?.state !== "accepted" || continuation.wakeupRequestId !== input.wakeupRequestId) {
        throw conflict("operator_decision_delivery_pending_acceptance");
      }
    }
  }
  if (storedPending && continuation.state !== "accepted") {
    throw conflict("operator_decision_delivery_pending_acceptance");
  }
  if (!decision.requestKey.startsWith("moi2:")) {
    return { lifetimeId: null, operatorDecisionId: decisionId };
  }
  const lifetimeId = z.string().uuid().safeParse(decision.requestKey.slice("moi2:".length));
  if (!lifetimeId.success) throw conflict("operator_decision_delivery_reference_invalid");
  return { lifetimeId: lifetimeId.data, operatorDecisionId: decisionId };
}

const childKinds = new Set(["process_lost_retry", "adapter_failed_retry", "adapter_fallback", "agent_pause_resume"]);
const wakeIdentity = (row: Wake) => ({ id: row.id, companyId: row.companyId,
    agentId: row.agentId, issueId: row.issueId, missionId: row.missionId,
    workflowRunId: row.workflowRunId, workflowStepRunId: row.workflowStepRunId,
    workflowExecutionGeneration: row.workflowExecutionGeneration, runId: row.runId,
    source: row.source, reason: row.reason, requestKind: row.requestKind, payload: row.payload,
    requestedByActorType: row.requestedByActorType, requestedByActorId: row.requestedByActorId,
    idempotencyKey: row.idempotencyKey });
const responseContext = (wake: Wake) => {
  const payload = record(wake.payload);
  return { issueId: wake.issueId, missionId: wake.missionId,
    wakeReason: "operator_decision_resolved", operatorDecisionId: payload.operatorDecisionId,
    paperclipOperatorDecisionResolution: payload.paperclipOperatorDecisionResolution };
};

async function assertResponseChild(db: Db, run: Run, wake: Wake) {
  const kind = wake.requestKind;
  if (!kind || !childKinds.has(kind)) return false;
  const context = record(run.contextSnapshot), payload = record(wake.payload);
  if (!readMarker({ ...wake, contextSnapshot: context, operatorDecisionStoredAdmission: true }, context)) {
    return false;
  }
  const parentKey = kind === "adapter_fallback" ? "fallbackOfRunId" : "retryOfRunId";
  if (!run.retryOfRunId || wake.runId !== run.id || wake.companyId !== run.companyId
    || wake.agentId !== run.agentId || wake.issueId !== run.issueId || wake.source !== "automation"
    || wake.reason !== kind || wake.requestedByActorType !== "system" || wake.requestedByActorId !== null
    || wake.idempotencyKey !== null
    || (kind !== "agent_pause_resume" && payload[parentKey] !== run.retryOfRunId)) {
    throw conflict("owner_human_response_child_identity_mismatch");
  }
  if (kind === "agent_pause_resume") {
    const proof = await readPauseChildProof(db, run, true);
    if (!proof || proof.parent.id !== run.retryOfRunId) {
      throw conflict("owner_human_response_child_identity_mismatch");
    }
  }
  return true;
}

async function responseForRun(db: Db, supplied: OwnerResponseRun) {
  const [candidateWake] = supplied.wakeupRequestId ? await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, supplied.wakeupRequestId)) : [];
  const marker = readMarker({ ...candidateWake, companyId: supplied.companyId, agentId: supplied.agentId,
    operatorDecisionStoredAdmission: true }, record(supplied.contextSnapshot));
  const decisionIds = marker?.ids.filter(id => z.string().uuid().safeParse(id).success) ?? [];
  if (!decisionIds.length) return null;
  // Classification is not authority: only a durable owner card activates the strict C08 checks below.
  const [ownerCard] = await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
    inArray(operatorDecisions.id, decisionIds), eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE)));
  if (!ownerCard) return null;
  const seen = new Set<string>(), wakes: Wake[] = [];
  let run: OwnerResponseRun | undefined = supplied;
  while (run) {
    if (seen.has(run.id) || seen.size >= 32 || !run.wakeupRequestId) {
      throw conflict("owner_human_response_lineage_invalid");
    }
    seen.add(run.id);
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId)));
    if (!wake) throw conflict("owner_human_response_wake_missing");
    if (wake.runId !== run.id || wake.agentId !== run.agentId || wake.issueId !== run.issueId) {
      throw conflict("owner_human_response_run_identity_mismatch");
    }
    wakes.push(wake);
    if (await assertResponseChild(db, run, wake)) {
      const [parent] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, run.retryOfRunId!), eq(heartbeatRuns.companyId, supplied.companyId)));
      if (!parent || parent.agentId !== supplied.agentId || parent.issueId !== supplied.issueId) {
        throw conflict("owner_human_response_lineage_invalid");
      }
      run = parent;
      continue;
    }
    if (!readMarker({ ...wake, contextSnapshot: {}, operatorDecisionStoredAdmission: true }, {})) {
      return null;
    }
    const response = await assertOwnerHumanResponseDelivery(db, {
      companyId: run.companyId, agentId: run.agentId, issueId: wake.issueId, missionId: wake.missionId,
      workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId,
      contextSnapshot: responseContext(wake), wakeupRequestId: wake.id, idempotencyKey: wake.idempotencyKey,
      source: wake.source, reason: wake.reason, payload: wake.payload,
      requestedByActorType: wake.requestedByActorType, requestedByActorId: wake.requestedByActorId,
      operatorDecisionStoredAdmission: true, operatorDecisionAdapterBoundary: true,
    });
    if (!response) return null;
    const locked = new Map<string, Wake>();
    for (const candidate of [...wakes].sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, candidate.id), eq(agentWakeupRequests.companyId, candidate.companyId))).for("share");
      if (!row || !sameOwnerHumanValue(wakeIdentity(row), wakeIdentity(candidate))) {
        throw conflict("owner_human_response_wake_changed");
      }
      locked.set(row.id, row);
    }
    return { ...response, responseRunId: run.id, responseWake: locked.get(wake.id)!,
      actualWake: locked.get(wakes[0]!.id)! };
  }
  throw conflict("owner_human_response_lineage_invalid");
}

async function recordBoundary(db: Db, run: Run, kind: "owner_human_adapter_start_v1" | "owner_human_consumed_v1") {
  const response = await responseForRun(db, run);
  if (!response) return null;
  // Legacy moi1 delivery remains valid, but has no C08 lifetime to consume.
  if (!response.lifetimeId) return response;
  const payload = { schemaVersion: 1, kind, lifetimeId: response.lifetimeId,
    operatorDecisionId: response.operatorDecisionId, heartbeatRunId: run.id,
    wakeupRequestId: response.actualWake.id, responseHeartbeatRunId: response.responseRunId,
    responseWakeupRequestId: response.responseWake.id };
  const key = `${kind}:${response.lifetimeId}:${run.id}`;
  const inserted = await db.insert(workflowTransitionEvents).values({
    companyId: run.companyId, missionId: response.responseWake.missionId, issueId: run.issueId,
    wakeupRequestId: response.actualWake.id, heartbeatRunId: run.id, eventType: kind,
    layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE, reasonCode: OWNER_HUMAN_SOURCE,
    idempotencyKey: key, payload,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (!inserted.length) {
    const [existing] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.idempotencyKey, key)));
    if (!existing || existing.eventType !== kind || !sameOwnerHumanValue(existing.payload, payload)) {
      throw conflict("owner_human_response_boundary_conflict");
    }
  }
  return response;
}

export const recordOwnerHumanAdapterStart = (db: Db, run: Run) =>
  recordBoundary(db, run, "owner_human_adapter_start_v1");
export const consumeOwnerHumanResponse = (db: Db, run: Run) =>
  recordBoundary(db, run, "owner_human_consumed_v1");
export const acceptOwnerHumanResponseAtClaim = (db: Db, run: OwnerResponseRun) =>
  responseForRun(db, run);
