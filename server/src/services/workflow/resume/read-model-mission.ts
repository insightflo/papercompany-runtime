import { eq, inArray } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";
import {
  readResumeExecutionHistory,
  type ResumeExecutionHistory,
  type ResumeExecutionHistoryScope,
} from "./read-model.js";
import { readResumeScopedHistory, type ResumeScopedHistory } from "./read-model-history.js";
import { readResumeScopedResources, type ResumeScopedResources } from "./read-model-resources.js";

/**
 * [파일 목적] Task5c3c whole-mission roots 수집기 — accepted selected-run reader 의
 *   SELECT-only wrapper. selected scope/frozen 정의를 먼저 검증한 뒤, 같은 missionId 를 갖는
 *   모든 workflow run root(다른 정의·terminal status·snapshot 없는 legacy run 포함)를
 *   열거하고, 각 root 의 raw step 행과 accepted 이력 수집기(readResumeScopedHistory)를
 *   재사용해 raw 후보 전체를 모은 뒤 union 위에서 resource 수집을 한 번 실행한다.
 * [명시적 한계 — discovery 이지 lineage/quiescence 증명이 아니다]
 *   - wakeup.runId 역방향 링크, heartbeat retry ancestry, workflow parentIssueId 연관,
 *     contradictory cross-root 링크, runtime lastRunId/currentIssueId closure, null-heartbeat
 *     workspace cleanup 등 남은 정책은 unresolved 별도 과제이며 이 helper 는 확장하지 않는다.
 *   - 형제 run 마다 이력 SELECT 를 반복하는 것은 명시적 성능 비용으로 수용한다(대안 2).
 * [불변식]
 *   - reader 는 select 표면(Pick<Db,"select">)만 사용한다. transaction/SET/lock/write/probe
 *     호출이 없으며 REPEATABLE READ 일관성은 caller 트랜잭션 소관이다(계약 8).
 *   - mission root 열거는 company 로 질의를 좁히지 않는다 — company 를 술어에 넣으면 모순된
 *     typed mission link 가 숨겨진다. 대신 반환된 모든 행의 companyId 를 검증해 오염을 거부한다.
 *   - 형제 run 에게 selected reader 나 loadExecutionDefinition 을 다시 부르지 않는다. 형제는
 *     snapshot 이 없어도 되며 semantic step id 집합이 selected 정의와 어긋나도 raw 수집 대상이다.
 *   - 병합 dedupe 는 caller 의 단일 repeatable-read 트랜잭션 안에서 같은 DB primary key 를
 *     다시 읽은 동일 행의 접합일 뿐이다. 임의 row-cap 으로 잘라내지 않고 raw 필드를 전부 보존하며,
 *     다른 id 를 버리지 않는다. 임의 시작 step 합성/합성 row 채우기도 없다.
 */

export interface ResumeMissionHistory {
  selected: ResumeExecutionHistory;
  missionRuns: (typeof workflowRuns.$inferSelect)[];
  missionSteps: (typeof workflowStepRuns.$inferSelect)[];
  history: ResumeScopedHistory;
  resources: ResumeScopedResources;
}

/** DB primary key 기준 병합 + id lexical 정렬(동일 row 재접합만 dedupe — 다른 id 는 절대 drop 금지). */
function mergeByIdLexical<T extends { id: string }>(rows: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const group of rows) {
    for (const row of group) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * whole-mission raw 후보 수집. 어떤 DB 상태도 변경하지 않고 plain object 만 반환한다.
 * caller 가 일관된 REPEATABLE READ READ ONLY 트랜잭션 안에서 호출해야 한다.
 */
export async function readResumeMissionHistory(
  db: Pick<Db, "select">,
  scope: ResumeExecutionHistoryScope,
): Promise<ResumeMissionHistory> {
  // [계약 1] selected reader 를 먼저 — 엄격한 입력 파싱과 기존 오류 전부 그대로 전파.
  //   다른-mission 열거는 이 검증 이전에 절대 일어나지 않는다.
  const selected = await readResumeExecutionHistory(db, scope);

  // [계약 2] typed mission root 전체 — company/status/definition/date 필터 없이 missionId 만.
  const missionRuns = await db.select().from(workflowRuns)
    .where(eq(workflowRuns.missionId, selected.scope.missionId))
    .orderBy(workflowRuns.id);
  for (const row of missionRuns) {
    if (row.companyId !== selected.scope.companyId) {
      // 같은 missionId 를 당하는 타회사 run 을 숨기지 않고 오염으로 거부한다.
      throw unprocessable("scope_mismatch", { reason: "mission_run_company_mismatch" });
    }
  }

  // [계약 3] selected run 은 root 결과 안에 반드시 있다(일관 스냅샷 전제). 방어적 재환이며
  //   비어 있는 inArray 회피도 겸한다.
  if (!missionRuns.some((row) => row.id === selected.run.id)) {
    throw unprocessable("resume_history_unproven", { reason: "mission_run_missing" });
  }

  // [계약 4] mission root 의 step 행 전체 — status/generation/step-definition 필터 없음.
  //   형제 legacy run 은 0/중복/초과 semantic step id 도 그대로 raw 수집한다(DB primary id 유일).
  const missionSteps = await db.select().from(workflowStepRuns)
    .where(inArray(workflowStepRuns.workflowRunId, missionRuns.map((row) => row.id)))
    .orderBy(workflowStepRuns.id);

  const stepsByRunId = new Map<string, (typeof workflowStepRuns.$inferSelect)[]>();
  for (const row of missionSteps) {
    const bucket = stepsByRunId.get(row.workflowRunId);
    if (bucket) bucket.push(row);
    else stepsByRunId.set(row.workflowRunId, [row]);
  }

  // [계약 5] root 마다 accepted 이력 수집기 재사용 — selected run 은 selected 결과 배열을,
  //   형제는 형제 raw steps 로 readResumeScopedHistory(db, {company, mission, run}, steps).
  const histories: ResumeScopedHistory[] = [];
  for (const run of missionRuns) {
    if (run.id === selected.run.id) {
      histories.push(selected);
      continue;
    }
    histories.push(await readResumeScopedHistory(
      db,
      {
        companyId: selected.scope.companyId,
        missionId: selected.scope.missionId,
        workflowRunId: run.id,
      },
      stepsByRunId.get(run.id) ?? [],
    ));
  }

  // [계약 6] DB primary key 기준 병합 + id lexical 정렬.
  const history: ResumeScopedHistory = {
    issues: mergeByIdLexical(histories.map((entry) => entry.issues)),
    wakeups: mergeByIdLexical(histories.map((entry) => entry.wakeups)),
    heartbeats: mergeByIdLexical(histories.map((entry) => entry.heartbeats)),
    delegations: mergeByIdLexical(histories.map((entry) => entry.delegations)),
  };

  // [계약 7] union 위에서 resource 수집은 한 번 — 형제 run heartbeat 의 자원까지 포함된다.
  const resources = await readResumeScopedResources(db, selected.scope, history);
  return { selected, missionRuns, missionSteps, history, resources };
}
