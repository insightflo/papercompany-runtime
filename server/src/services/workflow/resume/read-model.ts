import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../../../errors.js";
import {
  loadExecutionDefinition,
  type LoadedExecutionDefinition,
} from "../execution-definition.js";
import { snapshotScopeSchema } from "./snapshot-state.js";
import { readResumeScopedHistory, type ResumeScopedHistory } from "./read-model-history.js";
import { readResumeScopedResources, type ResumeScopedResources } from "./read-model-resources.js";

/**
 * [파일 목적] Task5c2a scoped SELECT-only 실행 이력 reader — preview 이후 조립을 위한
 *   실제 DB 근거 수집기다. 엄격한 snapshotScopeSchema 로 scope 를 먼저 검증한 뒤,
 *   mission → run → frozen definition → step set 순으로 확인하고 scoped 이력
 *   (issues/wakeups/heartbeats/delegations)을 전체 행($inferSelect, Date 보존)으로 반환한다.
 * [명시적 한계 — 문서/주석이 resumability·quiescence 증명을 주장하지 않도록 유지할 것]
 *   - eligibility policy 가 아니다: status/flag/그래프 해석을 하지 않고 raw 이력만 돌려준다.
 *   - 완전한 canonical evidence reader 가 아니다: evidence/approval/budget/registry binding,
 *     token/factsHash/eligible-flag 는 이후 슬라이스 소관이며 여기서 만들지 않는다.
 *   - signer/API 통합이 아니다: snapshot 토큰 발급·검증 경로와 무관하다.
 *   - legacy payload-only 연관(jsonb 내부 참조)은 Task5c2b 가 최상위 JSON 문자열 동등 참조까지만
 *     최소 수집한다(read-model-legacy). 여전히 그 수집이 lineage/quiescence 의 완전한 증명은 아니다.
 *   - Task5c2c raw resource/finalization 연관(finalization/finalization-step/workspace-operation/
 *     workspace-runtime-service/mission-agent-runtime)은 read-model-resources 가 raw association
 *     collection 으로 수집한다 — quiescence/settlement/evidence completeness 주장이 아니다.
 *     unmapped/shared-workspace 연관 등 위 술어로 닿지 않는 행은 수집되지 않으며 그 부재가
 *     완전성의 증거로 쓰이지 않는다.
 *   - 이력 일관성: 반환 값은 호출자가 제공하는 DB 뷰의 그것이다. 이후 snapshot 조립은
 *     caller 가 일관된 REPEATABLE READ 트랜잭션 안에서 본 reader 를 호출해야 한다.
 *   - reader 자체는 transaction/lock/SET 을 시작하지 않는다 — select 표면(Pick<Db,"select">)만
 *     사용하며, 동적 mode/policy 판정과 control 평가는 절대 수행하지 않는다(엔진 실행 없음).
 * [수정시 주의]
 *   - mission/run 스코프 확인 이전에 이력 질의를 하지 않는 순서 계약을 유지할 것.
 *   - frozen step set 은 배열 위치가 아니라 id 집합의 정확한 1:1 대조다.
 *   - wakeups/heartbeats 는 회사 필터로 조회를 좁히지 않고, 반환된 모든 행의 company 를
 *     검증해 타회사 오염 참조를 누락 없이 scope_mismatch 로 거부한다(상세는 read-model-history).
 */

export type ResumeExecutionHistoryScope = z.infer<typeof snapshotScopeSchema>;

export interface ResumeExecutionHistory extends ResumeScopedResources {
  scope: ResumeExecutionHistoryScope;
  mission: typeof missions.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  definition: LoadedExecutionDefinition;
  steps: (typeof workflowStepRuns.$inferSelect)[];
  issues: ResumeScopedHistory["issues"];
  wakeups: ResumeScopedHistory["wakeups"];
  heartbeats: ResumeScopedHistory["heartbeats"];
  delegations: ResumeScopedHistory["delegations"];
}

function stepSetMismatch() {
  return unprocessable("resume_history_unproven", { reason: "step_set_mismatch" });
}

/**
 * scoped 실행 이력을 SELECT-only 로 읽는다. 어떤 DB 상태도 변경하지 않고,
 * lazy write callback 노출 없이 plain object 만 반환한다.
 */
export async function readResumeExecutionHistory(
  db: Pick<Db, "select">,
  scope: ResumeExecutionHistoryScope,
): Promise<ResumeExecutionHistory> {
  // [계약 0] 어떤 질의보다 먼저 엄격한 scope 검증(passthrough 없음 — 과잉/미지 키 거부).
  const validated = snapshotScopeSchema.parse(scope);

  // [계약 1] mission 은 id AND company 로 조회 — 타회사 mission 은 not found 로 균일화.
  const [mission] = await db.select().from(missions)
    .where(and(eq(missions.id, validated.missionId), eq(missions.companyId, validated.companyId)))
    .limit(1);
  if (!mission) throw notFound("Mission not found");

  // [계약 1] run 은 id AND company AND missionId 로 조회.
  const [run] = await db.select().from(workflowRuns)
    .where(and(
      eq(workflowRuns.id, validated.workflowRunId),
      eq(workflowRuns.companyId, validated.companyId),
      eq(workflowRuns.missionId, validated.missionId),
    ))
    .limit(1);
  if (!run) throw notFound("Workflow run not found");

  // [계약 2] frozen 정의만 — snapshot 이 없거나 corrupt 면 loader 가 fail-closed(422).
  //   live-definition fallback/수리/backfill/정규화는 여기서 하지 않는다.
  const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
  if (!definition.steps.some((step) => step.id === validated.startStepId)) {
    throw notFound("Workflow step not found");
  }

  // [계약 3] step run 전체 행, 결정적 id 오름차순. frozen step id 집합과 정확한 1:1 대조
  //   (배열 위치 아님): 중복/누락/초과/타 run 행 방어 전부 step_set_mismatch.
  const steps = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, run.id))
    .orderBy(workflowStepRuns.id);

  const definitionStepIds = new Set(definition.steps.map((step) => step.id));
  const rowStepIds = new Set<string>();
  for (const row of steps) {
    if (
      row.workflowRunId !== run.id
      || !definitionStepIds.has(row.stepId)
      || rowStepIds.has(row.stepId)
    ) {
      throw stepSetMismatch();
    }
    rowStepIds.add(row.stepId);
  }
  if (rowStepIds.size !== definitionStepIds.size) throw stepSetMismatch();

  // [계약 4-7] issues/wakeups/heartbeats/delegations — 상세 조회·검증은 read-model-history.
  const history = await readResumeScopedHistory(db, validated, steps);

  // [Task5c2c] raw resource/finalization 연관 수집 — raw association collection 이며
  //   quiescence/settlement/evidence completeness 의 증명이 아니다(상세는 read-model-resources).
  const resources = await readResumeScopedResources(db, validated, history);

  return { scope: validated, mission, run, definition, steps, ...history, ...resources };
}
