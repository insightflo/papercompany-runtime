import { inArray, or, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";
import type { ResumeScopedHistory } from "./read-model-history.js";
import {
  readResumeMissionHistory,
  type ResumeMissionHistory,
} from "./read-model-mission.js";
import type { ResumeExecutionHistoryScope } from "./read-model.js";
import { readResumeScopedResources } from "./read-model-resources.js";

/**
 * [파일 목적] Task5c3d typed heartbeat/wakeup link closure — accepted whole-mission collector
 *   readResumeMissionHistory 를 항상 먼저 호출한 뒤, typed 링크(wake.runId, heartbeat
 *   wakeupRequestId 역참조, heartbeat retryOfRunId 부모/자식)를 fixed point 까지 닫고, 확장된
 *   이력으로 accepted resource 수집기(readResumeScopedResources)를 다시 실행하는 SELECT 전용
 *   공개 wrapper 다. 승인된 reader 들을 그대로 재사용하는 합성(additive)이며 이 slice 에는
 *   runtime caller 가 없다(이후 preview 통합 소관).
 * [명시적 한계 — discovery 전용, 아래를 전혀 구현하지 않는다]
 *   - workflow parentIssueId 연관 closure, missionAgentRuntimes lastRunId/currentIssueId
 *     역방향 closure, null-heartbeat workspace operation 정리, agent 신원/소유권/generation
 *     모순 판정, positive quiescence 증명, artifact/approval/budget 결손 검사,
 *     preview/API/token 통합.
 *   - 결과가 비어 있어도 eligible 뜻이 아니다. 순환(self-retry, retry cycle, wake cycle)은
 *     raw 로 보존되며 그래프 타당성이나 성공을 주장하지 않는다. 여러 wakeup 이 하나의
 *     heartbeat 를 가리키는 coalescing 은 정상 이력이므로 상호 일대일 대응을 요구하지 않는다.
 *   - 발견된 heartbeat 의 issueId/workflowStepRunId/contextSnapshot 으로 더 탐색하지 않는다.
 *     같은 회사 안의 모순된 mission/run/step 필드는 이후 소유권 정책을 위해 raw 보존된다.
 * [불변식]
 *   - select 표면(Pick<Db,"select">)만 사용한다. 상태 변경·잠금·세션 변경·DB 이외 접근이
 *     없으며 일관성은 호출자의 REPEATABLE READ 트랜잭션 소관이다.
 *   - base(base.selected/missionRuns/missionSteps 와 history 배열·행)는 절대 변형하지 않고
 *     새 객체로 합성한다. 병합은 DB primary key 접합이고 정렬은 id lexical 오름차순이다.
 *   - 어떤 질의도 company/status/generation/date 로 좁히지 않는다(타회사 오염 참조 은닉 금지).
 *     대신 반환된 모든 행의 companyId 를 검증해 scope_mismatch 로 거부한다. 빈 술어 집합에는
 *     질의하지 않는다(invalid SQL·전체 스캔 동시 회피). 임의 row-cap/깊이 제한/절단이 없다.
 *   - 회사 오염은 closure 중에(누락 검사보다 먼저) 거부된다.
 * [수정시 주의]
 *   - resource 수집은 closure 로 이력이 변하지 않았어도 항상 다시 실행한다(accepted wrapper
 *     대비 읽기 1회 추가 비용을 의도적으로 수용 — accepted reader 를 고쳐 중복을 제거하지 않는다).
 */

type HeartbeatRow = typeof heartbeatRuns.$inferSelect;
type WakeupRow = typeof agentWakeupRequests.$inferSelect;

function scopeMismatch(reason: string) {
  return unprocessable("scope_mismatch", { reason });
}

function historyUnproven(reason: string) {
  return unprocessable("resume_history_unproven", { reason });
}

function nonNull(values: (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => value !== null && value !== undefined);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** id lexical 오름차순 — 결정적 반환 순서와 결정적 오류 대상 선택을 함께 보장한다. */
function lexicalValues<T extends { id: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * whole-mission raw 발견 + typed link closure. 어떤 DB 상태도 변경하지 않고 plain object 만
 * 반환한다. caller 가 일관된 REPEATABLE READ READ ONLY 트랜잭션 안에서 호출해야 한다.
 */
export async function readResumeMissionLinkedHistory(
  db: Pick<Db, "select">,
  scope: ResumeExecutionHistoryScope,
): Promise<ResumeMissionHistory> {
  // [계약 1] accepted collector 를 먼저 — scope/frozen 정의/step set/whole-mission/resource
  //   오류를 전부 그대로 전파한다. 이 호출 전에 어떤 질의도 하지 않는다.
  const base = await readResumeMissionHistory(db, scope);
  const companyId = base.selected.scope.companyId;

  // [계약 2] DB primary key 기준 seed — caller 의 일관된 읽기 뷰가 돌려준 행들이다.
  const heartbeatsById = new Map<string, HeartbeatRow>();
  const wakeupsById = new Map<string, WakeupRow>();
  for (const row of base.history.heartbeats) heartbeatsById.set(row.id, row);
  for (const row of base.history.wakeups) wakeupsById.set(row.id, row);

  // [계약 3-6] fixed point — 두 map 이 모두 자라지 않으면 종료. 방문 map 이 self-retry/retry
  //   cycle/wake cycle 을 종결한다. 비순환 체인도 라운드마다 한 hop 씩 닫힌다.
  for (;;) {
    const heartbeatCountBefore = heartbeatsById.size;
    const wakeupCountBefore = wakeupsById.size;

    // heartbeat 라운드: id IN(known ∪ wake.runId ∪ retryOf 부모) OR wakeupRequestId IN(known
    // wakeup) OR retryOfRunId IN(known heartbeat 자식) — 비어있지 않은 술어만 OR 로 조립.
    const knownHeartbeatIds = [...heartbeatsById.keys()];
    const knownWakeupIds = [...wakeupsById.keys()];
    const heartbeatIdSeeds = unique([
      ...knownHeartbeatIds,
      ...nonNull([...wakeupsById.values()].map((row) => row.runId)),
      ...nonNull([...heartbeatsById.values()].map((row) => row.retryOfRunId)),
    ]);
    const heartbeatPredicates: SQL<unknown>[] = [];
    if (heartbeatIdSeeds.length > 0) heartbeatPredicates.push(inArray(heartbeatRuns.id, heartbeatIdSeeds));
    if (knownWakeupIds.length > 0) {
      heartbeatPredicates.push(inArray(heartbeatRuns.wakeupRequestId, knownWakeupIds));
    }
    if (knownHeartbeatIds.length > 0) {
      heartbeatPredicates.push(inArray(heartbeatRuns.retryOfRunId, knownHeartbeatIds));
    }
    if (heartbeatPredicates.length > 0) {
      const rows = await db.select().from(heartbeatRuns)
        .where(or(...heartbeatPredicates)).orderBy(heartbeatRuns.id);
      for (const row of rows) {
        if (row.companyId !== companyId) throw scopeMismatch("heartbeat_company_mismatch");
        heartbeatsById.set(row.id, row); // 같은 PK 재접합만 dedupe — 다른 id 는 버리지 않는다.
      }
    }

    // wakeup 라운드: id IN(known ∪ NOW-known heartbeat.wakeupRequestId) OR runId IN(NOW-known
    // heartbeat) — NOW-known 은 이번 라운드 heartbeat 병합 뒤 기준이다.
    const nowHeartbeatIds = [...heartbeatsById.keys()];
    const wakeupIdSeeds = unique([
      ...wakeupsById.keys(),
      ...nonNull([...heartbeatsById.values()].map((row) => row.wakeupRequestId)),
    ]);
    const wakeupPredicates: SQL<unknown>[] = [];
    if (wakeupIdSeeds.length > 0) wakeupPredicates.push(inArray(agentWakeupRequests.id, wakeupIdSeeds));
    if (nowHeartbeatIds.length > 0) wakeupPredicates.push(inArray(agentWakeupRequests.runId, nowHeartbeatIds));
    if (wakeupPredicates.length > 0) {
      const rows = await db.select().from(agentWakeupRequests)
        .where(or(...wakeupPredicates)).orderBy(agentWakeupRequests.id);
      for (const row of rows) {
        if (row.companyId !== companyId) throw scopeMismatch("wakeup_company_mismatch");
        wakeupsById.set(row.id, row);
      }
    }

    if (heartbeatsById.size === heartbeatCountBefore && wakeupsById.size === wakeupCountBefore) break;
  }

  // [계약 7] fixed point 이후 결정적 missing-reference 검사 — lexical id 순서, null 포인터 허용,
  //   삭제된 ancestry 추측 금지, 상호 일치 요구 없음. 회사 오염은 이미 위에서 거부되었다.
  const heartbeats = lexicalValues(heartbeatsById);
  const wakeups = lexicalValues(wakeupsById);
  for (const row of wakeups) {
    if (row.runId !== null && !heartbeatsById.has(row.runId)) throw historyUnproven("missing_wakeup_run");
  }
  for (const row of heartbeats) {
    if (row.wakeupRequestId !== null && !wakeupsById.has(row.wakeupRequestId)) {
      throw historyUnproven("missing_heartbeat_wakeup");
    }
  }
  for (const row of heartbeats) {
    if (row.retryOfRunId !== null && !heartbeatsById.has(row.retryOfRunId)) {
      throw historyUnproven("missing_retry_parent");
    }
  }

  // [계약 8] 새 history — issues/delegations 는 base 그대로 보존한다. base 객체/배열은 무변형.
  const history: ResumeScopedHistory = { ...base.history, heartbeats, wakeups };

  // [계약 9] closure 뒤 resource 수집 — 이력이 불변이어도 항상 실행(의도된 읽기 1회 추가).
  const resources = await readResumeScopedResources(db, base.selected.scope, history);
  return { ...base, history, resources };
}
