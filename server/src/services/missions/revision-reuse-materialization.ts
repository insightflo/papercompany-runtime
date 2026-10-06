// server/src/services/missions/revision-reuse-materialization.ts
//
// [파일 목적] 수정 재사용(원문 복사)의 DB 준비/물화 검증(변경지도 §4).
//   prepareRevisionReuse: 제출된 decision 의 reuse 마커를 같은 회사 원본 실행 스냅샷에서
//   검증하고(cloures 완료·seed 자격·회사 도구 선언), 원문 복사본/서버 투영/예약 QA ID 를
//   만든다. 실행 권한은 이 구조화 결과뿐이다 — 문구·플래그에서 권위를 만들지 않는다(규칙 8).
//   loadRevisionReuseSteps: 재시도/회복 경로가 활성 계획 refs 의 기계 지도를 다시 원본 실행과
//   대조해 복사본을 재유도한다(지속화된 면제 플래그를 신뢰하지 않는다).
//   assertRevisionReuseUnchanged: 물화·저장된 정의가 복사본과 byte 동등인지 검증한다.
import { and, eq, inArray } from "drizzle-orm";
import { toolDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import { HttpError } from "../../errors.js";
import { requireSeedSource } from "../workflow/workflow-seed-evidence.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { isSeedSupportedStep } from "../workflow/workflow-seed-admission.js";
import { isNativeToolStep } from "../workflow/workflow-seed-tool-output.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { stableStringify } from "../issue-execution-cards/hash.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { loadMissionRow } from "./revision-plan-validation.js";
import {
  assignReservedQaStepIds,
  buildCanonicalRevisionDelta,
  collectClosureConflicts,
  collectIdentityOnlyViolations,
  collectStepOverrideViolations,
  parseRevisionReusePlanRecord,
  projectReuseStepToUnit,
  resolveReuseClosure,
  type RevisionReuseDiagnostic,
  type RevisionReusePlanRecord,
} from "./revision-reuse-plan.js";

const reuseInvalid = (message: string): RevisionReuseDiagnostic =>
  ({ code: "mission_revision_reuse_invalid", message, severity: "invalid" });

/** 서버가 유도한 재사용 실행 정보(빌더 options.reuse 와 저장 copiedStepIds 의 원천). */
export type RevisionReuseRuntime = {
  readonly planRecord: RevisionReusePlanRecord;
  readonly copiedSteps: Map<string, WorkflowStep>;
  readonly qaStepIdByUnitId: Map<string, string>;
  readonly finalQaStepId: string | null;
};

export type RevisionReusePreparation = RevisionReuseRuntime & {
  readonly projectedUnits: Record<string, unknown>[];
  readonly canonicalDelta: Record<string, unknown>;
  readonly canonicalDecision: Record<string, unknown>;
};

export type RevisionReusePreparationResult =
  | { ok: true; preparation: RevisionReusePreparation | null }
  | { ok: false; diagnostics: RevisionReuseDiagnostic[] };

function readAuthoredUnits(decision: Record<string, unknown>): Record<string, unknown>[] | null {
  const units = decision.selectedExecutionUnits;
  if (!Array.isArray(units) || !units.every(unit => unit && typeof unit === "object" && !Array.isArray(unit))) return null;
  return units as Record<string, unknown>[];
}

async function loadSnapshotForMission(db: Db, companyId: string, missionId: string, sourceRunId: string) {
  // 같은 회사 스코프의 원본 실행만 허용한다(requireSeedSource 가 미션-원본 연결·회사 경계를 검증).
  const { source } = await requireSeedSource(db, companyId, missionId, sourceRunId);
  const definition = await loadExecutionDefinition(db, source.id, { requireHistorical: true });
  return { source, steps: definition.steps as WorkflowStep[] };
}

async function assertCompanyDeclaresTools(db: Db, companyId: string, names: readonly string[]): Promise<string | null> {
  if (names.length === 0) return null;
  const rows = await db.select({ name: toolDefinitions.name, enabled: toolDefinitions.enabled })
    .from(toolDefinitions).where(and(eq(toolDefinitions.companyId, companyId), inArray(toolDefinitions.name, [...names])));
  const declared = new Map(rows.map(row => [row.name, row.enabled]));
  for (const name of names) {
    if (!declared.has(name)) return `회사가 도구 ${name} 을(를) 선언하지 않았습니다`;
    if (declared.get(name) !== true) return `회사의 도구 ${name} 이(가) 비활성 상태입니다`;
  }
  return null;
}

/** 원본 스냅샷에서 복사 클로저를 검증·복사하고 예약 QA ID 를 배정한다(prepare/reload 공통). */
async function buildReuseRuntime(db: Db, input: {
  companyId: string; missionId: string; sourceRunId: string;
  roots: readonly string[]; authoredUnits: readonly Record<string, unknown>[];
}): Promise<{ ok: true; runtime: RevisionReuseRuntime } | { ok: false; diagnostics: RevisionReuseDiagnostic[] }> {
  let snapshot: { source: { id: string }; steps: WorkflowStep[] };
  try {
    snapshot = await loadSnapshotForMission(db, input.companyId, input.missionId, input.sourceRunId);
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, diagnostics: [reuseInvalid(
        `재사용 원본 실행(${input.sourceRunId}) 을(를) 이 회사·미션 범위에서 확인할 수 없습니다: ${error.message}`)] };
    }
    throw error;
  }
  const byId = new Map(snapshot.steps.map(step => [step.id, step]));
  const closure = resolveReuseClosure(snapshot.steps, input.roots);
  if (!closure.ok) return { ok: false, diagnostics: closure.diagnostics };
  const closureIds = closure.closure;

  const diagnostics: RevisionReuseDiagnostic[] = [];
  const completed = new Set((await db.select({ stepId: workflowStepRuns.stepId }).from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.workflowRunId, snapshot.source.id), eq(workflowStepRuns.status, "completed"))))
    .map(row => row.stepId));
  for (const id of closureIds) {
    const step = byId.get(id)!;
    if (!completed.has(id)) {
      diagnostics.push({
        code: "mission_revision_reuse_source_incomplete",
        message: `재사용 대상(또는 클로저 조상) ${id} 이(가) 원본 실행에서 완료되지 않았습니다 — 완료된 성공 단계만 복사할 수 있습니다.`,
        severity: "invalid",
      });
      continue;
    }
    if (!isSeedSupportedStep(step)) {
      diagnostics.push({
        code: "mission_revision_reuse_unsupported_step",
        message: `재사용 대상 ${id} 은(는) seed 재사용이 지원하지 않는 단계입니다(QA/동적/조건 분기 등).`,
        severity: "invalid",
      });
      continue;
    }
    if (isNativeToolStep(step)) {
      const names = step.toolNames ?? [];
      const toolProblem = await assertCompanyDeclaresTools(db, input.companyId, names);
      if (toolProblem) {
        diagnostics.push({
          code: "mission_revision_reuse_unsupported_step",
          message: `재사용 대상 ${id} 의 도구가 현재 회사에서 실행 불가능합니다 — ${toolProblem}.`,
          severity: "invalid",
        });
      }
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  // 원문 복사: structuredClone 원본, sourceStepId 는 해당 단계 자신의 ID(직계 원본 좌표).
  const copiedSteps = new Map<string, WorkflowStep>();
  for (const id of closureIds) {
    const copy = structuredClone(byId.get(id)!) as WorkflowStep & { sourceStepId?: string };
    copy.sourceStepId = id;
    copiedSteps.set(id, copy);
  }

  // A 의 기존 back-edge 가 참조하는 과거 QA ID 예약(구성·판정·산출 복사 없음 — 새 QA 가 ID 를 이어받는다).
  const reservedQaStepIds = [...new Set(closureIds.flatMap(id => {
    const step = byId.get(id)!;
    return ((step as WorkflowStep & { conditionalDependencies?: Array<{ stepId: string; isBackEdge?: boolean }> })
      .conditionalDependencies ?? []).filter(edge => edge.isBackEdge === true).map(edge => edge.stepId);
  }))];
  const assignment = assignReservedQaStepIds({ reservedQaStepIds, authoredUnits: input.authoredUnits });
  if (!assignment.ok) return { ok: false, diagnostics: assignment.diagnostics };

  return {
    ok: true,
    runtime: {
      planRecord: {
        schemaVersion: "mission-revision-reuse.v1",
        sourceWorkflowRunId: input.sourceRunId,
        roots: [...input.roots],
        closureUnitIds: closureIds,
      },
      copiedSteps,
      qaStepIdByUnitId: assignment.qaStepIdByUnitId,
      finalQaStepId: assignment.finalQaStepId,
    },
  };
}

/**
 * 제출 게이트 최초 준비(첫 의존 정규화 이전). 재사용 마커가 없으면 preparation:null —
 * 일반 경로(변경안 없음/재사용 없는 변경안)는 기존 동작을 그대로 따른다.
 */
export async function prepareRevisionReuse(db: Db, input: {
  companyId: string; missionId: string; decision: Record<string, unknown>;
}): Promise<RevisionReusePreparationResult> {
  const rawDelta = "revisionDelta" in input.decision ? input.decision.revisionDelta : undefined;
  if (rawDelta === undefined || rawDelta === null) return { ok: true, preparation: null };
  const parsed = missionRevisionDeltaSchema.safeParse(rawDelta);
  if (!parsed.success) {
    // 기존 delta 검증기와 같은 코드로 구조 거절 — 사전 준비 단계에서 조기 차단한다.
    return { ok: false, diagnostics: [{
      code: "mission_revision_delta_invalid",
      message: `revisionDelta 가 mission-revision-delta.v1 계약과 일치하지 않습니다: `
        + parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      severity: "invalid",
    }] };
  }
  const reuseUnits = parsed.data.units.filter(unit => unit.operation === "reuse");
  if (reuseUnits.length === 0) return { ok: true, preparation: null };

  const authoredUnits = readAuthoredUnits(input.decision);
  if (!authoredUnits) return { ok: false, diagnostics: [reuseInvalid("selectedExecutionUnits 이 올바른 배열이 아닙니다.")] };
  const reuseUnitIds = new Set(reuseUnits.map(unit => unit.unitId));
  for (const unitId of reuseUnitIds) {
    if (!authoredUnits.some(unit => unit.id === unitId)) {
      return { ok: false, diagnostics: [reuseInvalid(`재사용 단위 ${unitId} 이(가) 계획 단위에 없습니다.`)] };
    }
  }
  const identityViolations = collectIdentityOnlyViolations(authoredUnits, reuseUnitIds);
  if (identityViolations.length > 0) return { ok: false, diagnostics: identityViolations };

  const mission = await loadMissionRow(db, input.companyId, input.missionId);
  if (!mission?.sourceMissionId || !mission.sourceWorkflowRunId
    || mission.sourceWorkflowRunId !== parsed.data.sourceWorkflowRunId) {
    return { ok: false, diagnostics: [reuseInvalid(
      `재사용 원본 실행(${parsed.data.sourceWorkflowRunId}) 이(가) 이 미션의 같은 회사 원본 실행과 일치하지 않습니다.`)] };
  }

  const built = await buildReuseRuntime(db, {
    companyId: input.companyId, missionId: input.missionId, sourceRunId: mission.sourceWorkflowRunId,
    roots: reuseUnits.map(unit => unit.unitId), authoredUnits,
  });
  if (!built.ok) return built;
  const { runtime } = built;

  // [변경 B 보호] 클로저 전체(루트+암묵적 조상)를 원문 제출과 대조 — 충돌하는 저작/변경안 항목이 있으면
  //   투영으로 대체하지 않고 거절한다(변경한 B 가 원본 재사용으로 조용히 바뀌는 것을 막는다).
  const closureConflicts = collectClosureConflicts({
    closureUnitIds: runtime.planRecord.closureUnitIds,
    reuseRootUnitIds: reuseUnitIds,
    authoredUnits,
    deltaUnits: parsed.data.units.map(unit => ({ unitId: unit.unitId, operation: unit.operation })),
  });
  if (closureConflicts.length > 0) return { ok: false, diagnostics: closureConflicts };

  const closureSet = new Set(runtime.planRecord.closureUnitIds);
  const closureProjections = runtime.planRecord.closureUnitIds
    .map(id => projectReuseStepToUnit(runtime.copiedSteps.get(id)!));
  const authoredB = authoredUnits.filter(unit => typeof unit.id === "string" && !closureSet.has(unit.id));
  const projectedUnits: Record<string, unknown>[] = [...authoredB, ...closureProjections];
  const canonicalDelta = buildCanonicalRevisionDelta(rawDelta as Record<string, unknown>, runtime.planRecord.closureUnitIds);
  const canonicalDecision: Record<string, unknown> = {
    ...input.decision,
    selectedExecutionUnits: projectedUnits,
    revisionDelta: canonicalDelta,
  };
  const decisionSteps = Array.isArray(input.decision.steps) ? input.decision.steps : [];
  const stepOverrides = collectStepOverrideViolations(decisionSteps, closureSet);
  if (stepOverrides.length > 0) return { ok: false, diagnostics: stepOverrides };
  return { ok: true, preparation: { ...runtime, projectedUnits, canonicalDelta, canonicalDecision } };
}

/**
 * 재시도/회복·물화 경로: 활성 계획 refs 의 기계 지도(revisionReusePlan)와 변경안을 다시
 * 원본 실행과 대조해 복사 런타임을 재유도한다. 지속화된 값은 재료일 뿐 권위가 아니다.
 */
export async function loadRevisionReuseSteps(db: Db, input: {
  companyId: string; missionId: string;
  planRefs: unknown; selectedExecutionUnits: readonly Record<string, unknown>[];
}): Promise<RevisionReuseRuntime | null> {
  const record = parseRevisionReusePlanRecord(input.planRefs);
  const delta = record && input.planRefs && typeof input.planRefs === "object" && !Array.isArray(input.planRefs)
    ? (input.planRefs as Record<string, unknown>).revisionDelta : null;
  if (!record || !delta || typeof delta !== "object") return null;
  const parsed = missionRevisionDeltaSchema.safeParse(delta);
  if (!parsed.success) return null;
  const mission = await loadMissionRow(db, input.companyId, input.missionId);
  if (!mission?.sourceWorkflowRunId || mission.sourceWorkflowRunId !== record.sourceWorkflowRunId) return null;
  const built = await buildReuseRuntime(db, {
    companyId: input.companyId, missionId: input.missionId, sourceRunId: record.sourceWorkflowRunId,
    roots: record.roots, authoredUnits: [...input.selectedExecutionUnits],
  });
  if (!built.ok) {
    throw new HttpError(422, `mission_revision_reuse_config_drift: ${built.diagnostics[0]!.message}`,
      { code: "mission_revision_reuse_config_drift", diagnostics: built.diagnostics });
  }
  if (built.runtime.planRecord.closureUnitIds.join("|") !== record.closureUnitIds.join("|")) {
    throw new HttpError(422, "mission_revision_reuse_config_drift: 재사용 클로저가 승인 시점과 다릅니다.",
      { code: "mission_revision_reuse_config_drift" });
  }
  return built.runtime;
}

/** 물화/저장된 A 가 복사본과 정확히 동등한지(JSON 동등 + 실행 해시) 검증한다. */
export function assertRevisionReuseUnchanged(
  copiedSteps: ReadonlyMap<string, WorkflowStep>,
  materializedSteps: readonly WorkflowStep[],
): void {
  const byId = new Map(materializedSteps.map(step => [step.id, step]));
  for (const [id, copy] of copiedSteps) {
    const materialized = byId.get(id);
    if (!materialized) {
      throw new HttpError(422, `mission_revision_reuse_config_drift: 복사 단계 ${id} 이(가) 물화 결과에 없습니다.`,
        { code: "mission_revision_reuse_config_drift", stepId: id });
    }
    if (stableStringify(copy) !== stableStringify(materialized)
      || revisionStepHash(copy as RevisionStep, [...materializedSteps] as RevisionStep[])
        !== revisionStepHash(materialized as RevisionStep, [...materializedSteps] as RevisionStep[])) {
      throw new HttpError(422, `mission_revision_reuse_config_drift: 복사 단계 ${id} 의 물화 결과가 원본과 다릅니다.`,
        { code: "mission_revision_reuse_config_drift", stepId: id });
    }
  }
}

export function reuseCopiedStepIds(runtime: RevisionReuseRuntime | null | undefined): ReadonlySet<string> | undefined {
  return runtime ? new Set(runtime.copiedSteps.keys()) : undefined;
}
