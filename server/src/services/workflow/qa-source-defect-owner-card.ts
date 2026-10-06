// QA source_data 오너 카드: loop-driver / supervision 공통 버전 키로 멱등 생성.
// 기존 쓰기/continuation 사용; findings는 공식 verdict API의 구조 제출만 권위다.

import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { and, eq, like } from "drizzle-orm";
import { operatorDecisions, workflowStepRuns } from "@paperclipai/db";
import { resolveEdges, type EdgeBearingStep } from "./control-flow/edge-condition.js";
import { applyRecurrencePromotion, type QaRecurrencePromotion } from "./control-flow/rework-contract.js";
import { loadPriorRejectedFindings } from "./validation-verdict-ledger.js";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";
import { loadCompanySystemLanguage, type SystemLanguage } from "../missions/system-language.js";

import { logger } from "../../middleware/logger.js";
import { HttpError } from "../../errors.js";
import { createOrReplayQaSourceDefectCard } from "./qa-source-defect-card-replay.js";
import { buildHistoricalQaSourceDefectCard } from "./qa-source-defect-card-historical.js";

export const QA_SOURCE_DEFECT_CARD_SOURCE_TYPE = "workflow_qa_rejection";
// 카드 definition 문구가 바뀌면 이 값을 올린다 — 문구가 requestHash에 포함되어 같은 키 재요청 conflict를 막는 유일한 안전장치.
export const QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION = 2;
const QA_SOURCE_DEFECT_CARD_HASH_REPLACEMENT_REQUEST_KEY_LIMIT = 160;
const QA_SOURCE_DEFECT_CARD_SOURCE_ID_REJECTION_LIMIT = 200;
/** UTF-16 한도를 유지하되 경계에서 갈라지는 서로게이트 쌍은 통째로 제외한다. */
function truncateText(value: string, limit: number): string {
  const splitsPair = value.charCodeAt(limit - 1) >= 0xd800 && value.charCodeAt(limit - 1) <= 0xdbff
    && value.charCodeAt(limit) >= 0xdc00 && value.charCodeAt(limit) <= 0xdfff;
  return value.slice(0, splitsPair ? limit - 1 : limit);
}
/** 회사별 유니크 요청 키 — 동일 generation(producer×iteration) 의 카드는 정확히 1장. */
export function buildQaSourceDefectCardRequestKey(input: {
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
}): string {
  const prefix = `qa-source-defect:v${QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION}:${input.workflowRunId}:`;
  const readable = `${prefix}${input.producerStepId}:${input.iteration}`;
  return readable.length <= QA_SOURCE_DEFECT_CARD_HASH_REPLACEMENT_REQUEST_KEY_LIMIT ? readable : `qa-source-defect-sha256:v${QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION}:${input.workflowRunId}:${createHash("sha256").update(input.producerStepId).digest("hex")}:${input.iteration}`;
}
/** 카드 옵션 id — 해결 결과(payload)에서 오너가 읽는 안정 식별자. 표시 문구는 아래 definition 참조. */
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

/** 두 생성 지점의 동일 generation은 동일 hash여야 한다; 경로 구분 정보를 포함하지 않는다. */
function buildCardCreateInput(input: {
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
  const commonEvidenceRefs = qaRefsSorted
    .filter((ref) => ref.qaIssueId)
    .map((ref) => ({ label: text(`Quality review rejection task (${ref.qaStepId})`, `품질검수 반려 업무 (${ref.qaStepId})`), href: `/issues/${ref.qaIssueId}` }));

  const option = (
    id: QaSourceDefectCardOptionId,
    label: string,
    description: string,
  ) => ({
    id,
    label,
    description,
    facts: [
      ...commonFacts,
      ...findingsSorted.slice(0, 8).map((finding) => ({
        label: truncateText(text(`Finding ${finding.id}`, `결함 ${finding.id}`), 80),
        value: truncateText(`[${layerBadge(finding)}] ${finding.summary}`, 200),
        status: "known" as const,
      })),
    ],
    evidenceRefs: commonEvidenceRefs.slice(0, 10),
  });

  const definition = {
    options: [
      option("rerun_source_collection", text("Run data collection again", "자료 수집 다시 실행"), text(
        "Choose this when the collected source material appears to be the cause. Ask the collection task to run again, replace the source material, and let the following work continue. Internal command: `retry_source_issue`.",
        "자료를 모으는 단계의 결과가 문제의 원인으로 보일 때 고르세요. 수집 단계 업무를 다시 실행해 원천 자료를 새로 만들고 이어지는 작업이 계속되도록 지시합니다. 내부 명령: `retry_source_issue`.")),
      option("extra_producer_rework", text("Allow one more producer rework", "생산자 재작업 1회 더 허용"), text(
        `Choose this when the output itself needs fixing. Allow the agent that creates it one more rework attempt, then request rework of its task. Used ${input.iteration}/${input.maxIterations}. Internal command: \`qaReworkCapBoost\` (+1), then \`retry_source_issue\`.`,
        `산출물(생산 단계의 결과물) 자체를 고쳐야 할 때 고르세요. 생산자(산출물을 만드는 에이전트)의 재작업을 1회 더 허용한 뒤 해당 업무의 재작업을 지시합니다. 현재 사용 ${input.iteration}/${input.maxIterations}회. 내부 명령: \`qaReworkCapBoost\`(+1), 이후 \`retry_source_issue\`.`)),
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

export type EnsureQaSourceDefectCardResult =
  | { readonly outcome: "created"; readonly decisionId: string }
  | { readonly outcome: "replayed"; readonly decisionId: string }
  | { readonly outcome: "conflict"; readonly message: string }
  | { readonly outcome: "failed"; readonly message: string };
/**
 * [멱등 생성 + 중복 방지] requestKey 로 replay 처리되고(동일 requestHash → replayed), 같은
 *   (workflowRun, producer) 의 이전 iteration 카드가 아직 pending 이면 cancel 로 대체한다 —
 *   운영자는 항상 해당 조건의 최신 카드 1장만 본다(2026-08-25 GAZ 3중 복제 사고 대응).
 *   hash 충돌(다른 generation 콘텐츠 — 희귀)은 conflict 로 반환. 실패는 failed 로 반환한다.
 */
export async function ensureQaSourceDefectOwnerCard(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly missionId: string | null;
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly findings: readonly WorkflowVerdictFinding[];
  readonly qaRefs: readonly QaSourceDefectCardQaRef[];
  /** continuation wake 대상 이슈(mission owner agent 가 assignee 인 이슈 — oversight/qa-cap owner action). */
  readonly linkIssueId: string | null;
}): Promise<EnsureQaSourceDefectCardResult> {
  const sourceId = `${input.workflowRunId}:${input.producerStepId}:${input.iteration}`;
  if (sourceId.length > QA_SOURCE_DEFECT_CARD_SOURCE_ID_REJECTION_LIMIT) return { outcome: "failed",
    message: `QA source identity length ${sourceId.length} exceeds ${QA_SOURCE_DEFECT_CARD_SOURCE_ID_REJECTION_LIMIT} UTF-16 units; rejected before supersede or write` };
  if (`qa-source-defect:v${QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION}:${sourceId}`.length > QA_SOURCE_DEFECT_CARD_HASH_REPLACEMENT_REQUEST_KEY_LIMIT
    && sourceId !== sourceId.normalize("NFC")) return { outcome: "failed",
    message: "QA source identity changes under NFC normalization in hash replacement path; rejected before supersede or write" };
  // 두 생성 경로의 결정성을 위해 카드 입력 직전 승격을 1회 계산; 조회 실패는 선언 계층 유지.
  const promotion = await resolveRecurrencePromotion(input);
  let language: SystemLanguage = "en";
  try {
    language = await loadCompanySystemLanguage(input.db, input.companyId);
  } catch (err) {
    logger.warn({ err, companyId: input.companyId }, "QA source defect card language lookup failed; using English");
  }
  try {
    const result = await createOrReplayQaSourceDefectCard({
      db: input.db, companyId: input.companyId, language,
      legacyRequestKey: `qa-source-defect:${sourceId}`, sourcePrefix: `${`${input.workflowRunId}:${input.producerStepId}:`.replace(/[\\%_]/g, "\\$&")}%`,
      buildHistorical: () => buildHistoricalQaSourceDefectCard({ ...input, findings: promotion.findings, promotedFindingIds: promotion.promotedFindingIds }),
      build: (displayLanguage) => buildCardCreateInput({
        ...input, language: displayLanguage,
        findings: promotion.findings, promotedFindingIds: promotion.promotedFindingIds,
      }),
    });
    return { outcome: result.replayed ? "replayed" : "created", decisionId: result.decision.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError && error.status === 409) return { outcome: "conflict", message };
    return { outcome: "failed", message };
  }
}
/** 정리 판정에 필요한 최소 stepRun 구조(구조적 호환). */
interface CleanupStepRun {
  readonly stepId: string;
  readonly status: string;
  readonly iterationIndex?: number | null;
}

/**
 * [qa layer feedback loop — 카드 입력 직전 승격 1회] 이 카드 generation 의 재발 승격을 계산한다.
 *   qaRefs 각 QA 라인의 직전 세대 반려 findings(같은 stepRun 의 최신 판정 바로 이전 이벤트)와
 *   finding id 가 완전 일치하는 항목만 승격하며, 세대 경계 가드(직전 판정이 이번 생산자 세대
 *   완료 이전 관측)는 loadPriorRejectedFindings 가 담당한다. 순수 계산은 applyRecurrencePromotion
 *   (rework-contract) — loop-driver 라우팅과 동일 함수/동일 입력으로 같은 값을 얻는다.
 */
async function resolveRecurrencePromotion(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly findings: readonly WorkflowVerdictFinding[];
  readonly qaRefs: readonly QaSourceDefectCardQaRef[];
}): Promise<QaRecurrencePromotion> {
  const identity: QaRecurrencePromotion = { findings: input.findings, promotedFindingIds: [] };
  if (input.findings.length === 0) return identity;
  try {
    const [producerRun] = await input.db
      .select({ completedAt: workflowStepRuns.completedAt })
      .from(workflowStepRuns)
      .where(and(
        // (workflowRunId, stepId) 는 유일 인덱스 — 세대 간 재사용되는 이 stepRun 행이 정확히 1건.
        eq(workflowStepRuns.workflowRunId, input.workflowRunId),
        eq(workflowStepRuns.stepId, input.producerStepId),
      ))
      .limit(1);
    if (!producerRun?.completedAt) return identity;
    const priorFindings: WorkflowVerdictFinding[] = [];
    for (const ref of input.qaRefs) {
      if (!ref.qaIssueId) continue;
      const [qaRun] = await input.db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(and(
          eq(workflowStepRuns.workflowRunId, input.workflowRunId),
          eq(workflowStepRuns.stepId, ref.qaStepId),
          eq(workflowStepRuns.issueId, ref.qaIssueId),
        ))
        .limit(1);
      if (!qaRun) continue;
      const prior = await loadPriorRejectedFindings({
        db: input.db,
        companyId: input.companyId,
        issueId: ref.qaIssueId,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: qaRun.id,
        notAfter: producerRun.completedAt,
      });
      if (prior) priorFindings.push(...prior);
    }
    if (priorFindings.length === 0) return identity;
    return applyRecurrencePromotion(input.findings, priorFindings);
  } catch {
    // 승격 조회 실패가 카드 생성 경로를 깨뜨리지 않게 한다(보수: 승격 없음 — 기존 라우팅 유지).
    return identity;
  }
}

interface CleanupStepRunRow {
  stepId: string;
  status: string;
  iterationIndex: number | null;
}

/** sourceId(`${runId}:${producerStepId}:${iteration}`) 을 (runId, producerStepId, iteration) 로 분해. */
function parseSourceId(sourceId: string): { runId: string; producerStepId: string; iteration: number } | null {
  const first = sourceId.indexOf(":");
  const last = sourceId.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  const iteration = Number.parseInt(sourceId.slice(last + 1), 10);
  if (!Number.isInteger(iteration) || iteration < 0) return null;
  return { runId: sourceId.slice(0, first), producerStepId: sourceId.slice(first + 1, last), iteration };
}

/**
 * [상황 해소 자동 취소] pending 원천결함 카드가 더 이상 의미 없는 조건에서 자동 cancel 한다(감사 로그 동반).
 *   (1) 런 completed/cancelled 종결 — 카드가 묻는 조치 대상 런이 이미 끝남. failed 는 제외:
 *       실패 종결은 카드가 여전히 유효한 에스컬레이션이므로 오너 판단을 유지한다.
 *   (2) 런 진행 중 — 카드가 지적한 generation 이후의 생산자 generation 이 completed 이고 해당
 *       producer 의 모든 백엣지 QA 가 completed(통과) 로 확정된 경우. QA 가 failed 면 최신 반려
 *       처리(신규 카드/재작업)가 진행 중일 수 있으므로 건드리지 않는다(fail-closed).
 * [규칙 7-8] 새 실행 경로 없음 — 기존 write.cancel(감사 로그)만 호출. 자연어는 판단에 쓰지 않고
 *   stepRun 상태(구조 원천)만으로 판정한다. 호출부(dag-engine sync)는 try/catch 로 감싼다.
 */
export async function cancelResolvedQaSourceDefectOwnerCards(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly run: { readonly id: string; readonly status: string };
  readonly steps: ReadonlyArray<EdgeBearingStep>;
  readonly stepRuns: ReadonlyArray<CleanupStepRunRow>;
}): Promise<{ cancelled: number }> {
  const write = operatorDecisionWriteService(input.db);
  const pending = await input.db.select({ id: operatorDecisions.id, sourceId: operatorDecisions.sourceId }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    eq(operatorDecisions.sourceType, QA_SOURCE_DEFECT_CARD_SOURCE_TYPE),
    eq(operatorDecisions.status, "pending"),
    like(operatorDecisions.sourceId, `${input.run.id}:%`),
  ));
  if (pending.length === 0) return { cancelled: 0 };

  const runTerminalResolved = input.run.status === "completed" || input.run.status === "cancelled";
  const stepRunByStepId = new Map(input.stepRuns.map((row) => [row.stepId, row]));

  let cancelled = 0;
  for (const card of pending) {
    const parsed = parseSourceId(card.sourceId ?? "");
    if (!parsed || parsed.runId !== input.run.id) continue;

    let reason: string | null = null;
    if (runTerminalResolved) {
      reason = `run_${input.run.status}`;
    } else {
      // 진행 중 런: 이후 generation 통과로 완전히 대체됐는지만 판정(구조 원천만 사용).
      const producer = stepRunByStepId.get(parsed.producerStepId);
      if (!producer) continue;
      if ((producer.iterationIndex ?? 0) <= parsed.iteration) continue;
      if (producer.status !== "completed") continue;
      const producerDef = input.steps.find((step) => step.id === parsed.producerStepId);
      if (!producerDef) continue;
      const qaStepIds = resolveEdges(producerDef)
        .filter((edge) => edge.isBackEdge === true)
        .map((edge) => edge.stepId);
      if (qaStepIds.length === 0) continue;
      const allQaPassed = qaStepIds.every((qaStepId) => stepRunByStepId.get(qaStepId)?.status === "completed");
      if (!allQaPassed) continue;
      reason = "superseded_generation_passed";
    }

    try {
      await write.cancel(card.id, { type: "user", id: "system" }, `qa_source_defect_card_${reason}`);
      cancelled += 1;
    } catch {
      // 동시 해소/충돌은 다음 sync 에 재시도된다 — 정리가 sync 를 깨뜨리지 않는다.
    }
  }
  return { cancelled };
}
