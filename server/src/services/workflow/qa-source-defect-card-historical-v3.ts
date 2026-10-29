// Frozen v3 card identity builder. This code reproduces baseline 208ceb36 only for matching
// already-persisted decisions; it is never used to route or execute current findings.
import { createHash } from "node:crypto";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import type { SystemLanguage } from "../missions/system-language.js";

const QA_SOURCE_DEFECT_CARD_SOURCE_TYPE = "workflow_qa_rejection";
const QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION = 3;
const QA_SOURCE_DEFECT_CARD_HASH_REPLACEMENT_REQUEST_KEY_LIMIT = 160;

function truncateText(value: string, limit: number): string {
  const splitsPair = value.charCodeAt(limit - 1) >= 0xd800 && value.charCodeAt(limit - 1) <= 0xdbff
    && value.charCodeAt(limit) >= 0xdc00 && value.charCodeAt(limit) <= 0xdfff;
  return value.slice(0, splitsPair ? limit - 1 : limit);
}

export function buildHistoricalV3RequestKey(input: {
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
}): string {
  const prefix = `qa-source-defect:v${QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION}:${input.workflowRunId}:`;
  const readable = `${prefix}${input.producerStepId}:${input.iteration}`;
  return readable.length <= QA_SOURCE_DEFECT_CARD_HASH_REPLACEMENT_REQUEST_KEY_LIMIT ? readable
    : `qa-source-defect-sha256:v${QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION}:${input.workflowRunId}:${createHash("sha256").update(input.producerStepId).digest("hex")}:${input.iteration}`;
}

function buildQaSourceDefectCardRequestKey(input: {
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
}): string {
  return buildHistoricalV3RequestKey(input);
}

export const QA_SOURCE_DEFECT_CARD_OPTION_IDS = [
  "rerun_source_collection",
  "extra_producer_rework",
  "maintenance_issue",
  "replan_mission",
  "cancel",
] as const;
export type QaSourceDefectCardOptionId = (typeof QA_SOURCE_DEFECT_CARD_OPTION_IDS)[number];
export interface QaSourceDefectCardQaRef {
  readonly qaStepId: string;
  readonly qaIssueId: string | null;
}

/** Frozen v3 payload builder; callers use it only to reconstruct a historical full hash. */
export function buildHistoricalV3QaSourceDefectCard(input: {
  readonly language: SystemLanguage;
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly findings: readonly WorkflowVerdictFinding[];
  readonly qaRefs: readonly QaSourceDefectCardQaRef[];
  readonly missionId: string | null;
  readonly linkIssueId: string | null;
  /** [qa layer feedback loop] 재발 승격된 finding id — 표시 마커([source_data*])/팩트 렌더에만 쓴다. */
  readonly promotedFindingIds?: readonly string[];
}) {
  const text = (en: string, ko: string) => input.language === "ko" ? ko : en;
  const promotedIds = new Set(input.promotedFindingIds ?? []);
  const findingsSorted = [...input.findings].sort((left, right) => left.id.localeCompare(right.id));
  const qaRefsSorted = [...input.qaRefs].sort((left, right) => left.qaStepId.localeCompare(right.qaStepId));
  const layerBadge = (finding: WorkflowVerdictFinding) => `${finding.layer}${promotedIds.has(finding.id) ? "*" : ""}`;
  const findingsLines = findingsSorted.map((finding) => `- [${layerBadge(finding)}] (${finding.id}) ${finding.summary}`);
  const promotedCount = findingsSorted.filter((finding) => promotedIds.has(finding.id)).length;
  const sourceOnly = findingsSorted.every((finding) => finding.layer === "source_data");
  const qaList = qaRefsSorted
    .map((ref) => `- QA step \`${ref.qaStepId}\`${ref.qaIssueId ? ` (issue ${ref.qaIssueId})` : ""}`)
    .join("\n");

  const layerFact = {
    label: text("Scope of rejection", "반려 사유 범위"),
    value: truncateText([
      findingsSorted.length === 0 ? text("Not submitted (legacy review)", "제출 없음(구버전 판정)")
        : sourceOnly ? text("All findings concern source data (collection stage)", "전부 원천 데이터(수집 단계) 문제")
          : findingsSorted.some((finding) => finding.layer === "source_data") ? text("Mixed: source data + output problems", "혼합: 원천 데이터 + 산출물 문제")
            : text("All findings concern output problems (production stage)", "전부 산출물(생산 단계) 문제"),
      ...(promotedCount > 0 ? [text(`${promotedCount} recurring finding (repeated from the previous rejection)`, `같은 사유 재발 ${promotedCount}건(직전 반려에서 반복)`)] : []),
    ].join(" — "), 200),
    status: "known" as const,
  };
  const iterationFact = {
    label: text("Rework attempts", "재작업 횟수"),
    value: truncateText(text(`Used ${input.iteration}/${input.maxIterations}`, `사용 ${input.iteration}/${input.maxIterations}회`)
      .concat(findingsSorted.length > 0 && sourceOnly ? text(" — source data defects do not use rework attempts", " — 원천 데이터 결함은 재작업 횟수를 소모하지 않음") : ""), 200),
    status: "known" as const,
  };
  const commonFacts = [layerFact, iterationFact];
  // [선택지 반복 링크 제거] 연관 업무 링크는 카드 헤더의 "연관 업무 열기" 버튼과 판단 근거에서 이미 보여준다.
  // 과거 각 선택지 아래에 같은 "품질검수 반려 업무" 링크가 반복 표시되어 공간만 차지했다(2026-10-20 운영자 요청으로 제거).
  const option = (
    id: QaSourceDefectCardOptionId,
    label: string,
    description: string,
    recommendation?: { readonly reason: string },
  ) => ({
    id,
    label,
    description,
    // [요청자 추천] 검증기가 정의당 최대 1개 옵션만 허용한다. 추천은 표시일 뿐 선택을 강제하지 않는다.
    ...(recommendation ? { recommended: true as const, recommendationReason: recommendation.reason } : {}),
    facts: [
      ...commonFacts,
      ...findingsSorted.slice(0, 8).map((finding) => ({
        label: truncateText(text(`Finding ${finding.id}`, `결함 ${finding.id}`), 80),
        value: truncateText(`[${layerBadge(finding)}] ${finding.summary}`, 200),
        status: "known" as const,
      })),
    ],
    evidenceRefs: [],
  });

  // [요청자 추천] humanReview.recommendedNextStep와 같은 판단을 선택지 배지(추천)로도 표시한다.
  const rerunRecommendation = findingsSorted.length > 0 && sourceOnly
    ? { reason: text("Producer rework cannot fix source data defects; re-running collection replaces the flawed source material.", "생산자 재작업으로는 원천 데이터 결함을 고칠 수 없습니다. 수집을 다시 실행해야 결함 있는 원천 자료가 교체됩니다.") }
    : undefined;
  const reworkRecommendation = findingsSorted.length > 0 && !sourceOnly
    ? { reason: text("The defect is in the produced output; the producer can fix it through rework. If rework cannot solve it, consider replanning the mission.", "결함이 산출물 자체에 있어 생산자가 재작업으로 고칠 수 있습니다. 재작업으로 해결이 어렵다면 미션 재계획을 검토하세요.") }
    : undefined;

  const definition = {
    options: [
      option("rerun_source_collection", text("Run data collection again", "자료 수집 다시 실행"), text(
        "Choose this when the collected source material appears to be the cause. Ask the collection task to run again, replace the source material, and let the following work continue. Internal command: `retry_source_issue`.",
        "자료를 모으는 단계의 결과가 문제의 원인으로 보일 때 고르세요. 수집 단계 업무를 다시 실행해 원천 자료를 새로 만들고 이어지는 작업이 계속되도록 지시합니다. 내부 명령: `retry_source_issue`."),
        rerunRecommendation),
      option("extra_producer_rework", text("Allow one more producer rework", "생산자 재작업 1회 더 허용"), text(
        `Choose this when the output itself needs fixing. Allow the agent that creates it one more rework attempt, then request rework of its task. Used ${input.iteration}/${input.maxIterations}. Internal command: \`qaReworkCapBoost\` (+1), then \`retry_source_issue\`.`,
        `산출물(생산 단계의 결과물) 자체를 고쳐야 할 때 고르세요. 생산자(산출물을 만드는 에이전트)의 재작업을 1회 더 허용한 뒤 해당 업무의 재작업을 지시합니다. 현재 사용 ${input.iteration}/${input.maxIterations}회. 내부 명령: \`qaReworkCapBoost\`(+1), 이후 \`retry_source_issue\`.`),
        reworkRecommendation),
      option("maintenance_issue", text("Hand off to maintenance", "유지보수 업무로 넘기기"), text(
        "Choose this when code, agent skills, or the collection process may be the underlying cause. Create a maintenance task with the submitted findings as evidence.",
        "코드, 에이전트 스킬, 자료 수집 과정 자체에 문제가 있다고 의심될 때 고르세요. 제출된 결함 항목을 근거로 유지보수 업무를 만듭니다.")),
      option("replan_mission", text("Replan the mission", "미션 재계획"), text(
        "Choose this when the current approach cannot achieve the goal. Ask the mission owner to revise the plan. Internal command: `replan_mission`.",
        "현재 방식으로 목표를 달성하기 어렵다고 판단될 때 고르세요. 미션 책임자에게 계획을 다시 세우도록 요청합니다. 내부 명령: `replan_mission`.")),
      option("cancel", text("Close without action", "조치 없이 닫기"), text(
        "Choose this when no action should be requested through this card. Close the card; the workflow stays in its current failed or waiting state.",
        "이 카드로 조치를 요청하지 않으려면 고르세요. 카드만 닫고 작업 흐름은 현재 실패 또는 대기 상태로 유지합니다.")),
    ],
    actions: [
      { id: "submit", label: text("Submit decision", "결정 제출"), outcome: "submit" as const, tone: "primary" as const, requiresSelection: true },
      { id: "dismiss", label: text("Close card", "카드 닫기"), outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
    ],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional" as const, label: text("Note", "메모"), placeholder: text("Explain your decision or leave instructions for the mission owner agent", "결정 이유나 미션 책임자 에이전트에게 전할 지시를 적어 주세요"), maxLength: 2000 },
    approvedScope: ["operator_decision.resolve"],
    forbiddenScope: ["auto_retry", "producer_auto_rework"],
    humanReview: {
      schemaVersion: "human-review-v1" as const,
      decisionSubject: text("Choose how to handle the results that did not pass quality review", "품질검수를 통과하지 못한 결과물의 처리 방침을 정해 주세요"),
      evidence: [
        {
          label: text("Structured quality review findings", "품질검수(QA)가 제출한 결함 항목(findings)"),
          href: `/issues/${qaRefsSorted.find((ref) => ref.qaIssueId)?.qaIssueId ?? input.producerStepId}`,
          location: text(`Workflow run ${input.workflowRunId} / producer ${input.producerStepId}`, `작업 흐름 실행 ${input.workflowRunId} / 생산자 ${input.producerStepId}`),
          description: truncateText(findingsLines.join("\n") || text("No findings submitted (legacy review — rework limit reached)", "결함 항목 제출 없음(구버전 판정 — 재작업 한도 도달)"), 1000),
        },
      ],
      interpretation: truncateText([
        findingsSorted.length === 0 ? text("Quality review (QA) findings were not submitted (legacy review).", "품질검수(QA)의 결함 항목(findings)이 제출되지 않았습니다(구버전 판정).")
          : text("Quality review (QA) submitted a structured 'changes needed' verdict with findings.", "품질검수(QA) 단계가 '수정 필요' 판정을 구조화된 형식(findings)으로 제출했습니다."),
        findingsSorted.length === 0 ? text("The defect scope is unknown. Inspect the quality review task and related evidence to determine whether the problem concerns source data or output before choosing an action.", "결함 범위는 확인되지 않았습니다. 처리 방침을 선택하기 전에 품질검수 업무와 관련 증거를 살펴 원천 데이터 문제인지 산출물 문제인지 확인해 주세요.") : sourceOnly ? text(
          "All rejection reasons concern source data: the original material from the collection stage. Rebuilding the output cannot fix it, so human judgment is requested instead of automatic producer rework.",
          "반려 사유 전부가 원천 데이터(수집 단계가 만든 원본 자료) 문제입니다. 생산자가 다시 만들어도 고쳐지지 않는 문제라 자동 재작업 대신 사람 판단을 요청합니다.") : text(
          "The rejection includes problems with the produced output, or uses a legacy verdict. Human judgment is requested alongside the existing rework process.",
          "반려 사유에 산출물(생산 단계의 결과물) 자체의 문제가 포함되어 있습니다(또는 구버전 판정). 기존 재작업 절차와 함께 사람 판단을 요청합니다."),
        "", text("Findings:", "결함 항목:"),
        ...(findingsLines.length > 0 ? findingsLines : [text("- (no findings submitted)", "- (결함 항목 제출 없음)")]),
        "", `${text("Rejecting QA:", "반려 품질검수:")} ${qaList || text("(unknown)", "(알 수 없음)")}`,
      ].join("\n"), 4000),
      impact: {
        ifApproved: text("The mission owner agent uses the existing execution APIs to request your selected action: recollection, rework, maintenance, or replanning.", "미션 책임자 에이전트가 선택한 조치를 기존 실행 API(시스템에 실행을 요청하는 창구)로 진행합니다: 자료 재수집, 재작업 허용, 유지보수 이관, 재계획."),
        ifRejected: text("Closing the card leaves the workflow in its current state. No automatic retry occurs.", "카드를 닫으면 작업 흐름은 현재 상태로 유지되며 자동 재시도는 일어나지 않습니다."),
        ifWrong: text("Recollecting valid source data wastes work. Recollecting without fixing a defective output can lead to the same rejection again.", "원천 자료가 정상인데 다시 수집하면 작업을 낭비합니다. 산출물 문제를 고치지 않고 수집만 다시 하면 같은 반려가 반복될 수 있습니다."),
      },
      unresolvedFacts: findingsSorted.length === 0 ? [text("QA submitted no findings. Only the exhausted rework limit is known; the defect scope is unknown.", "품질검수가 결함 항목을 제출하지 않았습니다. 재작업 한도에 도달한 사실만 알 수 있고 결함 범위는 확인되지 않았습니다.")] : [],
      questions: findingsSorted.length === 0 ? [text("Can you inspect the quality review task and related evidence to confirm the defect scope before choosing an action?", "처리 방침을 선택하기 전에 품질검수 업무와 관련 증거를 살펴 결함 범위를 확인할 수 있을까요?")] : sourceOnly ? [text("Would collecting the source material again fix the problem, or does the underlying cause need maintenance?", "자료를 다시 수집하면 해결될까요, 아니면 근본 원인을 고치는 유지보수 업무가 필요할까요?")]
        : [text("Can the producer fix the output through rework?", "생산자가 산출물을 다시 만들면 이 문제를 해결할 수 있을까요?")],
      recommendedNextStep: findingsSorted.length === 0 ? text("First inspect the quality review task and related evidence to confirm the defect scope, then choose an action.", "먼저 품질검수 업무와 관련 증거를 살펴 결함 범위를 확인한 뒤 처리 방침을 선택해 주세요.") : sourceOnly ? text("Run data collection again (rerun_source_collection) is recommended: producer rework cannot fix source data defects.", "자료 수집 다시 실행(rerun_source_collection)을 권장합니다. 생산자 재작업으로는 원천 데이터 결함을 고칠 수 없습니다.")
        : text("Consider Allow one more producer rework (extra_producer_rework) or Replan the mission (replan_mission).", "생산자 재작업 1회 더 허용(extra_producer_rework) 또는 미션 재계획(replan_mission)을 검토해 주세요."),
      requiredReviewer: "human-operator",
    },
  };

  return {
    schemaVersion: 1 as const,
    requestKey: buildQaSourceDefectCardRequestKey({
      workflowRunId: input.workflowRunId,
      producerStepId: input.producerStepId,
      iteration: input.iteration,
    }),
    priority: "high" as const,
    interactionType: "single_select" as const,
    title: truncateText(text(
      `Quality review (QA) rejected — ${sourceOnly ? "source data" : findingsSorted.some((finding) => finding.layer === "source_data") ? "source data + output" : "output"} defects, choose next steps (${input.producerStepId} · rework ${input.iteration}/${input.maxIterations})`,
      `품질검수(QA) 반려 — ${sourceOnly ? "원천 데이터" : findingsSorted.some((finding) => finding.layer === "source_data") ? "원천 데이터 + 산출물" : "산출물"} 결함, 처리 방침 선택 필요 (${input.producerStepId} · 재작업 ${input.iteration}/${input.maxIterations}회)`), 200),
    description: truncateText([
      text("## Quality review (QA) rejected — choose how to proceed", "## 품질검수(QA) 반려 — 처리 방침을 선택해 주세요"), "",
      text(`Producer: step \`${input.producerStepId}\` (rework ${input.iteration}/${input.maxIterations})`, `생산자(산출물을 만드는 에이전트): 단계 \`${input.producerStepId}\` (재작업 ${input.iteration}/${input.maxIterations}회)`),
      text(`Workflow run: ${input.workflowRunId}`, `작업 흐름 실행: ${input.workflowRunId}`), "",
      text("Quality review requested changes. Choose an action based on the submitted defect findings.", "품질검수가 수정을 요청했습니다. 제출된 결함 항목(findings)을 보고 처리 방침을 선택해 주세요."), "",
      text("Findings:", "결함 항목:"),
      ...(findingsLines.length > 0 ? findingsLines : [text("- (no findings submitted — rework limit reached)", "- (결함 항목 제출 없음 — 재작업 한도 도달)")]),
      "", text("Rejecting QA:", "반려 품질검수:"), qaList || text("- (unknown)", "- (알 수 없음)"), "",
      text("### What happens after your decision", "### 선택 후 진행 방법"),
      text("Resolving this card notifies the agent assigned to the linked task (the mission owner). That agent uses the existing execution APIs to act on your selection:", "결정을 제출하면 연결된 업무를 맡은 미션 책임자 에이전트에게 알립니다. 이 에이전트가 선택한 조치를 기존 실행 API로 요청합니다:"),
      text("- Run data collection again → retry the collection task. Internal command: `retry_source_issue` (collection task).", "- 자료 수집 다시 실행 → 수집 단계 업무 재시도. 내부 명령: `retry_source_issue`(수집 업무 대상)."),
      text("- Allow one more producer rework → add one attempt, then retry the producer task. Internal commands: `qaReworkCapBoost` (+1), then `retry_source_issue` (producer task).", "- 생산자 재작업 1회 더 허용 → 한도를 1회 늘린 뒤 생산자 업무 재시도. 내부 명령: `qaReworkCapBoost`(+1), 이후 `retry_source_issue`(생산자 업무 대상)."),
      text("- Hand off to maintenance → create a maintenance task with the submitted findings as evidence.", "- 유지보수 업무로 넘기기 → 제출된 결함 항목을 근거로 유지보수 업무 생성."),
      text("- Replan the mission → revise the plan. Internal command: `replan_mission`.", "- 미션 재계획 → 계획 다시 세우기. 내부 명령: `replan_mission`."),
      text("Comments and markers are display-only and cannot authorize execution.", "댓글과 표시 문구는 안내용일 뿐 실행 권한을 줄 수 없습니다."),
    ].join("\n"), 4000),
    sourceType: QA_SOURCE_DEFECT_CARD_SOURCE_TYPE,
    sourceId: truncateText(`${input.workflowRunId}:${input.producerStepId}:${input.iteration}`, 200),
    sourceContext: {
      missionId: input.missionId,
      workflowId: null,
      workflowRunId: input.workflowRunId,
      artifactRefs: [],
    },
    definition,
    issueId: input.linkIssueId,
    // [continuation chain] 해결 시 기존 continuation worker 가 linkIssueId assignee(owner agent)를
    //   wake 한다. 새 실행 경로 없음(규칙 7).
    continuationMode: input.linkIssueId ? ("issue_current_assignee" as const) : ("none" as const),
  };
}


export type HistoricalQaSourceDefectCardIdentityInput = Omit<
  Parameters<typeof buildHistoricalV3QaSourceDefectCard>[0], "language" | "promotedFindingIds"
>;

/**
 * These are the only two historically possible shapes: lookup did not find prior structured
 * findings, or it found the same IDs and the old builder promoted those findings for display.
 * They are hash candidates only and must never flow into execution decisions.
 */
export function buildHistoricalV3InputVariants(
  input: HistoricalQaSourceDefectCardIdentityInput,
  recurringFindingIds: readonly string[],
) {
  const recurring = new Set(recurringFindingIds);
  const matched = new Set(input.findings.filter((finding) => recurring.has(finding.id)).map((finding) => finding.id));
  const candidates: Array<HistoricalQaSourceDefectCardIdentityInput & { promotedFindingIds: readonly string[] }> = [
    { ...input, promotedFindingIds: [] },
  ];
  if (matched.size > 0) {
    candidates.push({
      ...input,
      findings: input.findings.map((finding) => matched.has(finding.id)
        ? { ...finding, layer: "source_data" as const } : finding),
      promotedFindingIds: [...matched],
    });
  }
  return candidates;
}

export function buildHistoricalV3Candidates(
  input: HistoricalQaSourceDefectCardIdentityInput,
  recurringFindingIds: readonly string[],
) {
  return buildHistoricalV3InputVariants(input, recurringFindingIds).flatMap((variant) =>
    (["en", "ko"] as const).map((language) => buildHistoricalV3QaSourceDefectCard({ ...variant, language })));
}
