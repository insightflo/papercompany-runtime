import { and, eq } from "drizzle-orm";
import { workflowResumeExecutions, workflowResumeRequests, type Db } from "@paperclipai/db";
import { notFound } from "../../../errors.js";

/**
 * [파일 목적] Task6a resume 요청 readback — SELECT 전용 스코프 조회기. 요청 row 를
 *   (companyId, missionId, requestId) 정확 스코프로 읽고, 같은 스코프의 실행 row(requestId)를
 *   함께 돌려준다. 어떤 상태 변경도 하지 않는다.
 * [불변식]
 *   - 타회사/타미션 요청은 존재해도 404 로 균일화한다(스코프 밖 존재 유출 금지).
 *   - 실행 row 는 요청과 같은 (company, mission) 스코프로만 조회한다. 요청에 아직 실행이
 *     없으면 execution 은 null 이다(요청 1건당 실행 1건 — acceptance 후속 소관).
 *   - 모든 Date 는 UTC ISO 문자열로 변환한다. 내부 사유/행 데이터 외 노출 없음.
 */

export interface ResumeRequestView {
  schemaVersion: 1;
  id: string;
  companyId: string;
  missionId: string;
  workflowRunId: string;
  idempotencyKey: string;
  requestHash: string;
  snapshotHash: string;
  definitionHash: string;
  requestBody: Record<string, unknown>;
  beforeState: Record<string, unknown>;
  appliedGenerations: Record<string, number>;
  state: string;
  code: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  deliveryAttempts: number;
  acceptedAt: string | null;
  createdAt: string;
  execution: {
    id: string;
    state: string;
    authorityVersion: number;
    generations: Record<string, number>;
    attempts: number;
    createdAt: string;
    completedAt: string | null;
    code: string | null;
  } | null;
}

/** 정확 스코프 요청 readback. 요청 부재(스코프 불일치 포함)는 not found 다. */
export async function readResumeRequest(
  db: Pick<Db, "select">,
  ids: { companyId: string; missionId: string; requestId: string },
): Promise<ResumeRequestView> {
  const [row] = await db.select().from(workflowResumeRequests)
    .where(and(
      eq(workflowResumeRequests.id, ids.requestId),
      eq(workflowResumeRequests.companyId, ids.companyId),
      eq(workflowResumeRequests.missionId, ids.missionId),
    ))
    .limit(1);
  if (!row) throw notFound("Resume request not found");

  const [execution] = await db.select().from(workflowResumeExecutions)
    .where(and(
      eq(workflowResumeExecutions.requestId, row.id),
      eq(workflowResumeExecutions.companyId, ids.companyId),
      eq(workflowResumeExecutions.missionId, ids.missionId),
    ))
    .limit(1);

  return {
    schemaVersion: 1,
    id: row.id,
    companyId: row.companyId,
    missionId: row.missionId,
    workflowRunId: row.workflowRunId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    snapshotHash: row.snapshotHash,
    definitionHash: row.definitionHash,
    requestBody: row.requestBody,
    beforeState: row.beforeState,
    appliedGenerations: row.appliedGenerations,
    state: row.state,
    code: row.code,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil === null ? null : row.leaseUntil.toISOString(),
    deliveryAttempts: row.deliveryAttempts,
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    execution: execution ? {
      id: execution.id,
      state: execution.state,
      authorityVersion: execution.authorityVersion,
      generations: execution.generations,
      attempts: execution.attempts,
      createdAt: execution.createdAt.toISOString(),
      completedAt: execution.completedAt === null ? null : execution.completedAt.toISOString(),
      code: execution.code,
    } : null,
  };
}
