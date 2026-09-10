import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import {
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  missionAgentRuntimes,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { unprocessable } from "../../../errors.js";
import type { ResumeScopedHistory } from "./read-model-history.js";

/**
 * [파일 목적] Task5c2c raw resource/finalization SELECT 수집기. 검증을 마친 scoped 이력
 *   (issues/heartbeats)의 id 만 입력으로 받아, finalization/finalization-step/workspace-operation/
 *   workspace-runtime-service/mission-agent-runtime 의 연관 행을 전체 행($inferSelect, Date/lease/
 *   payload/version 보존)으로 수집한다. read-model.ts 의 내부 조립부로, frozen step set 검증과
 *   scoped 이력 조회가 모두 끝난 뒤에만 호출된다. reader 자체와 마찬가지로 SELECT 표면만 사용한다.
 * [명시적 한계 — 문서/주석이 그 이상을 주장하지 않도록 유지할 것]
 *   - raw association collection 이다: quiescence/settlement/evidence completeness 의 증명이 아니다.
 *     행이 없다고 정산(settlement)이 끝났거나, 행이 있다고 완전한 근거가 되는 것은 아니다.
 *   - eligibility policy 가 아니다: status/version/lease/payload 로 걸러내거나 해석하지 않고
 *     terminal/unknown/pending/expired 등 모든 상태를 raw 로 보존한다(이전 generation 포함).
 *   - 다른 mission 소속 행이 run/issue 로 묶여 들어오면 certified authority 가 아니라 raw conflict
 *     로 보존된다. 이 수집만으로 그 행의 소속·권위를 인정하지 않는다.
 *   - unmapped/shared-workspace 연관(위 술어 어느 쪽으로도 닿지 않는 workspace 행)은 수집되지
 *     않으며, 이 collector 는 그 부재를 완전성의 증거로 쓰지 않는다.
 * [불변식]
 *   - 이 테이블들의 질의는 company 로 좁히지 않는다(타회사 오염 참조가 숨겨지는 것을 막기 위해).
 *     대신 반환된 모든 행의 companyId 를 검증해 scope_mismatch 로 거부한다.
 *   - 빈 id 집합에는 inArray 를 만들지 않는다 — 비어있지 않은 술어만 조립하고, 술어가 하나도
 *     없으면 질의하지 않고 [] 를 반환한다(invalid SQL(`in ()`)·전체 스캔 동시 회피).
 *   - 모든 목록은 table.id 오름차순(결정적). 중복 stageKind 는 다른 idempotencyKey 면 정당한
 *     이력이므로 접지 않는다. parent 검증은 회사 검증 이후에 한다.
 *   - stage 의 두 FK(heartbeatRunId, heartbeatRunFinalizationId)는 서로 독립적이다: heartbeat 로
 *     묶인 stage 는 parent 가 선택 집합에 없으면 거부되고, parent 로 묶인 stage 는 heartbeat 이
 *     모순되면 거부된다 — 조용히 걸러지지 않는다. 누락된 parent 레코드를 발명/보충하지 않는다.
 *   - transaction/lock/SET 을 시작하지 않는다. repeatable-read 일관성은 호출자 트랜잭션 소관이다.
 */

type FinalizationRow = typeof heartbeatRunFinalizations.$inferSelect;
type FinalizationStepRow = typeof heartbeatRunFinalizationSteps.$inferSelect;
type WorkspaceOperationRow = typeof workspaceOperations.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type MissionAgentRuntimeRow = typeof missionAgentRuntimes.$inferSelect;

export interface ResumeScopedResources {
  finalizations: FinalizationRow[];
  finalizationSteps: FinalizationStepRow[];
  workspaceOperations: WorkspaceOperationRow[];
  workspaceRuntimeServices: WorkspaceRuntimeServiceRow[];
  missionAgentRuntimes: MissionAgentRuntimeRow[];
}

interface ResourceScope {
  companyId: string;
  missionId: string;
}

type ResourceHistory = Pick<ResumeScopedHistory, "issues" | "heartbeats">;

function scopeMismatch(reason: string) {
  return unprocessable("scope_mismatch", { reason });
}

function historyUnproven(reason: string) {
  return unprocessable("resume_history_unproven", { reason });
}

/** 계약 전체: 검증된 이력 id 집합에서 다섯 resource 테이블의 raw 연관 행을 수집한다. */
export async function readResumeScopedResources(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  history: ResourceHistory,
): Promise<ResumeScopedResources> {
  const heartbeatIds = history.heartbeats.map((row) => row.id);
  const issueIds = history.issues.map((row) => row.id);

  const finalizations = await readFinalizations(db, scope, heartbeatIds);
  const finalizationSteps = await readFinalizationSteps(db, scope, heartbeatIds, finalizations);
  const workspaceOperations = await readWorkspaceOperations(db, scope, heartbeatIds);
  const workspaceRuntimeServices = await readRuntimeServices(db, scope, heartbeatIds, issueIds);
  const missionAgentRuntimes = await readMissionRuntimes(db, scope, heartbeatIds, issueIds);
  return { finalizations, finalizationSteps, workspaceOperations, workspaceRuntimeServices, missionAgentRuntimes };
}

/** heartbeatRunId IN(검증된 이력) — 빈 집합이면 질의 없이 []. */
async function readFinalizations(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  heartbeatIds: string[],
): Promise<FinalizationRow[]> {
  if (heartbeatIds.length === 0) return [];
  const rows = await db.select().from(heartbeatRunFinalizations)
    .where(inArray(heartbeatRunFinalizations.heartbeatRunId, heartbeatIds))
    .orderBy(heartbeatRunFinalizations.id);
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("finalization_company_mismatch");
  }
  return rows;
}

/**
 * heartbeatRunId IN OR heartbeatRunFinalizationId IN(선택된 finalization) — 두 FK 는 독립적이라
 * OR 로 모두 조회한 뒤, 회사 검증 → parent 존재 → parent.heartbeatRunId 일치 순으로 검증한다.
 */
async function readFinalizationSteps(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  heartbeatIds: string[],
  finalizations: FinalizationRow[],
): Promise<FinalizationStepRow[]> {
  const finalizationIds = finalizations.map((row) => row.id);
  const predicates: SQL<unknown>[] = [];
  if (heartbeatIds.length > 0) predicates.push(inArray(heartbeatRunFinalizationSteps.heartbeatRunId, heartbeatIds));
  if (finalizationIds.length > 0) {
    predicates.push(inArray(heartbeatRunFinalizationSteps.heartbeatRunFinalizationId, finalizationIds));
  }
  if (predicates.length === 0) return [];
  const rows = await db.select().from(heartbeatRunFinalizationSteps)
    .where(or(...predicates)).orderBy(heartbeatRunFinalizationSteps.id);

  // 회사 검증을 parent 링크 검증보다 먼저 — 오염 행은 parent 판정 이전에 거부된다.
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("finalization_step_company_mismatch");
  }
  const parentById = new Map(finalizations.map((row) => [row.id, row]));
  for (const row of rows) {
    const parent = parentById.get(row.heartbeatRunFinalizationId);
    if (!parent) throw historyUnproven("finalization_parent_unproven");
    if (parent.heartbeatRunId !== row.heartbeatRunId) throw historyUnproven("finalization_run_mismatch");
  }
  return rows;
}

/** heartbeatRunId IN(검증된 이력) — 빈 집합이면 질의 없이 []. */
async function readWorkspaceOperations(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  heartbeatIds: string[],
): Promise<WorkspaceOperationRow[]> {
  if (heartbeatIds.length === 0) return [];
  const rows = await db.select().from(workspaceOperations)
    .where(inArray(workspaceOperations.heartbeatRunId, heartbeatIds))
    .orderBy(workspaceOperations.id);
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("workspace_operation_company_mismatch");
  }
  return rows;
}

/**
 * startedByRunId IN OR issueId IN OR (scopeType='run' AND scopeId IN) — 세 독립 연관 전부.
 * scopeId 가 같은 문자열이어도 non-run scope 단독으로는 매치하지 않는다. agent/project/workspace
 * 확장은 하지 않는다. 술어가 하나도 없으면 질의하지 않는다.
 */
async function readRuntimeServices(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  heartbeatIds: string[],
  issueIds: string[],
): Promise<WorkspaceRuntimeServiceRow[]> {
  const predicates: SQL<unknown>[] = [];
  if (heartbeatIds.length > 0) predicates.push(inArray(workspaceRuntimeServices.startedByRunId, heartbeatIds));
  if (issueIds.length > 0) predicates.push(inArray(workspaceRuntimeServices.issueId, issueIds));
  if (heartbeatIds.length > 0) {
    predicates.push(and(
      eq(workspaceRuntimeServices.scopeType, "run"),
      inArray(workspaceRuntimeServices.scopeId, heartbeatIds),
    )!);
  }
  if (predicates.length === 0) return [];
  const rows = await db.select().from(workspaceRuntimeServices)
    .where(or(...predicates)).orderBy(workspaceRuntimeServices.id);
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("workspace_service_company_mismatch");
  }
  return rows;
}

/**
 * missionId=scope OR lastRunId IN OR currentIssueId IN — bootstrap-only(링크 없는 같은 mission 행)와
 * lastRunId 가 다른 곳으로 옮겨간 같은 mission 행도 missionId 술어로 포함되고, 다른 mission 행이
 * run/issue 로 묶여 오면 raw conflict 로 보존된다. missionId 술어가 항상 있으므로 빈 질의는 없다.
 */
async function readMissionRuntimes(
  db: Pick<Db, "select">,
  scope: ResourceScope,
  heartbeatIds: string[],
  issueIds: string[],
): Promise<MissionAgentRuntimeRow[]> {
  const predicates: SQL<unknown>[] = [eq(missionAgentRuntimes.missionId, scope.missionId)];
  if (heartbeatIds.length > 0) predicates.push(inArray(missionAgentRuntimes.lastRunId, heartbeatIds));
  if (issueIds.length > 0) predicates.push(inArray(missionAgentRuntimes.currentIssueId, issueIds));
  const rows = await db.select().from(missionAgentRuntimes)
    .where(or(...predicates)).orderBy(missionAgentRuntimes.id);
  for (const row of rows) {
    if (row.companyId !== scope.companyId) throw scopeMismatch("mission_runtime_company_mismatch");
  }
  return rows;
}
