import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { expect } from "vitest";
import { readResumeMissionLinkedHistory } from "../../services/workflow/resume/read-model-links.js";
import type { HttpError } from "../../errors.js";
import type { ResumeExecutionHistoryScope } from "../../services/workflow/resume/read-model.js";
import {
  canonicalMissionDomain,
  seedCompleteStepRuns,
  seedReadModelGraph,
  type RawSql,
} from "./workflow-resume-mission-fixture.js";

/**
 * [목적] Task5c3d typed heartbeat/wakeup link closure 테스트 픽스처. 승인된 mission fixture 를
 *   import 로만 재사용(기존 fixture 수정 금지)하고, 이 슬라이스 전용 조립만 추가한다:
 *   공개 wrapper 의 실제 repeatable-read read-only 호출, wake.runId /
 *   heartbeat.retryOfRunId(+executor lease) 전용 raw 시더, certified 공개 호출 전후 전체 도메인
 *   canonical 무변화 단언(try/finally). 실제 임베디드 PostgreSQL — mock DB/loader/해시 없음.
 */

/** [reader 전후 전체 도메인 증거] mission fixture canonical 스냅샷 타입 재사용. */
export type MissionDomainSnapshot = Awaited<ReturnType<typeof canonicalMissionDomain>>;

export { canonicalMissionDomain };

/** [계약] 공개 wrapper 호출은 전부 실제 repeatable-read read-only 트랜잭션 안에서 실행된다. */
export function readMissionLinksReadonly(db: Db, scope: ResumeExecutionHistoryScope) {
  return db.transaction((tx) => readResumeMissionLinkedHistory(tx, scope), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** certified 공개 호출(성공/거부 모두) 전후 canonical 무변화 — finally 로 단언 누락을 막는다. */
export async function expectDomainUnchanged<T>(
  db: Db,
  before: MissionDomainSnapshot,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    expect(await canonicalMissionDomain(db)).toEqual(before);
  }
}

/** accepted 오류 단언 — status 422 + message + details.reason 정확 대조. */
export function expectReason(error: HttpError, message: string, reason: string): void {
  expect(error.status).toBe(422);
  expect(error.message).toBe(message);
  expect((error.details as { reason: string }).reason).toBe(reason);
}

/** frozen selected graph + 1:1 step rows — base whole-mission collector 통과 최소 selected 그래프. */
export async function seedSelectedGraph(sql: RawSql, db: Db) {
  const graph = await seedReadModelGraph(sql, db);
  const selectedStepRowIds = await seedCompleteStepRuns(db, graph);
  return { graph, selectedStepRowIds };
}

/**
 * wake.runId 전용 시더 — agent_wakeup_requests.run_id 는 FK-free uuid 컬럼이므로 대상 행 존재
 * 여부와 무관하게 insert 된다(heartbeat retry/coalescing producer 가 쓰는 필드). typed 연관
 * (missionId/workflowRunId)은 옵션일 뿐 기본 NULL 이고 legacy JSON payload 도 기본 없다.
 */
export async function seedLinkedWakeup(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    missionId?: string;
    workflowRunId?: string;
    status?: string;
  },
): Promise<string> {
  const [row] = await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "resume-links-test",
    reason: "resume-links-test",
    status: input.status ?? "queued",
    runId: input.runId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
  }).returning();
  return row!.id;
}

/**
 * heartbeat.retryOfRunId 전용 시더 — retry producer 필드(raw). parent 행은 호출 전에 존재해야
 * 한다(retry_of_run_id 는 heartbeat_runs.id FK; self 참조는 같은 insert 행으로 통과된다).
 * executor lease 계열 필드와 모순된 workflowStepRunId(raw uuid, FK 없음)도 그대로 쓸 수 있다.
 */
export async function seedRetryHeartbeat(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    retryOfRunId: string | null;
    id?: string;
    workflowStepRunId?: string;
    wakeupRequestId?: string;
    status?: string;
    workflowExecutionGeneration?: number;
    executionScopeKind?: string;
    executionEpoch?: number;
    executionToken?: string;
    executorOwnerId?: string;
    executorOwnerLeaseEpoch?: number;
    executorOwnerLeaseToken?: string;
    executorOwnerLeaseExpiresAt?: Date;
    executorOwnerAcknowledgedAt?: Date;
    executorOwnerReleasedAt?: Date;
  },
): Promise<string> {
  const [row] = await db.insert(heartbeatRuns).values({
    ...(input.id ? { id: input.id } : {}),
    companyId: input.companyId,
    agentId: input.agentId,
    status: input.status ?? "succeeded",
    retryOfRunId: input.retryOfRunId,
    ...(input.workflowStepRunId ? { workflowStepRunId: input.workflowStepRunId } : {}),
    ...(input.wakeupRequestId ? { wakeupRequestId: input.wakeupRequestId } : {}),
    ...(input.workflowExecutionGeneration !== undefined
      ? { workflowExecutionGeneration: input.workflowExecutionGeneration }
      : {}),
    ...(input.executionScopeKind ? { executionScopeKind: input.executionScopeKind } : {}),
    ...(input.executionEpoch !== undefined ? { executionEpoch: input.executionEpoch } : {}),
    ...(input.executionToken ? { executionToken: input.executionToken } : {}),
    ...(input.executorOwnerId ? { executorOwnerId: input.executorOwnerId } : {}),
    ...(input.executorOwnerLeaseEpoch !== undefined
      ? { executorOwnerLeaseEpoch: input.executorOwnerLeaseEpoch }
      : {}),
    ...(input.executorOwnerLeaseToken ? { executorOwnerLeaseToken: input.executorOwnerLeaseToken } : {}),
    ...(input.executorOwnerLeaseExpiresAt
      ? { executorOwnerLeaseExpiresAt: input.executorOwnerLeaseExpiresAt }
      : {}),
    ...(input.executorOwnerAcknowledgedAt
      ? { executorOwnerAcknowledgedAt: input.executorOwnerAcknowledgedAt }
      : {}),
    ...(input.executorOwnerReleasedAt
      ? { executorOwnerReleasedAt: input.executorOwnerReleasedAt }
      : {}),
  }).returning();
  return row!.id;
}
