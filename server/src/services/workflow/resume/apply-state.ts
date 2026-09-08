import { conflict } from "../../../errors.js";
import type { SnapshotState } from "./snapshot-state.js";
import type { ResumeMissionRow, ResumeRunRow, ResumeStepRunRow } from "./serialization.js";
import { jsonSafe } from "./preview-facts.js";

/**
 * [파일 목적] Task6a real atomic apply 의 순수 보조 경계 — beforeState 조립, token scope 대조,
 *   카운터 overflow 가드, affected step 집합의 잠금 row 해상. DB/시계/토큰 접근이 없다.
 * [수정시 주의]
 *   - beforeState 는 리셋 이전의 원본 mission/run/affected step 행 전체를 JSON-safe 로 보존해야
 *     한다(unknown 키 포함). 밖 row/이슈/산출물은 여기서 다루지 않는다 — 서비스가 건드리지 않는다.
 *   - token scope 불일치는 snapshot.ts 의 균일 공개 오류(stale_snapshot)로 수렴시킨다 — 내부값 노출 금지.
 *   - affected 집합은 fresh preview 가 준 것을 절대 넓히지 않는다. 잠금 steps 밖의 id 는 conflict.
 */

const PG_INT_MAX = 2_147_483_647;

export interface ResumeBeforeStateInput {
  mission: ResumeMissionRow;
  run: ResumeRunRow;
  affectedRows: ResumeStepRunRow[];
}

/** 리셋 전 원본 행 전체를 JSON-safe(Date→ISO)로 보존한 beforeState 를 만든다. */
export function buildResumeBeforeState(input: ResumeBeforeStateInput): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mission: jsonSafe(input.mission),
    run: jsonSafe(input.run),
    steps: input.affectedRows.map((row) => jsonSafe(row)),
  };
}

export interface ResumeScopeFields {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  startStepId: string;
}

/** token state 의 4개 scope 필드가 요청 본문과 정확히 일치하는지 확인한다. */
export function assertSnapshotScopeMatches(scope: SnapshotState["scope"], body: ResumeScopeFields): void {
  if (
    scope.companyId !== body.companyId
    || scope.missionId !== body.missionId
    || scope.workflowRunId !== body.workflowRunId
    || scope.startStepId !== body.startStepId
  ) {
    throw conflict("stale_snapshot");
  }
}

/** run dispatch authority version / resume epoch 의 +1 이 안전한지 확인한다. */
export function assertResumeCountersSafe(
  run: ResumeRunRow,
  state: SnapshotState,
): { authorityVersion: number; resumeEpoch: number } {
  const authorityVersion = run.dispatchAuthorityVersion + 1;
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 0 || authorityVersion > PG_INT_MAX) {
    throw conflict("resume_authority_exhausted");
  }
  const resumeEpoch = state.resumeEpoch + 1;
  if (!Number.isSafeInteger(resumeEpoch) || resumeEpoch < 0 || resumeEpoch > Number.MAX_SAFE_INTEGER) {
    throw conflict("resume_epoch_exhausted");
  }
  return { authorityVersion, resumeEpoch };
}

/**
 * fresh preview 의 affected stepIds 를 serialization 이 잠근 step 행으로 해상한다.
 * 비어 있거나 중복이거나 잠금 집합 밖이면 conflict — 집합을 넓히거나 재질의하지 않는다.
 */
export function resolveAffectedRows(
  steps: ResumeStepRunRow[],
  affectedStepIds: readonly string[],
): ResumeStepRunRow[] {
  if (!Array.isArray(affectedStepIds) || affectedStepIds.length === 0) {
    throw conflict("resume_affected_invalid", { reason: "empty_affected" });
  }
  const byStepId = new Map(steps.map((step) => [step.stepId, step]));
  const seen = new Set<string>();
  const rows: ResumeStepRunRow[] = [];
  for (const stepId of affectedStepIds) {
    if (typeof stepId !== "string" || seen.has(stepId)) {
      throw conflict("resume_affected_invalid", { stepId });
    }
    const row = byStepId.get(stepId);
    if (!row) {
      throw conflict("resume_affected_invalid", { stepId, reason: "unresolved_locked_step" });
    }
    seen.add(stepId);
    rows.push(row);
  }
  return rows;
}
