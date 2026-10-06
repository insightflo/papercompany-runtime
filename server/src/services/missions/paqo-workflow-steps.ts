// server/src/services/missions/paqo-workflow-steps.ts
//
// [파일 목적] buildPaqoWorkflowSteps — 승인된 PLAN decision 단위를 실행 가능한 워크플로
//   스텝으로 물화하는 순수 생성기. mission-owner-plan-decisions.ts 로부터 1:1 추출했다
//   (대형 파일 축소, 호환 재노출은 원본 파일이 담당 — 행동 불변).
// [수정 재사용 원문 복사] options.reuse 로 서버가 유도한 복사 A 단계(copiedSteps)를 받으면
//   A 는 원본 실행 스냅샷을 structuredClone 원문 복사한다(재저작 금지, sourceStepId 는 해당
//   단계 자신의 ID — 직계 원본 좌표). B 만 기존 생성기로 저작하고 machine-check gate/계약
//   재작성은 B 에만 적용한다. 예약된 과거 QA ID(qaStepIdByUnitId/finalQaStepId)는 새 QA 가
//   그 역사적 ID 를 이어받아 A 의 기존 back-edge 참조가 매달리지 않게 한다(구성·판정·산출의
//   복사는 없다 — QA 는 항상 신규 실행).
import { normalizeMissionPlanDependencyGraph } from "./mission-plan-dependency-graph.js";
import { stableStringify } from "../issue-execution-cards/hash.js";
import { synthesizeQaReworkBackEdge } from "./supervision-helpers.js";
import { normalizeWorkflowStepMachineChecks } from "../workflow/step-contract.js";
import { buildPaqoStepDescription } from "../workflow/revision-generated-description.js";
import {
  buildMissionPlanUnitStepContract,
  renderMissionPlanQaUnitContractLines,
  renderMissionPlanUnitContractLines,
} from "./mission-plan-unit-contract.js";
import { buildVerificationBeforeCompletionCriteria } from "./mission-quality-contract.js";
import { buildDeliveryVerificationCriteria } from "../workflow/delivery-verification-gate.js";
import {
  isDeclaredStructuralUnit,
  validateStructuralUnit,
  validateStructuralTopology,
  fillStructuralValidatorToolArgs,
} from "./structural-materialization.js";
import { applyPaqoArtifactContracts } from "./paqo-artifact-contracts.js";
import { hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import type { PlanRevisionDraft } from "../mission-owner-plan-decisions.js";
import {
  applyCanonicalDependencies,
  buildUnitStepIdMap,
  inferPaqoIssueGroup,
  insertStepMachineCheckGates,
  isPlainObject,
  readPaqoGraphWorkProductRequired,
  readSelectedUnitKnowledgeBaseIds,
  readSelectedUnitSkillRefs,
  readSelectedUnitWorkflowToolArgs,
  readSelectedUnitWorkflowToolNames,
  shortStableHash,
  stripIssueGroupPrefix,
  toNonEmptyString,
} from "./paqo-workflow-step-helpers.js";

/** [수정 재사용] 서버가 유도한 복사/예약 정보 — 빌더는 DB 를 읽지 않고 이 값만 쓴다. */
export type PaqoRevisionReuseOptions = {
  /** 단위 id(=원본 단계 id) → 원문 복사할 원본 실행 스텝(sourceStepId 는 자기 자신 ID 로 세팅된 복사본). */
  readonly copiedSteps: ReadonlyMap<string, WorkflowStep>;
  /** 신규 QA B 단위 id → 이어받을 과거 QA 단계 ID(구성 재사용 아님 — 실행은 신규). */
  readonly qaStepIdByUnitId: ReadonlyMap<string, string>;
  /** 생성되는 미션 최종 QA 가 이어받을 과거 QA ID(예약이 확정된 경우만). */
  readonly finalQaStepId: string | null;
};

export function buildPaqoWorkflowSteps(
  draft: PlanRevisionDraft,
  mission: { readonly id: string; readonly title: string; readonly ownerAgentId: string },
  options: { researchWorkbenchAvailable?: boolean; tools?: readonly PlanningArtifactTool[];
    reuse?: PaqoRevisionReuseOptions } = {},
): WorkflowStep[] {
  // [슬라이스 Q4/Q5 부분진행] 변경안이 차단(revisionBlocked) 또는 별도 범위(revisionSeparateScope) 로
  //   선언한 단위는 실행 그래프에서 제외된다 — 해당 단계가 정의에 물화되지 않으므로 그 도구 실행은
  //   발생할 수 없다(대체 게시/전체완료·정기 정의 영구 적용 아님). 진행 단위의 제외 단위 참조
  //   (의존/선택자/실행인자)는 제출 게이트에서 선제 거부된다.
  const dependencyGraph = normalizeMissionPlanDependencyGraph(
    draft.refs.selectedExecutionUnits.filter(unit => unit.revisionBlocked !== true && unit.revisionSeparateScope !== true),
    draft.steps,
  );
  if (!dependencyGraph.ok) {
    throw new Error(`Invalid canonical mission-plan dependency graph: ${dependencyGraph.diagnostics.map((entry) => entry.message).join("; ")}`);
  }
  const executableUnits = dependencyGraph.graph.materializedUnits;
  const reuse = options.reuse;
  const copiedUnitIds = reuse ? new Set(reuse.copiedSteps.keys()) : new Set<string>();
  const selectedSteps = executableUnits.map((unit, index) => {
    // [수정 재사용] A 는 서버가 준비한 원본 실행 스냅샷의 원문 복사다 — 여기서 재저작/파생하지 않는다.
    const unitId = toNonEmptyString(unit.id);
    if (unitId && reuse?.copiedSteps.has(unitId)) {
      return structuredClone(reuse.copiedSteps.get(unitId)) as WorkflowStep;
    }
    const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
    const assigneeAgentId =
      toNonEmptyString(unit.assigneeAgentId) ??
      toNonEmptyString(unit.agentId) ??
      mission.ownerAgentId;
    const rawTitle =
      toNonEmptyString(unit.title)
        ?? toNonEmptyString(unit.name)
        ?? toNonEmptyString(unit.id)
        ?? `Execution unit ${index + 1}`;
    const group = inferPaqoIssueGroup(unit);
    const title = stripIssueGroupPrefix(rawTitle);
    const groupLabel = group.toUpperCase();
    const graphWorkProductRequired = isDeclaredStructuralUnit(unit)
      ? false
      : readPaqoGraphWorkProductRequired(unit, group);
    validateStructuralUnit(unit, title, index);
    const toolNames = readSelectedUnitWorkflowToolNames(unit);
    const toolArgs = readSelectedUnitWorkflowToolArgs(unit);
    const knowledgeBaseIds = readSelectedUnitKnowledgeBaseIds(unit);
    const skillRefs = readSelectedUnitSkillRefs(unit);
    const outcomeContractLines = renderMissionPlanUnitContractLines(unit);
    const stepContract = buildMissionPlanUnitStepContract(unit);
    // [machine-check gates] 유닛의 구조화 machineChecks 를 계약에 첨부한다.
    // 실행 권위는 materializer 가 gate 스텝 toolArgs 로 복사한 값에만 있다(규칙 8).
    const unitMachineChecks = normalizeWorkflowStepMachineChecks(unit.machineChecks);
    const stepContractWithChecks = (stepContract || unitMachineChecks)
      ? {
        ...(stepContract ?? {}),
        ...(unitMachineChecks ? { machineChecks: unitMachineChecks } : {}),
      }
      : undefined;
    // Issue-less tools retain the assignee only as plan-time grant metadata.
    const isStructural = isDeclaredStructuralUnit(unit);
    const stepAgentId = isStructural ? "" : assigneeAgentId;
    // [수정 재사용] 신규 QA B 가 예약된 과거 QA ID 를 이어받는다(그 외 B 는 기존 생성 ID).
    const reservedQaStepId = unitId ? reuse?.qaStepIdByUnitId.get(unitId) : undefined;
    return {
      id: reservedQaStepId
        ?? `${group}-${index + 1}-${shortStableHash({ missionId: mission.id, index, sourceRef, title, group })}`,
      ...(unit.sourceStepId !== undefined ? { sourceStepId: unit.sourceStepId as string } : {}),
      name: `[${groupLabel}] ${title}`,
      agentId: stepAgentId,
      dependencies: [],
      graphWorkProductRequired,
      ...(toolNames.length > 0 ? { toolNames } : {}),
      ...(toolArgs !== undefined ? { toolArgs } : {}),
      ...(isPlainObject(unit.interpretedInputs) ? { interpretedInputs: unit.interpretedInputs } : {}),
      ...(knowledgeBaseIds.length > 0 ? { knowledgeBaseIds } : {}),
      ...(stepContractWithChecks ? { contract: stepContractWithChecks } : {}),
      ...(isStructural ? { type: "tool", qaType: "structural", assigneeAgentId } : { type: group }),
      ...(!isStructural && group === "qa" && typeof unit.qaType === "string" ? { qaType: unit.qaType } : {}),
      // [생성 설명 계약] 표시용 미션 제목은 실행 지시와 분리된 typed 입력으로만 주입한다(문자열 필터링 아님).
      ...buildPaqoStepDescription(mission.title, [
        `Mission-level PAQO ${groupLabel} issue materialized from an authorized PLAN decision.`,
        isStructural
          ? `Materialized as issue-less structural tool gate (no agent heartbeat).`
          : `Assigned by PLAN decision to agentId: ${assigneeAgentId}`,
        skillRefs.length > 0 ? `Skill refs considered by PLAN: ${skillRefs.join(", ")}` : null,
        toNonEmptyString(unit.reason) ? `Reason: ${toNonEmptyString(unit.reason)}` : null,
        toNonEmptyString(unit.instructions) ? `Revision delta instructions: ${toNonEmptyString(unit.instructions)}` : null,
        ...outcomeContractLines,
        sourceRef ? `Source ref: ${stableStringify(sourceRef)}` : null,
      ]),
    } satisfies WorkflowStep;
  });
  const plannedSteps = applyCanonicalDependencies(executableUnits, selectedSteps);
  if (plannedSteps.length === 0) return [];
  // [machine-check gates] machineChecks 가 있는 생산자 뒤에 structural gate 물리화.
  const gatedSteps = insertStepMachineCheckGates(plannedSteps);
  // [Hybrid QA] Structural materialization passes (extracted):
  //   - toolArgs reference rewriting
  //   - scoped prompt injection for all QA downstream of structural gates
  const unitIdToStepId = buildUnitStepIdMap(executableUnits, plannedSteps);
  applyPaqoArtifactContracts(executableUnits, selectedSteps, gatedSteps, unitIdToStepId, copiedUnitIds);
  // [실행 가능성 보증] 인자 없는 structural tool 스텝은 실행 시 반드시 실패한다(2026-08-27 gazza-evening 2).
  // 표준 검증 인자 자동 채움 → 불가능하면 fail-closed 거부.
  fillStructuralValidatorToolArgs(gatedSteps);
  validateStructuralTopology(gatedSteps as Parameters<typeof validateStructuralTopology>[0]);

  // [Delivery Verification Gate] PAQO plan 이 publish/deploy 성격이면 qaStep description 에 readback criteria 강화.
  const isPublishPlan = executableUnits.some(unit => hasPlanArtifactRole(unit, options.tools ?? [], "publication"));
  const unitOutcomeContractLines = renderMissionPlanQaUnitContractLines(
    executableUnits.map((unit, index) => ({
      title: selectedSteps[index]?.name ?? `Execution unit ${index + 1}`,
      unit,
    })),
  );

  const qaStep: WorkflowStep = {
    id: reuse?.finalQaStepId
      ?? `qa-${shortStableHash({ missionId: mission.id, actions: plannedSteps.map((step) => step.id), goal: draft.missionGoal })}`,
    name: "[QA] Verify mission result",
    type: "qa",
    agentId: mission.ownerAgentId,
    dependencies: gatedSteps.map((step) => step.id),
    graphWorkProductRequired: false,
    description: [
      "Mission-level PAQO QA issue. Run independent verification after all ACTION workflow steps complete successfully.",
      "Mission quality contract / purpose-fitness first: verify the deliverable actually achieves the original mission goal (not merely that it is well-structured, published, or source-backed).",
      "",
      buildVerificationBeforeCompletionCriteria(),
      "",
      // [Delivery Verification Gate] publish/deploy plan → readback criteria 강화(중복 QA step 無, description 주입).
      isPublishPlan ? buildDeliveryVerificationCriteria() : null,
      isPublishPlan ? "" : null,
      draft.successCriteria.length > 0 ? `Success criteria: ${JSON.stringify(draft.successCriteria)}` : null,
      draft.steps.length > 0 ? `Planned steps: ${JSON.stringify(draft.steps)}` : null,
      ...unitOutcomeContractLines,
    ].filter(Boolean).join("\n"),
  };

  // [수정 재사용] A/B ID 충돌 방어 — 복사 A·예약 QA·생성/gate ID 가 겹치면 원문 복사 무결성이 깨진다.
  assertPaqoStepIdUniqueness(gatedSteps, qaStep);

  // [P5 control-flow loop] 미션 QA step 이 산출물 생산자(producer) 로 보내는 bounded rework back-edge 자동 합성.
  //   QA 가 request_changes 하면 P4 loop-driver 가 producer 를 rework 한다(maxIterations cap). producer 식별은
  //   resolveProducerStepIdFromDag 에 위임(synthesizeQaReworkBackEdge 내부). forward dependencies[] 는 불변.
  //   합성 대상은 이 미션 최종 QA(qaStep) 단 하나 — 중간 단계 QA 회복은 runtime supervision 담당.
  // [수정 재사용] copiedStepIds 로 새 rework 엣지가 복사 A 를 대상으로 추가되지 않게만 한다(기존 엣지 보존).
  return synthesizeQaReworkBackEdge(
    [...gatedSteps, qaStep],
    qaStep.id,
    undefined,
    { allowCapAcceptance: true, tools: options.tools, ...(copiedUnitIds.size > 0 ? { copiedStepIds: copiedUnitIds } : {}) },
  );
}

function assertPaqoStepIdUniqueness(steps: WorkflowStep[], qaStep: WorkflowStep): void {
  const seen = new Set<string>([qaStep.id]);
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`mission_revision_reuse_id_collision: materialized step id ${step.id} is duplicated`);
    }
    seen.add(step.id);
  }
}
