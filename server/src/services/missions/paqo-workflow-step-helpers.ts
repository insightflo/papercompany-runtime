// server/src/services/missions/paqo-workflow-step-helpers.ts
//
// [파일 목적] PAQO 실행 단계 생성기(paqo-workflow-steps.ts)가 쓰는 순수 판독/파생 헬퍼를
//   mission-owner-plan-decisions.ts 로부터 1:1 추출했다(대형 파일 축소, 행동 불변).
//   여기서 정규화 규칙을 바꾸지 않는다 — 판독 원형은 원본 그대로다.
import { createHash } from "node:crypto";
import { stableStringify } from "../issue-execution-cards/hash.js";
import { normalizeWorkflowStepMachineChecks } from "../workflow/step-contract.js";
import { remapCanonicalDependenciesToStepIds } from "./mission-plan-dependency-graph.js";
import { STEP_MACHINE_CHECKS_TOOL } from "../workflow/step-machine-checks.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";

export type PaqoIssueGroup = "action" | "qa" | "oversight";

export function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readOptionalBooleanMarker(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

export function stripIssueGroupPrefix(title: string): string {
  return title.replace(/^\s*\[(?:plan|action|qa|oversight)\]\s*/iu, "").trim();
}

export function inferPaqoIssueGroup(unit: Record<string, unknown>): PaqoIssueGroup {
  const role = classifyWorkflowStepRole(unit);
  return role === "unknown" ? "action" : role as PaqoIssueGroup;
}

export function readPaqoGraphWorkProductRequired(unit: Record<string, unknown>, group: PaqoIssueGroup): boolean {
  return readOptionalBooleanMarker(unit.graphWorkProductRequired)
    ?? readOptionalBooleanMarker(unit.workProductRequired)
    ?? readOptionalBooleanMarker(unit.requiresWorkProduct)
    ?? (group === "action");
}

export function shortStableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 10);
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toNonEmptyString(entry)).filter((entry): entry is string => Boolean(entry));
}

export function readSelectedUnitWorkflowToolNames(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    toNonEmptyString(unit.toolName),
  ].filter((value): value is string => Boolean(value))));
}

export function readSelectedUnitWorkflowToolArgs(unit: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(unit, "toolArgs")) return unit.toolArgs;
  if (Object.prototype.hasOwnProperty.call(unit, "toolArguments")) return unit.toolArguments;
  return undefined;
}

export function readSelectedUnitKnowledgeBaseIds(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.knowledgeBaseIds),
    ...readStringArray(unit.kbIds),
    ...readStringArray(unit.kbRefs),
  ]));
}

export function readSelectedUnitSkillRefs(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.skillRefs),
    ...readStringArray(unit.skillKeys),
    ...readStringArray(unit.skills),
  ]));
}

export function buildUnitStepIdMap(
  selectedUnits: Record<string, unknown>[],
  steps: WorkflowStep[],
): Map<string, string> {
  return new Map(selectedUnits.map((unit, index) => [toNonEmptyString(unit.id)!, steps[index]!.id]));
}

/** [수정 재사용] 복사 A 스텝은 dependencies(및 조건부 성공 연결)를 원문 그대로 보존한다 —
 *  단위 좌표 재작성은 B 에만 적용한다. 복사 A 의 단위 id 는 스텝 id 와 같으므로 건너뛰어도 안전하다. */
export function applyCanonicalDependencies(
  selectedUnits: Record<string, unknown>[],
  steps: WorkflowStep[],
  copiedStepIds?: ReadonlySet<string>,
): WorkflowStep[] {
  const dependencyStepIds = remapCanonicalDependenciesToStepIds(
    selectedUnits,
    steps.map((step) => step.id),
  );
  return steps.map((step, index) => copiedStepIds?.has(step.id)
    ? step
    : { ...step, dependencies: dependencyStepIds[index]! });
}

/**
 * [machine-check gates] contract.machineChecks 를 선언한 생산자 스텝 뒤에 결정론적
 * 검증 gate 스텝을 물리화한다. gate 는 이슈 없는 structural tool 스텝(예약 toolName,
 * agentId 없음)으로, dag-engine 이 registry 없이 in-process 실행한다.
 *
 * 의존 리와이어링은 항상 가산(additive): P 의 모든 직계 의존자는 P 를 유지하고 gate M 를
 * 추가로 기다린다. 이유 — (1) structural topology 규칙상 gate 에 의존하는 QA-like 스텝은
 * 생산자도 함께 의존해야 하고, (2) 소비자 toolArgs 의 {$steps.P.…} 참조는 P 가 조상으로
 * 남아야 resolveWorkflowToolStepArgs 가 통과한다. M 실패 시 완료되지 않으므로 하류는
 * DAG 의존으로 자연 차단된다.
 */
export function insertStepMachineCheckGates(steps: WorkflowStep[], copiedStepIds?: ReadonlySet<string>): WorkflowStep[] {
  const checksByProducerId = new Map<string, NonNullable<ReturnType<typeof normalizeWorkflowStepMachineChecks>>>();
  for (const step of steps) {
    const checks = normalizeWorkflowStepMachineChecks(
      (step.contract as { machineChecks?: unknown } | undefined)?.machineChecks,
    );
    if (checks) checksByProducerId.set(step.id, checks);
  }
  if (checksByProducerId.size === 0) return steps;

  const out: WorkflowStep[] = [];
  for (const step of steps) {
    out.push(step);
    const checks = checksByProducerId.get(step.id);
    if (!checks) continue;
    out.push({
      id: `${step.id}-mc`,
      name: `[GATE] ${step.name} machine checks`,
      agentId: "",
      dependencies: [step.id],
      graphWorkProductRequired: false,
      type: "tool",
      qaType: "structural",
      toolNames: [STEP_MACHINE_CHECKS_TOOL],
      toolArgs: {
        producerStepId: step.id,
        machineChecks: checks,
      },
      description: [
        `Deterministic machine-check gate for producer "${step.name}".`,
        "Runs the producer's declared machineChecks (file existence / glob / size / sha256) in-process with no LLM.",
        "A failed predicate fails this gate step (existing retry machinery applies); downstream steps wait on it via DAG dependencies.",
      ].join("\n"),
    });
  }

  const gateIdByProducerId = new Map(Array.from(checksByProducerId.keys(), (id) => [id, `${id}-mc`]));
  const gateIds = new Set(gateIdByProducerId.values());
  return out.map((step) => {
    // [수정 재사용] 게이트 의존 추가 재배선은 B 만 — 복사 A 의 의존성은 원문 그대로 둔다.
    if (gateIds.has(step.id) || copiedStepIds?.has(step.id)) return step;
    const addedGates = step.dependencies
      .filter((dependencyId) => gateIdByProducerId.has(dependencyId))
      .map((dependencyId) => gateIdByProducerId.get(dependencyId)!);
    return addedGates.length > 0 ? { ...step, dependencies: [...step.dependencies, ...addedGates] } : step;
  });
}
