import { randomUUID } from "node:crypto";
import { assertRunNotReplaced } from "../run-replacement-guard.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, missions, workflowResumeRequests, workflowRuns } from "@paperclipai/db";
import type { Express } from "express";
import { resumeRequestSchema, type ResumeRequestBody } from "@paperclipai/shared/validators/workflow-resume";
import { conflict, forbidden, unauthorized } from "../../../errors.js";
import { hashStructuredValue } from "../../issue-execution-cards/hash.js";
import {
  assertResumeCountersSafe,
  assertSnapshotScopeMatches,
  buildResumeBeforeState,
  resolveAffectedRows,
} from "./apply-state.js";
import { assembleResumePreview, type ResumePreviewResult, type ResumeSnapshotSigner } from "./preview.js";
import { readResumeRequest, type ResumeRequestView } from "./request-store.js";
import { resetForResume } from "./reset.js";
import type { ResumeMutationTransaction, ResumeRunRow, ResumeSerializationContext } from "./serialization.js";
import { withResumeSerialization } from "./serialization.js";
import { hashSnapshotState, verifySnapshot } from "./snapshot.js";

/** Resume 원자 코어: 인증 후 mission→run→steps 잠금 아래 preview, 요청, reset, run/mission,
 * 감사까지 함께 커밋한다. replay는 company+run+idempotencyKey로 판정하고 실행 레코드는 만들지 않는다.
 * 감사에는 토큰·사유 원문·메타데이터를 넣지 않는다. */

export type ResumeApplySigner = ResumeSnapshotSigner;

/**
 * resume 요청을 원자적으로 적용한다. preview 재검증 → durable 요청 영속 → reset → run/mission 전이 →
 * 감사까지 하나의 트랜잭션에서 실행한다. 어떤 실행 레코드도 만들지 않는다.
 */
export async function applyResume(
  db: Db,
  actor: Express.Request["actor"],
  rawBody: unknown,
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  const body: ResumeRequestBody = resumeRequestSchema.parse(rawBody);
  assertBoardAuthorization(actor, body.companyId);
  const requestHash = hashStructuredValue(body);
  return applyVerifiedResumeBody(db, body,
    { actorType: "user", actorId: actor.userId ?? "board" }, signer);
}

/** [승인=재개 2026-10-23] 감사 주체 — 보드 요청은 실제 인증 actor에서, 운영자 결정 승인은
 *   system 주체 + 결정/사용자 근거로 기록된다(보드 actor 위장 경로는 존재하지 않는다). */
export type ResumeAuditActor = {
  actorType: "user" | "system";
  actorId: string;
  details?: Record<string, unknown>;
};

/** 검증된 본문으로 재개를 원자 적용한다 — 권한 검증은 각 진입점(보드/운영자 결정)이 이미 완료했다. */
async function applyVerifiedResumeBody(
  db: Db,
  body: ResumeRequestBody,
  audit: ResumeAuditActor,
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  const requestHash = hashStructuredValue(body);
  return withResumeSerialization(
    db,
    { companyId: body.companyId, missionId: body.missionId, runId: body.workflowRunId },
    (context) => applyInsideLock(context, body, requestHash, audit, signer),
  );
}

export type OperatorDecisionResumeAuthorization = {
  kind: "operator_decision";
  operatorDecisionId: string;
  resolvedByUserId: string;
};

/** 운영자 결정 ID를 권한·멱등 키로 사용하며 preview가 부적격이면 fail-closed 한다. */
export async function applyResumeForOperatorDecision(
  db: Db,
  input: { companyId: string; missionId: string; workflowRunId: string; startStepId: string; reason: string;
    idempotencyKey: string; authorization: OperatorDecisionResumeAuthorization },
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  return withResumeSerialization(
    db,
    { companyId: input.companyId, missionId: input.missionId, runId: input.workflowRunId },
    (context) => applyResumeForOperatorDecisionInsideSerialization(context, input, signer),
  );
}

/** 이미 mission→run→steps 잠금을 획득한 결정 resolve 트랜잭션에서 resume를 함께 적용한다.
 *  이 함수는 새 트랜잭션을 열지 않으며, 호출자가 실패를 삼키면 안 된다. */
export async function applyResumeForOperatorDecisionInsideSerialization(
  context: ResumeSerializationContext,
  input: { companyId: string; missionId: string; workflowRunId: string; startStepId: string; reason: string;
    idempotencyKey: string; authorization: OperatorDecisionResumeAuthorization },
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  const { tx } = context;
  // replay 우선: 이미 적용된 요청이면 조립 없이 그대로 돌려준다(토큰은 호출마다 달라지므로 선검사).
  const existing = await tx.select({ id: workflowResumeRequests.id }).from(workflowResumeRequests)
    .where(and(eq(workflowResumeRequests.companyId, input.companyId),
      eq(workflowResumeRequests.workflowRunId, input.workflowRunId),
      eq(workflowResumeRequests.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (existing.length > 0) {
    return readResumeRequest(tx, { companyId: input.companyId, missionId: input.missionId, requestId: existing[0]!.id });
  }
  const fresh = await assembleResumePreview(tx, {
    companyId: input.companyId, missionId: input.missionId,
    workflowRunId: input.workflowRunId, startStepId: input.startStepId,
  }, signer);
  if (!fresh.preview.eligible || fresh.state === null || fresh.preview.token === null) {
    throw conflict("resume_blocked", { blockers: fresh.preview.blockers });
  }
  const body: ResumeRequestBody = {
    schemaVersion: 1, mode: "resume_from_step",
    companyId: input.companyId, missionId: input.missionId, workflowRunId: input.workflowRunId,
    startStepId: input.startStepId, snapshotToken: fresh.preview.token,
    idempotencyKey: input.idempotencyKey, reason: input.reason,
  };
  return applyInsideLock(context, body, hashStructuredValue(body), {
    actorType: "system", actorId: "system:operator-decision-resume",
    details: { operatorDecisionId: input.authorization.operatorDecisionId,
      resolvedByUserId: input.authorization.resolvedByUserId },
  }, signer);
}

/** routes/authz.ts 의 assertBoard + assertCompanyAccess board 경과 동일한 조건(사전 검증, DB 접근 없음). */
function assertBoardAuthorization(actor: Express.Request["actor"], companyId: string): void {
  if (actor.type === "none") throw unauthorized();
  if (actor.type !== "board") throw forbidden("Board access required");
  if (
    actor.source !== "local_implicit"
    && actor.isInstanceAdmin !== true
    && !(actor.companyIds ?? []).includes(companyId)
  ) {
    throw forbidden("User does not have access to this company");
  }
}

/** 같은 company+run+idempotencyKey 요청의 replay/conflict 판정(잠금 하에서만 호출된다). */
async function findReplayableRequest(
  tx: ResumeMutationTransaction,
  body: ResumeRequestBody,
  requestHash: string,
): Promise<{ id: string } | null> {
  const rows = await tx.select().from(workflowResumeRequests)
    .where(and(
      eq(workflowResumeRequests.companyId, body.companyId),
      eq(workflowResumeRequests.workflowRunId, body.workflowRunId),
      eq(workflowResumeRequests.idempotencyKey, body.idempotencyKey),
    ))
    .limit(2);
  const row = rows[0];
  if (!row) return null;
  const canonicalMatch = row.requestHash === requestHash
    && hashStructuredValue(row.requestBody) === requestHash;
  if (row.missionId !== body.missionId || !canonicalMatch) {
    throw conflict("idempotency_conflict", { requestId: row.id });
  }
  return row;
}

async function applyInsideLock(
  context: Awaited<Parameters<Parameters<typeof withResumeSerialization>[2]>[0]>,
  body: ResumeRequestBody,
  requestHash: string,
  audit: ResumeAuditActor,
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  const { tx, mission, run, steps } = context;
  await assertRunNotReplaced(tx, run.id, body.companyId);
  const replay = await findReplayableRequest(tx, body, requestHash);
  if (replay) {
    return readResumeRequest(tx, { companyId: body.companyId, missionId: body.missionId, requestId: replay.id });
  }

  const now = signer.now();
  const verified = verifySnapshot(body.snapshotToken, signer.key, signer.now());
  assertSnapshotScopeMatches(verified.scope, body);
  const fresh: ResumePreviewResult = await assembleResumePreview(tx, {
    companyId: body.companyId,
    missionId: body.missionId,
    workflowRunId: body.workflowRunId,
    startStepId: body.startStepId,
  }, signer);
  if (!fresh.preview.eligible || fresh.state === null) {
    throw conflict("resume_blocked", { blockers: fresh.preview.blockers });
  }
  if (hashSnapshotState(verified) !== hashSnapshotState(fresh.state)) {
    throw conflict("stale_snapshot");
  }
  const counters = assertResumeCountersSafe(run, fresh.state);
  const affectedRows = resolveAffectedRows(steps, fresh.preview.affectedStepIds);
  const requestId = randomUUID();

  await tx.insert(workflowResumeRequests).values({
    id: requestId,
    companyId: body.companyId,
    missionId: body.missionId,
    workflowRunId: body.workflowRunId,
    idempotencyKey: body.idempotencyKey,
    requestHash,
    snapshotHash: hashSnapshotState(verified),
    definitionHash: verified.definitionHash,
    requestBody: body,
    beforeState: buildResumeBeforeState({ mission, run, affectedRows }),
    appliedGenerations: {},
    state: "pending_delivery",
  });
  const appliedGenerations = await resetForResume(tx, {
    companyId: body.companyId,
    workflowRunId: body.workflowRunId,
    requestId,
    steps: affectedRows,
    now,
  });
  await tx.update(workflowResumeRequests)
    .set({ appliedGenerations })
    .where(eq(workflowResumeRequests.id, requestId));
  await transitionRunForResume(tx, {
    run,
    companyId: body.companyId,
    missionId: body.missionId,
    requestId,
    authorityVersion: counters.authorityVersion,
    resumeEpoch: counters.resumeEpoch,
  });
  await reactivateMissionIfCompleted(tx, { mission, companyId: body.companyId, now });
  await insertResumeAuditRow(tx, {
    companyId: body.companyId,
    audit,
    runId: run.id,
    requestId,
    startStepId: body.startStepId,
    affectedStepIds: fresh.preview.affectedStepIds,
    reason: body.reason,
  });
  return readResumeRequest(tx, { companyId: body.companyId, missionId: body.missionId, requestId });
}

/** scoped run 을 running 으로 전이하고 resume 권위 메타데이터를 기록한다(CAS: old authority version). */
async function transitionRunForResume(
  tx: ResumeMutationTransaction,
  input: {
    run: ResumeRunRow;
    companyId: string;
    missionId: string;
    requestId: string;
    authorityVersion: number;
    resumeEpoch: number;
  },
): Promise<void> {
  const updated = await tx.update(workflowRuns).set({
    status: "running",
    completedAt: null,
    dispatchAuthorityVersion: input.authorityVersion,
    metadata: {
      ...input.run.metadata,
      resumeRequestId: input.requestId,
      resumeAuthorityVersion: input.authorityVersion,
      resumeEpoch: input.resumeEpoch,
    },
  }).where(and(
    eq(workflowRuns.id, input.run.id),
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    eq(workflowRuns.dispatchAuthorityVersion, input.run.dispatchAuthorityVersion),
  )).returning({ id: workflowRuns.id });
  if (updated.length !== 1) {
    throw conflict("resume_authority_conflict", { workflowRunId: input.run.id });
  }
}

/** 완료 mission 만 active 로 되돌린다(startedAt/미지정 필드 보존, missionService.update 부수효과 없음). */
async function reactivateMissionIfCompleted(
  tx: ResumeMutationTransaction,
  input: { mission: { id: string; status: string }; companyId: string; now: Date },
): Promise<void> {
  if (input.mission.status !== "completed") return;
  await tx.update(missions).set({
    status: "active",
    completedAt: null,
    updatedAt: input.now,
  }).where(and(
    eq(missions.id, input.mission.id),
    eq(missions.companyId, input.companyId),
  ));
}

/** 감사는 같은 트랜잭션에서 직접 INSERT — 토큰/사유 원문/메타데이터 제외, 해시와 구조적 참조만. */
async function insertResumeAuditRow(
  tx: ResumeMutationTransaction,
  input: {
    companyId: string;
    audit: ResumeAuditActor;
    runId: string;
    requestId: string;
    startStepId: string;
    affectedStepIds: string[];
    reason: string;
  },
): Promise<void> {
  await tx.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.audit.actorType,
    actorId: input.audit.actorId,
    action: "workflow.resume_requested",
    entityType: "workflow_run",
    entityId: input.runId,
    details: {
      requestId: input.requestId,
      startStepId: input.startStepId,
      affectedStepIds: input.affectedStepIds,
      reasonHash: hashStructuredValue(input.reason),
      ...(input.audit.details ?? {}),
    },
  });
}
