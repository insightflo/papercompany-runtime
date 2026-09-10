import { and, eq, inArray, or } from "drizzle-orm";
import { executionWorkspaces, workspaceOperations, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";
import { readResumeMissionLinkedHistory } from "./read-model-links.js";
import type { ResumeMissionHistory } from "./read-model-mission.js";
import type { ResumeExecutionHistoryScope } from "./read-model.js";

/**
 * [파일 목적] Task5c3f workspace-linked discovery — accepted linked mission reader
 *   (readResumeMissionLinkedHistory) 를 항상 먼저 호출하는 SELECT 전용 공개 wrapper 다.
 *   heartbeat-only 이력이 놓치는 workspace 연산(정리 연산 포함)과 그 workspace 들 위의 runtime
 *   service 전체 행을 발견한다: base 이력에서 명시적 executionWorkspaceId 필드만으로 유한한
 *   workspace seed 집합을 유도하고, 그 workspace 행들을 검증한 뒤 그 위의 모든 연산과
 *   executionWorkspaceId 또는 scopeType='execution_workspace'+scopeId 정확 일치로 묶인 service 를
 *   resources 에 병합한다. 이는 discovery 일 뿐이며 재개 허가가 아니다 — accepted reader 들과
 *   conflict 정책은 전부 변경되지 않는다.
 * [명시적 한계 — 이 파일이 그 이상을 주장하지 않도록 유지할 것]
 *   - shared workspace 위의 타-heartbeat 연산과 타-heartbeat 가 시작한 service 는 conflict
 *     evidence 로 raw 보존일 뿐이며, accepted ownership / 정상 종료 / quiescence 의 증거가 아니다.
 *   - missionAgentRuntimes.workspaceId(FK 아님), executionWorkspaces.sourceIssueId 와
 *     derivedFromExecutionWorkspaceId 역방향, parent-issue/runtime closure, shared-service
 *     widening, project/agent 전역 scope 의 service 발견, runtime pointer, OS 경로/프로세스 상태,
 *     양성 quiescence 증명, eligibility/API/token/artifact/budget/approval 정책, preview/API,
 *     실행 동작은 전혀 구현하지 않는다 — 남은 별도 gap 이다. 같은 회사 안에서 service 의 scopeId 와
 *     executionWorkspaceId 가 서로 다른 workspace 를 가리키는 모순은 raw evidence 로 보존할 뿐
 *     고치지 않고 그 포인터를 따라가지도 않는다.
 *   - 발견된 연산의 heartbeatRunId 나 service 의 startedByRunId 는 이력이나 추가 workspace 로
 *     역방향 추적하지 않는다.
 * [불변식]
 *   - 첫 동작은 accepted linked reader 호출이며 그 오류를 전부 그대로 전파한다. 이 호출 전에
 *     어떤 사전 질의/검증/대체 검증도 하지 않는다.
 *   - seed 는 base.history.issues / base.resources.workspaceRuntimeServices /
 *     base.resources.workspaceOperations 의 non-null executionWorkspaceId 뿐이다. selected-only
 *     자원, runtime.workspaceId, cwd, metadata/prose, projectId, sourceIssueId 는 쓰지 않는다.
 *   - 질의를 company/status/heartbeat/generation/date 로 좁히지 않는다 — 타회사 행을 WHERE 로
 *     숨기지 않고 대신 반환된 모든 행의 companyId 를 검증해 scope_mismatch 로 거부한다. 회사
 *     검증이 missing 검사보다 먼저다(fetch 된 workspace 전부 → operation 전부 → service 전부 → missing).
 *   - seed 가 없으면 workspace 질의·전체 스캔 없이 [] 로 종료한다. 병합은 DB primary key 접합 +
 *     id lexical 오름차순이고, base 객체/배열은 절대 변형하지 않고 새 객체로 합성한다.
 *   - select 표면(Pick<Db,"select">)만 사용한다. lock/transaction/SET 을 시작하지 않으며 일관된
 *     읽기 뷰는 caller 의 REPEATABLE READ READ ONLY 트랜잭션 소관이다.
 */

export interface ResumeWorkspaceMissionHistory extends ResumeMissionHistory {
  executionWorkspaces: (typeof executionWorkspaces.$inferSelect)[];
}

/**
 * workspace-linked raw 발견. 어떤 DB 상태도 변경하지 않고 plain object 만 반환한다.
 * caller 가 일관된 REPEATABLE READ READ ONLY 트랜잭션 안에서 호출해야 한다.
 */
export async function readResumeMissionWorkspaceHistory(
  db: Pick<Db, "select">,
  scope: ResumeExecutionHistoryScope,
): Promise<ResumeWorkspaceMissionHistory> {
  // [계약 1] accepted linked reader 를 먼저 — scope 파싱/frozen 정의/step set/closure/resource
  //   오류를 전부 그대로 전파한다. 이 호출 전에 어떤 질의도 하지 않는다.
  const base = await readResumeMissionLinkedHistory(db, scope);

  // [계약 2] 명시적 executionWorkspaceId 필드만으로 유한 seed 집합 유도 — dedupe + lexical 정렬.
  const ids = [...new Set([
    ...base.history.issues.map((row) => row.executionWorkspaceId),
    ...base.resources.workspaceRuntimeServices.map((row) => row.executionWorkspaceId),
    ...base.resources.workspaceOperations.map((row) => row.executionWorkspaceId),
  ].filter((id): id is string => id !== null))].sort();

  // [계약 3] seed 가 없으면 질의 없이 종료 — 전체 스캔 없이 base 를 그대로 확장한다.
  if (ids.length === 0) return { ...base, executionWorkspaces: [] };

  // [계약 4] seed workspace 행들 + 그 위의 모든 연산과 service — company/status/heartbeat/
  //   generation/date 필터 없음. shared workspace 의 타-heartbeat 연산/서비스도 conflict evidence
  //   로 전체 행 수집한다. service 매치는 executionWorkspaceId 정확 일치 또는
  //   scopeType='execution_workspace' + scopeId 정확 일치 뿐이다(문자열 유사 판정 없음).
  const workspaces = await db.select().from(executionWorkspaces)
    .where(inArray(executionWorkspaces.id, ids))
    .orderBy(executionWorkspaces.id);
  const operations = await db.select().from(workspaceOperations)
    .where(inArray(workspaceOperations.executionWorkspaceId, ids))
    .orderBy(workspaceOperations.id);
  const services = await db.select().from(workspaceRuntimeServices)
    .where(or(
      inArray(workspaceRuntimeServices.executionWorkspaceId, ids),
      and(
        eq(workspaceRuntimeServices.scopeType, "execution_workspace"),
        inArray(workspaceRuntimeServices.scopeId, ids),
      ),
    ))
    .orderBy(workspaceRuntimeServices.id);

  // [계약 5] 회사 검증이 missing 검사보다 먼저 — fetch 된 workspace 전부 → operation 전부 →
  //   service 전부 순서로 검증한다.
  const companyId = base.selected.scope.companyId;
  for (const row of workspaces) {
    if (row.companyId !== companyId) {
      throw unprocessable("scope_mismatch", { reason: "execution_workspace_company_mismatch" });
    }
  }
  for (const row of operations) {
    if (row.companyId !== companyId) {
      throw unprocessable("scope_mismatch", { reason: "workspace_operation_company_mismatch" });
    }
  }
  for (const row of services) {
    if (row.companyId !== companyId) {
      throw unprocessable("scope_mismatch", { reason: "workspace_service_company_mismatch" });
    }
  }
  for (const id of ids) {
    if (!workspaces.some((row) => row.id === id)) {
      // 고정 reason 하나 — 경로/ID 노출 없이 참조가 증명되지 않았음을 fail-closed 로 거부한다.
      throw unprocessable("resume_history_unproven", { reason: "missing_execution_workspace" });
    }
  }

  // [계약 6] DB primary key 기준 병합(base heartbeat 유도 연산/서비스 + workspace 유도) + 정렬.
  const mergedOperations = [...new Map([...base.resources.workspaceOperations, ...operations]
    .map((row) => [row.id, row])).values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const mergedServices = [...new Map([...base.resources.workspaceRuntimeServices, ...services]
    .map((row) => [row.id, row])).values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // [계약 7] base 무변형 — 새 객체로 합성한다. 나머지 필드/배열과 raw 행 필드는 base 그대로.
  return {
    ...base,
    executionWorkspaces: workspaces,
    resources: {
      ...base.resources,
      workspaceOperations: mergedOperations,
      workspaceRuntimeServices: mergedServices,
    },
  };
}
