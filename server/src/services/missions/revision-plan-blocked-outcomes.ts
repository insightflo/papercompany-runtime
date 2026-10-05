// server/src/services/missions/revision-plan-blocked-outcomes.ts
//
// [파일 목적] 수정 변경안(mission-revision-delta.v1) 이 단위를 operation:"blocked" 로 선언한 경우의
//   Q4 부분진행 지원 조각(변경지도 R5/R6 — 슬라이스 Q4). 전체 계획 거절만으로는 기능 부족 단위 하나가
//   승인된 독립 작업까지 막는다. 이 모듈은 (1) 결정에서 차단 선언 단위를 안전하게 읽고, (2) 진행 단위가
//   차단 단위를 의존/선택자/실행인자로 참조하면 조용히 끊지 않고 구조화 거절 진단을 만들고, (3) 차단 단위가
//   실제로 사용하는 toolNames 기준으로 도구 없음/비활성/권한 없음/기능 부족을 평가해 해당 도구 이름을
//   정확히 지칭하는 구조화 결과(outcome)를 남긴다. 결과는 활성 계획 refs(revisionBlockedUnits) 에
//   보존되어 시작 화면 표시로만 소비된다(대체 게시/전체완료 아님).
// [연결] mission-owner-plan-decisions.ts(실행 배치 검사에서 차단 선언 단위 제외·물화 필터),
//   revision-plan-decision-state.ts(검증 통과 뒤 마킹·평가), revision-start-options.ts(표시 행 변환).
// [수정시 주의] outcome 은 표시·감사 데이터이지 실행 권위가 아니다. 차단 단위의 도구 실행을 허용하거나
//   미해결 필수 결과를 완료로 바꾸는 경로를 이 모듈에서 만들지 않는다.
import type { Db } from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import { listWorkflowToolCatalog } from "../workflow/tool-catalog.js";
import { STEP_REF_TOKEN } from "./structural-materialization.js";
import { toolCapabilities, type RevisionPlanDeltaDiagnostic } from "./revision-plan-delta.js";
import { selectedUnitToolNames, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";
import { readUnitId } from "./revision-plan-declaration-targets.js";

/** 차단 단위의 구조화 결과 — 실제 toolNames 진단을 담고 표시/감사로만 소비된다. */
export type RevisionBlockedUnitOutcome = {
  readonly unitId: string;
  readonly label: string;
  readonly toolName: string | null;
  readonly code:
    | "workflow_tool_unavailable"
    | "workflow_tool_disabled"
    | "workflow_tool_not_granted_to_assignee"
    | "mission_revision_capability_gap"
    | "mission_revision_unit_declared_blocked";
  readonly message: string;
};

export type RevisionDeltaCapabilityRequirement = {
  readonly unitId: string;
  readonly requiredOutcomeId: string;
  readonly toolName: string;
  readonly capability: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitLabel(unit: Record<string, unknown>): string {
  for (const key of ["title", "name", "id"] as const) {
    const value = unit[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "(unnamed unit)";
}

function readAssigneeAgentId(unit: Record<string, unknown>): string | null {
  for (const key of ["assigneeAgentId", "agentId"] as const) {
    const value = unit[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** 결정의 revisionDelta 에서 blocked 로 선언된 단위 id 를 안전하게 읽는다(파싱 실패/미선언 → 빈 집합). */
export function readDeclaredBlockedRevisionUnitIds(decision: Record<string, unknown>): Set<string> {
  const raw = "revisionDelta" in decision ? decision.revisionDelta : undefined;
  if (!isPlainObject(raw)) return new Set();
  const parsed = missionRevisionDeltaSchema.safeParse(raw);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.units.filter(unit => unit.operation === "blocked").map(unit => unit.unitId));
}

/** 검증 통과한 변경안 원본에서 차단 범위(단위 집합 + 기능 요구)를 읽는다(파싱 실패 → null). */
export function parseRevisionDeltaBlockedScope(delta: Record<string, unknown>): {
  readonly blockedUnitIds: ReadonlySet<string>;
  readonly capabilityRequirements: readonly RevisionDeltaCapabilityRequirement[];
} | null {
  const parsed = missionRevisionDeltaSchema.safeParse(delta);
  if (!parsed.success) return null;
  return {
    blockedUnitIds: new Set(parsed.data.units.filter(unit => unit.operation === "blocked").map(unit => unit.unitId)),
    capabilityRequirements: parsed.data.capabilityRequirements ?? [],
  };
}

/** [실행 배치 검사 제외] 차단 선언 단위는 도구/권한 사전 거절 대신 구조화 결과가 도구 상태를 기록한다. */
export function withoutDeclaredBlockedRevisionUnits(
  units: readonly Record<string, unknown>[],
  decision: Record<string, unknown>,
): Record<string, unknown>[] {
  const blockedUnitIds = readDeclaredBlockedRevisionUnitIds(decision);
  if (blockedUnitIds.size === 0) return [...units];
  return units.filter(unit => {
    const unitId = readUnitId(unit);
    return unitId === null || !blockedUnitIds.has(unitId);
  });
}

function unitIdAliases(units: readonly Record<string, unknown>[]): Map<string, string> {
  const aliasToUnitId = new Map<string, string>();
  for (const unit of units) {
    const unitId = readUnitId(unit);
    if (!unitId) continue;
    aliasToUnitId.set(unitId, unitId);
    const sourceStepId = typeof unit.sourceStepId === "string" && unit.sourceStepId.trim() !== "" ? unit.sourceStepId : null;
    if (sourceStepId && !aliasToUnitId.has(sourceStepId)) aliasToUnitId.set(sourceStepId, unitId);
  }
  return aliasToUnitId;
}

function visitStepRefTokens(value: unknown, visit: (ref: string) => void): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_REF_TOKEN)) visit(match[1]!);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) visitStepRefTokens(item, visit); return; }
  if (isPlainObject(value)) { for (const key of Object.keys(value)) visitStepRefTokens(value[key], visit); }
}

// [참조 무결성] 차단 단위는 실행 그래프에서 제외되므로, 진행 단위가 의존/선택자/실행인자로 차단 단위를
//   참조하면 실행 시 반드시 실패한다. 조용히 끊지 않고 전체 계획을 구조화 거절한다(부분진행 남용 방지).
export function collectProceedingReferencesToBlockedUnits(
  units: readonly Record<string, unknown>[],
  blockedUnitIds: ReadonlySet<string>,
): RevisionPlanDeltaDiagnostic[] {
  const aliasToUnitId = unitIdAliases(units);
  const diagnostics: RevisionPlanDeltaDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (code: "mission_revision_blocked_unit_dependency" | "mission_revision_blocked_unit_selector", message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    diagnostics.push({ code, message, severity: "invalid" });
  };
  const isBlocked = (reference: string): boolean => {
    const producer = aliasToUnitId.get(reference) ?? reference;
    return blockedUnitIds.has(reference) || blockedUnitIds.has(producer);
  };
  for (const unit of units) {
    const unitId = readUnitId(unit);
    if (!unitId || blockedUnitIds.has(unitId)) continue;
    for (const dependency of Array.isArray(unit.dependencies) ? unit.dependencies : []) {
      if (typeof dependency === "string" && isBlocked(dependency)) {
        push("mission_revision_blocked_unit_dependency",
          `진행 단위 ${unitId} 이(가) 차단 단위 ${dependency} 에 의존합니다. 의존 단위도 blocked 로 선언하거나 계획을 다시 구성하세요.`);
      }
    }
    if (isPlainObject(unit.workProductSelectors)) {
      for (const key of Object.keys(unit.workProductSelectors)) {
        if (isBlocked(key)) {
          push("mission_revision_blocked_unit_selector",
            `진행 단위 ${unitId} 의 결과 선택자가 차단 단위 ${aliasToUnitId.get(key) ?? key} 를 참조합니다. 해당 연결을 제거하거나 소비 단위도 blocked 로 선언하세요.`);
        }
      }
    }
    visitStepRefTokens(unit.toolArgs, ref => {
      if (isBlocked(ref)) {
        push("mission_revision_blocked_unit_selector",
          `진행 단위 ${unitId} 의 실행 인자가 차단 단위 ${aliasToUnitId.get(ref) ?? ref} 의 결과를 참조합니다({$steps.${ref}.…}).`);
      }
    });
  }
  return diagnostics;
}

// [Q4 toolNames 결합] 차단 단위의 도구 상태를 '실제 사용하는 toolNames' 기준으로 평가한다. 등록·활성·권한
//   모두 충족해도 요청 capability 를 제공하지 않으면 기능 부족 결과로 남는다. 모든 진단 메시지는 해당
//   도구 이름을 정확히 지칭한다. 결과에 도구 문제가 하나도 없으면 선언 기반 차단으로 기록한다.
export async function assessRevisionBlockedUnitOutcomes(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly units: readonly Record<string, unknown>[];
  readonly blockedUnitIds: ReadonlySet<string>;
  readonly capabilityRequirements: readonly RevisionDeltaCapabilityRequirement[];
  readonly tools: readonly PlanningArtifactTool[];
}): Promise<RevisionBlockedUnitOutcome[]> {
  const blockedUnits = input.units.filter(unit => {
    const unitId = readUnitId(unit);
    return unitId !== null && input.blockedUnitIds.has(unitId);
  });
  if (blockedUnits.length === 0) return [];
  const catalog = await listWorkflowToolCatalog(input.db, input.companyId);
  const catalogToolByName = new Map<string, { enabled: boolean; unavailableReason?: string }>();
  for (const tool of catalog.tools) {
    catalogToolByName.set(tool.name, {
      enabled: tool.enabled,
      ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {}),
    });
  }
  const grantKeys = new Set(catalog.grants
    .filter(grant => typeof grant.agentId === "string" && grant.agentId.trim().length > 0)
    .map(grant => `${grant.agentId!.trim()}:${grant.toolName.trim()}`));
  const outcomes: RevisionBlockedUnitOutcome[] = [];
  for (const unit of blockedUnits) {
    const unitId = readUnitId(unit);
    if (unitId === null) continue;
    const label = readUnitLabel(unit);
    const assigneeAgentId = readAssigneeAgentId(unit);
    let assessed = false;
    for (const toolName of selectedUnitToolNames(unit)) {
      const catalogTool = catalogToolByName.get(toolName);
      if (catalogTool === undefined) {
        outcomes.push({ unitId, label, toolName, code: "workflow_tool_unavailable",
          message: `차단 단위 ${label} 의 실행 도구 ${toolName} 이(가) 이 회사에 등록되어 있지 않습니다. 요청한 필수 결과는 미해결로 남습니다.` });
        assessed = true;
        continue;
      }
      if (!catalogTool.enabled) {
        outcomes.push({ unitId, label, toolName, code: "workflow_tool_disabled",
          message: `차단 단위 ${label} 의 실행 도구 ${toolName} 이(가) 비활성 상태입니다${catalogTool.unavailableReason ? ` (${catalogTool.unavailableReason})` : ""}. 요청한 필수 결과는 미해결로 남습니다.` });
        assessed = true;
        continue;
      }
      if (assigneeAgentId === null || !grantKeys.has(`${assigneeAgentId}:${toolName}`)) {
        outcomes.push({ unitId, label, toolName, code: "workflow_tool_not_granted_to_assignee",
          message: `차단 단위 ${label} 의 담당자(${assigneeAgentId ?? "지정 없음"}) 에게 실행 도구 ${toolName} 이(가) 부여되지 않았습니다. 요청한 필수 결과는 미해결로 남습니다.` });
        assessed = true;
        continue;
      }
      for (const requirement of input.capabilityRequirements) {
        if (requirement.unitId !== unitId || requirement.toolName !== toolName) continue;
        const tool = input.tools.find(candidate => candidate.name === toolName);
        if (!toolCapabilities(tool).includes(requirement.capability)) {
          outcomes.push({ unitId, label, toolName, code: "mission_revision_capability_gap",
            message: `차단 단위 ${label} 의 필수 결과(${requirement.requiredOutcomeId}) 에 필요한 기능 ${requirement.capability} 을(를) 실행 도구 ${toolName} 이(가) 제공하지 않습니다. 요청한 필수 결과는 미해결로 남습니다.` });
          assessed = true;
        }
      }
    }
    if (!assessed) {
      outcomes.push({ unitId, label, toolName: null, code: "mission_revision_unit_declared_blocked",
        message: `단위 ${label} 은(는) 변경안에서 차단(blocked) 으로 선언되어 이 계획에서 실행되지 않습니다. 요청한 필수 결과는 미해결로 남습니다.` });
    }
  }
  return outcomes;
}
