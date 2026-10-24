// C08 submission orchestration. The API owns the transaction and existing checkout authorizer.
// No GET, settlement integration, approval, continuation or execution admission is performed here.
import type { Db } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { ownerHumanRequestSchema } from "@paperclipai/shared/validators/owner-human-request";
import { and, eq } from "drizzle-orm";
import { conflict, forbidden, unauthorized } from "../../errors.js";
import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";
import { ownerDecisionRequestsHuman } from "./owner-tool-recovery-eligibility.js";
import { ownerRecoveryOwnerMatches } from "./owner-recovery-submission-guards.js";
import { lockOwnerHumanRequestAuthority, type OwnerHumanAuthority } from "./owner-human-request-authority.js";
import {
  ownerHumanLifetimeKey, ownerHumanSubmissionSchema,
  type OwnerHumanTx, type OwnerHumanSubmission,
} from "./owner-human-request-contract.js";
import { readOwnerHumanCurrent, saveOwnerHumanRequest,
  type OwnerHumanCurrentRecord } from "./owner-human-request-state.js";
import {
  buildMissionOwnerDecisionIdempotencyKey, ownerHumanExpectedCorrelation,
  recordMissionOwnerDecision, type MissionOwnerDecisionSubmission,
} from "./mission-owner-recovery-ledger.js";
import { materializeHumanOperatorRequestEvent } from "./human-operator-alert-events.js";
import type { MissionOwnerHumanInputCardSpec } from "./mission-owner-human-input-card.js";

export type OwnerHumanSubmissionInput = MissionOwnerDecisionSubmission & {
  readonly humanRequest?: NonNullable<MissionOwnerDecisionSubmit["humanRequest"]>;
  readonly recommendedOptionId?: string;
  readonly recommendationReason?: string;
};

// Human submission adds no quality-prefix lock of its own. Acquire the complete native
// mission/run/heartbeat/sorted-issue/step prefix before the unchanged API authorizer runs.
// Its repeated locks are then already held; checkout still belongs to that authorizer.
export async function lockOwnerHumanSubmission(tx: OwnerHumanTx, issueId: string,
  actor: OwnerRecoveryApiActor, data: MissionOwnerDecisionSubmit) {
  if (!ownerDecisionRequestsHuman(data.decision)) return null;
  if (actor.actorType !== "agent" || !actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId));
  if (!issue?.missionId || !["mission_main_executor_unblock", "mission_main_executor_oversight"].includes(issue.originKind ?? "")) {
    return null;
  }
  if (issue.originKind === "mission_main_executor_oversight" && data.recoveryTarget) {
    throw conflict("Oversight submissions cannot include a recovery target");
  }
  const [mission] = await tx.select().from(missions).where(and(
    eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId))).for("update");
  if (!ownerRecoveryOwnerMatches(mission, actor.agentId)) {
    throw forbidden("Only the mission owner agent may submit owner-recovery decisions");
  }
  return lockOwnerHumanRequestAuthority(tx, {
    companyId: issue.companyId, missionId: issue.missionId, ownerActionIssueId: issue.id,
    agentId: actor.agentId, heartbeatRunId: actor.runId, recoveryTarget: data.recoveryTarget,
  });
}

function replayEnvelope(current: OwnerHumanCurrentRecord) {
  return { schemaVersion: 1 as const, requestKey: current.lifetime.requestKey,
    expectedCurrentLifetimeId: current.lifetime.lifetimeId };
}
function identityRequired(current: OwnerHumanCurrentRecord | null, submission: OwnerHumanSubmission): never {
  throw conflict("Owner human request identity is required", {
    code: "owner_human_request_identity_required",
    reason: "owner_human_request_identity_required",
    currentLifetimeId: current?.lifetime.lifetimeId ?? null,
    recoveryNeeded: current?.pointer.recoveryNeeded ?? false,
    resubmit: current?.pointer.recoveryNeeded
      ? { ...current.lifetime.submission, humanRequest: replayEnvelope(current) } : null,
    // This is a format, not an automatically issued request identity. The caller must choose
    // and retain a new stable key when it intends replacement or recurrence.
    newRequestFormat: { ...submission, humanRequest: { schemaVersion: 1,
      requestKey: "<new-stable-request-key>",
      expectedCurrentLifetimeId: current?.lifetime.lifetimeId ?? null } },
  });
}
const currentChanged = (): never => { throw conflict("Owner human request current lifetime changed", {
  reason: "owner_human_request_current_changed",
}); };

export async function recordOwnerHumanSubmission(auth: OwnerHumanAuthority, input: OwnerHumanSubmissionInput) {
  const { humanRequest, ...body } = input;
  const submission = ownerHumanSubmissionSchema.parse(body);
  const request = humanRequest ? ownerHumanRequestSchema.parse(humanRequest) : undefined;
  const current = await readOwnerHumanCurrent(auth);
  // Legacy identity is exactly the existing ledger contract, only within its original author
  // run and anchor. Do not extend that compatibility rule into cross-run semantic matching.
  const requestKey = request?.requestKey ?? `legacy-exact:${buildMissionOwnerDecisionIdempotencyKey({
    companyId: auth.scope.companyId, ownerActionIssueId: auth.anchor.id,
    sourceIssueId: auth.source?.id ?? null, submission, heartbeatRunId: auth.heartbeatRunId,
  })}`;
  if (!request) {
    if (current && (!current.pointer.recoveryNeeded || current.lifetime.identityMode !== "legacy_exact"
      || current.lifetime.heartbeatRunId !== auth.heartbeatRunId
      || current.lifetime.anchorIssueId !== auth.anchor.id)) identityRequired(current, submission);
    const [seen] = await auth.tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, auth.scope.companyId),
        eq(workflowTransitionEvents.idempotencyKey, ownerHumanLifetimeKey(requestKey))));
    if (seen && seen.id !== current?.lifetime.lifetimeId) identityRequired(current, submission);
  }
  const replay = current?.lifetime.requestKey === requestKey ? current : null;
  const expected = request ? request.expectedCurrentLifetimeId : current?.lifetime.lifetimeId ?? null;
  if (!replay && expected !== (current?.lifetime.lifetimeId ?? null)) currentChanged();
  const [original] = replay ? await auth.tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, auth.scope.companyId),
    eq(workflowTransitionEvents.id, replay.lifetime.decisionEventId))) : [];
  if (replay && !original) throw conflict("Owner human request original decision is missing");
  // Exact retransmission may retain its original CAS input, including null for the first
  // request. Explicit current replay may instead name the current lifetime. Any other stale
  // expectation is rejected; the immutable original correlation supplies the independent fact.
  if (replay && request && expected !== replay.lifetime.lifetimeId
    && original!.correlationId !== ownerHumanExpectedCorrelation(expected)) currentChanged();
  const identityMode = replay?.lifetime.identityMode ?? (request ? "keyed" : "legacy_exact");
  const recorded = replay ? {
    eventId: replay.lifetime.decisionEventId, createdAt: original!.createdAt,
    submission: replay.lifetime.submission,
  } : await recordMissionOwnerDecision({
    db: auth.tx,
    issue: { id: auth.anchor.id, companyId: auth.scope.companyId, missionId: auth.scope.missionId },
    submission, sourceIssueId: auth.source?.id ?? null, heartbeatRunId: auth.heartbeatRunId,
    ...(request ? { humanRequest: request } : {}),
  });
  const saved = await saveOwnerHumanRequest(auth, {
    schemaVersion: 1, requestKey, expectedCurrentLifetimeId: expected, identityMode,
    decisionEventId: recorded.eventId, submission,
  });
  const lifetime = saved.lifetime;
  const card = lifetime.cardInput;
  // A replay's notification and card input belong to the immutable original anchor/display,
  // not the current heartbeat, today's issue title, or caller-supplied source reference.
  const materialized = await materializeHumanOperatorRequestEvent(auth.tx as unknown as Db, {
    issue: { id: lifetime.anchorIssueId, companyId: lifetime.scope.companyId,
      missionId: lifetime.scope.missionId,
      originKind: lifetime.scope.target.kind === "oversight"
        ? "mission_main_executor_oversight" : "mission_main_executor_unblock",
      originId: lifetime.sourceIssueId, title: card.issueTitle, identifier: card.issueIdentifier },
    record: { eventId: lifetime.decisionEventId, authorAgentId: lifetime.authorAgentId },
    decision: lifetime.submission,
  });
  // Preserve the adopted legacy moi1 contract. New explicit-key lifetimes use the stage-9
  // moi2 writer, whose own create transaction checks currentness and persists the binding.
  const humanInputCardSpec: MissionOwnerHumanInputCardSpec = {
    ...card, ...(lifetime.identityMode === "keyed" ? { lifetimeId: lifetime.lifetimeId } : {}),
  };
  return { recorded, lifetimeId: lifetime.lifetimeId, humanRequest: replayEnvelope(saved),
    humanPayload: materialized.payload, humanInserted: materialized.inserted, humanInputCardSpec };
}
