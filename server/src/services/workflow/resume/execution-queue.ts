import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowResumeExecutions, workflowResumeRequests } from "@paperclipai/db";

/**
 * [파일 목적] Task6b-2 durable resume delivery 의 bounded claim 계층. pending_delivery 요청과
 *   재진입 대상(lease 만료) 실행을 SKIP LOCKED 로 임대한다. 어떤 dispatch/readiness/sync 도
 *   여기서 하지 않는다 — claim 은 임대 소유권만 확정한다.
 * [수정시 주의]
 *   - claim 은 단일 트랜잭션: SELECT ... FOR UPDATE SKIP LOCKED → 행마다 동일 술어의
 *     conditional UPDATE(state/lease 재검사)로 임대 확정. UPDATE returning 이 없으면 스킵.
 *     SELECT 로 본 행이라도 UPDATE 술어가 실패하면 임대 아님(EvalPlanQual 재검사 방어).
 *   - 살아있는 lease(lease_until >= now) 행은 절대 뺏지 않는다. 만료된 임대만 인계한다.
 *   - limit/leaseMs 기본값은 계약 고정(limit=10, leaseMs=30_000). owner 옵션은 dispatcher 가
 *     한 번의 패스에서 claim/markRunning/completed 간 같은 토큰을 쓰기 위한 것이고, 기본은
 *     호출마다 resume-dispatcher:<random> 다.
 */

export type ClaimedResumeRequestRow = typeof workflowResumeRequests.$inferSelect;
export type ClaimedResumeExecutionRow = typeof workflowResumeExecutions.$inferSelect;

export const RESUME_DELIVERY_LEASE_MS = 30_000;
const MAX_CLAIM_LIMIT = 100;
// Bound abandoned work recovery to at most five minutes; default remains 30 seconds.
export const MAX_RESUME_DELIVERY_LEASE_MS = 300_000;

export function validateResumeClaimOptions(options: ClaimPendingResumeRequestsOptions) {
  const limit = options.limit === undefined ? 10 : options.limit;
  const leaseMs = options.leaseMs === undefined ? RESUME_DELIVERY_LEASE_MS : options.leaseMs;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CLAIM_LIMIT) {
    throw new RangeError("Resume claim limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_RESUME_DELIVERY_LEASE_MS) {
    throw new RangeError("Resume leaseMs must be an integer from 1 to 300000");
  }
  return { limit, leaseMs };
}

export function resumeLeaseUntil(leaseMs = RESUME_DELIVERY_LEASE_MS) {
  validateResumeClaimOptions({ leaseMs });
  return sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`;
}

export interface ClaimPendingResumeRequestsOptions {
  /** @deprecated Compatibility only. PostgreSQL clock_timestamp() is the lease authority. */
  now?: Date;
  limit?: number;
  leaseMs?: number;
  owner?: string;
}

function leaseOwnerToken(options: ClaimPendingResumeRequestsOptions): string {
  return options.owner ?? `resume-dispatcher:${randomUUID()}`;
}

/**
 * [목적] state='pending_delivery' 그리고 (lease 없음 또는 만료) 요청을 임대해 돌려준다.
 * [주의] 임대된 행은 leaseOwner/leaseUntil/deliveryAttempts+1 이 설정된 returning row 다.
 *   다른 dispatcher 의 살아있는 임대 행은 잠금 갈등 시 스킵된다(대기 아님, 절취 아님).
 */
export async function claimPendingResumeRequests(
  db: Db,
  options: ClaimPendingResumeRequestsOptions = {},
): Promise<ClaimedResumeRequestRow[]> {
  const { limit, leaseMs } = validateResumeClaimOptions(options);
  const owner = leaseOwnerToken(options);
  const leaseFree = or(
    isNull(workflowResumeRequests.leaseUntil),
    lt(workflowResumeRequests.leaseUntil, sql`clock_timestamp()`),
  );
  return db.transaction(async (tx) => {
    const candidates = await tx.select().from(workflowResumeRequests)
      .where(and(
        eq(workflowResumeRequests.state, "pending_delivery"),
        leaseFree,
      ))
      .orderBy(asc(workflowResumeRequests.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: ClaimedResumeRequestRow[] = [];
    for (const candidate of candidates) {
      const [updated] = await tx.update(workflowResumeRequests)
        .set({
          leaseOwner: owner,
          leaseUntil: resumeLeaseUntil(leaseMs),
          deliveryAttempts: sql`${workflowResumeRequests.deliveryAttempts} + 1`,
        })
        .where(and(
          eq(workflowResumeRequests.id, candidate.id),
          eq(workflowResumeRequests.state, "pending_delivery"),
          or(
            isNull(workflowResumeRequests.leaseUntil),
            lt(workflowResumeRequests.leaseUntil, sql`clock_timestamp()`),
          ),
        ))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

/**
 * [목적] 크래시 후 재진입 — state queued/running 인 실행 중 lease 없거나 만료된 행을 임대한다.
 * [주의] completed 는 대상 아니다(전달 종료). accepted 요청의 실행만 존재하므로 재진입 경로는
 *   dispatcher 의 멱덴 accept 트랜잭션으로 귀결된다. 임대 조건/토큰 규칙은 claimPendingResumeRequests 와 동일.
 */
export async function claimStaleResumeExecutions(
  db: Db,
  options: ClaimPendingResumeRequestsOptions = {},
): Promise<ClaimedResumeExecutionRow[]> {
  const { limit, leaseMs } = validateResumeClaimOptions(options);
  const owner = leaseOwnerToken(options);
  const leaseFree = or(
    isNull(workflowResumeExecutions.leaseUntil),
    lt(workflowResumeExecutions.leaseUntil, sql`clock_timestamp()`),
  );
  return db.transaction(async (tx) => {
    const candidates = await tx.select().from(workflowResumeExecutions)
      .where(and(
        inArray(workflowResumeExecutions.state, ["queued", "running"]),
        leaseFree,
      ))
      .orderBy(asc(workflowResumeExecutions.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: ClaimedResumeExecutionRow[] = [];
    for (const candidate of candidates) {
      const [updated] = await tx.update(workflowResumeExecutions)
        .set({
          leaseOwner: owner,
          leaseUntil: resumeLeaseUntil(leaseMs),
          attempts: sql`${workflowResumeExecutions.attempts} + 1`,
        })
        .where(and(
          eq(workflowResumeExecutions.id, candidate.id),
          inArray(workflowResumeExecutions.state, ["queued", "running"]),
          or(
            isNull(workflowResumeExecutions.leaseUntil),
            lt(workflowResumeExecutions.leaseUntil, sql`clock_timestamp()`),
          ),
        ))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}
