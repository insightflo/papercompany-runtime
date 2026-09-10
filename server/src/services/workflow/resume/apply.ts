import { randomUUID } from "node:crypto";
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
import type { ResumeMutationTransaction, ResumeRunRow } from "./serialization.js";
import { withResumeSerialization } from "./serialization.js";
import { hashSnapshotState, verifySnapshot } from "./snapshot.js";

/**
 * [파일 목적] Task6a real atomic apply — preview(검증·적격성) + mutation core(잠금·reset) +
 *   durable 요청 row 를 하나의 트랜잭션으로 묶는 프로덕션 서비스.
 * [불변식]
 *   - auth 는 lookup/replay 보다 먼저다(none→401, non-board→403, board 회사 접근은 routes/authz.ts
 *     assertCompanyAccess 와 동일 조건). actor 는 반드시 실제 인증된 Request 에서 온다 — client body
 *     에서 오지 않는다. raw body 는 strict resumeRequestSchema 로만 검증·해시한다(토큰/사유 포함).
 *   - replay 는 잠금 하에서 company+run+idempotencyKey 로만 판정하고, 토큰 만료/미션 종료 이전에
 *     그리고 이후에도 동작한다. 본문 불일치는 idempotency_conflict.
 *   - reset/권한 전이는 공식 resetForResume 만 사용한다. 이 서비스는 실행 레코드/큐/이슈를 만들지
 *     않고, 요청은 pending_delivery 로 남는다(dispatcher 마운트는 이후 슬라이스다 — 이 서비스는
 *     아직 POST 로 노출되면 안 된다: 공용 dispatcher lock/result fence 가 상위에서 완성되기 전까지).
 *   - 감사는 logActivity(커밋 전 이벤트 발행)가 아니라 같은 트랜잭션의 직접 activityLog INSERT 다.
 *     토큰/사유 원문/메타데이터는 감사에 절대 넣지 않는다(사유는 해시만, 원문은 승인된 requestBody 에).
 */

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
  return withResumeSerialization(
    db,
    { companyId: body.companyId, missionId: body.missionId, runId: body.workflowRunId },
    (context) => applyInsideLock(context, body, requestHash, actor, signer),
  );
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
  actor: Express.Request["actor"],
  signer: ResumeApplySigner,
): Promise<ResumeRequestView> {
  const { tx, mission, run, steps } = context;
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
    actor,
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
    actor: Express.Request["actor"];
    runId: string;
    requestId: string;
    startStepId: string;
    affectedStepIds: string[];
    reason: string;
  },
): Promise<void> {
  await tx.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "user",
    actorId: input.actor.userId ?? "board",
    action: "workflow.resume_requested",
    entityType: "workflow_run",
    entityId: input.runId,
    details: {
      requestId: input.requestId,
      startStepId: input.startStepId,
      affectedStepIds: input.affectedStepIds,
      reasonHash: hashStructuredValue(input.reason),
    },
  });
}
