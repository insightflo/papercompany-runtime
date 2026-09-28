import { buildQaReworkArtifactInstructionLine } from "../../work-products/artifact-registration-instructions.js";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";

export const WORKFLOW_REWORK_CONTRACT_KIND = "workflow_qa_rework";

/** [qa layer feedback loop] 재발 승격 계산 결과 — `findings` 는 유효(effective) 계층이 반영된 값. */
export type QaRecurrencePromotion = {
  readonly findings: readonly WorkflowVerdictFinding[];
  readonly promotedFindingIds: readonly string[];
};

/**
 * [qa layer feedback loop — 유효 계층 계산] 이번 세대 findings 중 직전 세대 findings 와 finding id 가
 *   완전 일치하는 항목은 재발로 판정해 라우팅상 source_data 로 승격한다(id 문자열 완전 일치만 —
 *   summary 유사도/프로즈 비교 금지, 규칙 8). 승격은 라우팅/표시 계산에만 쓰며 판정 이벤트 payload 의
 *   선언 계층은 불변이다(설계 §4.4). 순수 함수 — loop-driver 라우팅과 오너 카드 빌더 입력 직전에서
 *   동일 입력으로 호출되어 두 카드 생성 지점의 내용(requestHash)을 구조적으로 일치시킨다.
 */
export function applyRecurrencePromotion(
  current: readonly WorkflowVerdictFinding[] | null,
  prior: readonly WorkflowVerdictFinding[] | null,
): QaRecurrencePromotion {
  if (!current || current.length === 0 || !prior || prior.length === 0) {
    return { findings: current ?? [], promotedFindingIds: [] };
  }
  const priorIds = new Set(prior.map((finding) => finding.id));
  const promotedFindingIds: string[] = [];
  const findings = current.map((finding) => {
    if (finding.layer !== "source_data" && priorIds.has(finding.id)) {
      promotedFindingIds.push(finding.id);
      return { ...finding, layer: "source_data" as const };
    }
    return finding;
  });
  return { findings, promotedFindingIds };
}

/**
 * findings 병기 태그 — 유효 계층이 source_data 인 항목을 생산자 재작업 계약 feedback 에 구조적으로
 *   병기한다(표시 전용). 재발 승격 항목(promotedFindingIds)은 '생산자 범위 밖(재발 승격)' 태그로
 *   구분해 렌더한다. 재발이 없으면 기존 포맷과 바이트 단위로 동일하다(회귀 불변).
 */
export function renderSourceScopeTag(
  findings: readonly WorkflowVerdictFinding[],
  promotedFindingIds: ReadonlySet<string> = new Set(),
): string {
  const declaredLines = findings
    .filter((finding) => finding.layer === "source_data" && !promotedFindingIds.has(finding.id))
    .map((finding) => `- (${finding.id}) ${finding.summary}`);
  const promotedLines = findings
    .filter((finding) => promotedFindingIds.has(finding.id))
    .map((finding) => `- (${finding.id}) ${finding.summary}`);
  return [
    ...(declaredLines.length > 0
      ? ["#### [생산자 범위 밖 — 원천 데이터 결함] 아래 항목은 원천(수집) 산출물 결함으로 생산자가 고칠 수 없습니다. 원천 라우팅 대상입니다:", ...declaredLines]
      : []),
    ...(promotedLines.length > 0
      ? ["#### [생산자 범위 밖(재발 승격)] 아래 항목은 직전 반려와 같은 finding id 로 재발했습니다(재작업 후에도 해소되지 않음) — 원천 데이터 결함으로 승격되어 생산자가 고칠 수 없습니다. 원천 라우팅 대상입니다:", ...promotedLines]
      : []),
  ].join("\n");
}

export type QaReworkFeedback = {
  readonly qaStepId: string;
  readonly qaIssueId: string | null;
  readonly feedback: string | null;
};
export type ProducerWorkProductRef = {
  readonly title: string;
  readonly ref: string;
};

export type WorkflowReworkContract = {
  readonly kind: typeof WORKFLOW_REWORK_CONTRACT_KIND;
  readonly producerStepId: string;
  readonly currentIteration: number;
  readonly maxIterations: number;
  readonly iterationLabel: string;
  readonly qaFeedbacks: readonly QaReworkFeedback[];
  readonly dependencyArtifacts: string | null;
  readonly producerIssueInstruction: string | null;
  readonly producerWorkProducts: readonly ProducerWorkProductRef[];
  readonly requiredActions: readonly string[];
  readonly createdAt: string;
};

export function buildWorkflowReworkContract(input: {
  readonly producerStepId: string;
  readonly qaFeedbacks: readonly QaReworkFeedback[];
  readonly currentIteration: number;
  readonly maxIterations: number;
  readonly dependencyArtifacts?: string | null;
  readonly producerIssueInstruction?: string | null;
  readonly producerWorkProducts?: readonly ProducerWorkProductRef[];
  readonly createdAt?: Date;
}): WorkflowReworkContract {
  const nextIteration = input.currentIteration + 1;
  return {
    kind: WORKFLOW_REWORK_CONTRACT_KIND,
    producerStepId: input.producerStepId,
    currentIteration: input.currentIteration,
    maxIterations: input.maxIterations,
    iterationLabel: `${nextIteration}/${input.maxIterations}`,
    qaFeedbacks: input.qaFeedbacks.map((feedback) => ({ ...feedback })),
    dependencyArtifacts: input.dependencyArtifacts ?? null,
    producerIssueInstruction: input.producerIssueInstruction ?? null,
    producerWorkProducts: (input.producerWorkProducts ?? []).map((wp) => ({ ...wp })),
    requiredActions: [
      "Treat this rework contract as the primary instruction for the current run.",
      // [surgical revision] 외과수술적 수정 지시 — 브리프 렌더 제약(requiredActions 첫 4개, 컴팩트 헤더 3개,
      //   항목당 260자) 안에 전문이 들어가도록 index 1 + 길이 제한 유지. 어휘는 도메인 중립(work products/
      //   derived values) — 특정 산출물 유형(문서·코드·데이터)을 전제하지 않는다(엔진은 전 워크플로 공통).
      "Revise surgically: edit your prior registered work products in place; change only what the QA feedback flags plus parts that directly depend on it (derived values, aggregates, indexes, references); keep unaffected parts unchanged — do not rebuild from scratch.",
      "Do not close as already complete unless the requested changes are reflected in the deliverable.",
      "If the corrected artifact already exists, verify it satisfies the feedback and register that artifact.",
    ],
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function readWorkflowReworkContract(value: unknown): WorkflowReworkContract | null {
  const record = readRecord(value);
  if (record?.kind !== WORKFLOW_REWORK_CONTRACT_KIND) return null;
  const producerStepId = readString(record.producerStepId);
  const currentIteration = readNumber(record.currentIteration);
  const maxIterations = readNumber(record.maxIterations);
  const iterationLabel = readString(record.iterationLabel);
  if (!producerStepId || !iterationLabel) return null;
  const qaFeedbacks = Array.isArray(record.qaFeedbacks)
    ? record.qaFeedbacks.map(readQaFeedback).filter((entry): entry is QaReworkFeedback => entry !== null)
    : [];
  return {
    kind: WORKFLOW_REWORK_CONTRACT_KIND,
    producerStepId,
    currentIteration,
    maxIterations,
    iterationLabel,
    qaFeedbacks,
    dependencyArtifacts: readString(record.dependencyArtifacts),
    producerIssueInstruction: readString(record.producerIssueInstruction),
    producerWorkProducts: readWorkProductRefs(record.producerWorkProducts),
    requiredActions: readStringArray(record.requiredActions),
    createdAt: readString(record.createdAt) ?? new Date(0).toISOString(),
  };
}

export function renderWorkflowReworkComment(contract: WorkflowReworkContract): string {
  const multi = contract.qaFeedbacks.length > 1;
  const qaList = contract.qaFeedbacks
    .map((feedback) => `- QA step \`${feedback.qaStepId}\` (issue ${feedback.qaIssueId ?? "unknown"}) requested changes`)
    .join("\n");
  const feedbackSections = contract.qaFeedbacks
    .map((feedback, index) => {
      const sectionHeader = multi ? `\n#### QA feedback ${index + 1}: \`${feedback.qaStepId}\`` : "";
      const body = feedback.feedback
        ?? "No QA feedback comment was found on the validator issue. Inspect the validator issue before proceeding.";
      return `${sectionHeader}${sectionHeader ? "\n" : ""}${body}`;
    })
    .join("\n");
  const instructionSection = contract.producerIssueInstruction
    ? `### Original producer issue instruction (the task this step implements):\n${contract.producerIssueInstruction}`
    : null;
  const ownProductsSection = contract.producerWorkProducts.length > 0
    ? [
        "### Prior work products registered on this issue (verify they satisfy the feedback, update or re-register)",
        ...contract.producerWorkProducts.map((wp) => `- ${wp.title} → ${wp.ref}`),
      ].join("\n")
    : null;
  // [surgical revision] 전문 지침 — 잘된 부분은 그대로 두고 지적된 부분(+직접 영향 부분)만 고친다.
  //   comment 는 절단 없이 전문이 보이므로 상세 규칙을 여기에 둔다(requiredActions 는 브리프 요약).
  //   도메인 중립 어휘 사용 — 문서(요약/목차)든 코드(계산값/참조)든 데이터든 동일 원칙이 적용된다.
  const surgicalSection = [
    "### How to apply this rework (surgical revision)",
    "- Start from your prior registered work products above: load the current output and edit it in place — do not regenerate the work product from scratch.",
    "- Change only what the QA feedback flags, plus anything that directly depends on the changed part (for example: derived values, aggregates, summaries, indexes, or references computed from it).",
    "- Keep unaffected parts exactly as they are — do not rephrase, restructure, or refresh anything the feedback did not flag.",
    "- A wholesale rewrite that discards accepted work is itself a rework failure, even if the flagged items are fixed.",
  ].join("\n");
  return [
    "## Workflow QA rework request",
    "",
    `Producer step \`${contract.producerStepId}\` was reset for rework because the following QA validator(s) requested changes.`,
    qaList,
    `- Rework iteration: ${contract.iterationLabel}`,
    instructionSection,
    ownProductsSection,
    surgicalSection,
    buildQaReworkArtifactInstructionLine({ feedbackScope: multi ? "ALL listed QA feedback above" : "the QA feedback" }),
    ...contract.requiredActions.map((action) => `- ${action}`),
    contract.dependencyArtifacts,
    "",
    feedbackSections,
  ].filter((line): line is string => line !== null).join("\n");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readQaFeedback(value: unknown): QaReworkFeedback | null {
  const record = readRecord(value);
  if (!record) return null;
  const qaStepId = readString(record.qaStepId);
  if (!qaStepId) return null;
  return {
    qaStepId,
    qaIssueId: readString(record.qaIssueId),
    feedback: readString(record.feedback),
  };
}

function readWorkProductRefs(value: unknown): readonly ProducerWorkProductRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ProducerWorkProductRef | null => {
      const record = readRecord(entry);
      if (!record) return null;
      const title = readString(record.title);
      const ref = readString(record.ref);
      if (!title || !ref) return null;
      return { title, ref };
    })
    .filter((entry): entry is ProducerWorkProductRef => entry !== null);
}
