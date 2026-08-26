// server/src/services/workflow/qa-source-defect-owner-card.ts
//
// [ purpose ] QA 반려의 "원천 데이터 결함(source_data)" 계층 라우팅을 위한 인터랙티브 오너 카드.
//   (a) loop-driver 계층 라우팅 — findings 전부 source_data 면 생산자 리셋 대신 즉시 오너 에스컬레이션.
//   (b) 기존 QA cap 소진 경로(supervision) — ensureQaReworkCapOversightIssue 직후 동일 카드.
//   두 지점 모두 같은 requestKey(qa-source-defect:{run}:{producer}:{iteration}) 로 멱등 생성된다 —
//   operator_decisions 의 (companyId, requestKey) unique + requestHash replay 가 중복을 막는다.
//
// [ authority / rule 7-8 ] 이 모듈은 새로운 실행 경로를 만들지 않는다:
//   - 카드는 operator_decisions 시스템(기존)에 행을 추가하기만 한다.
//   - 해결(resolution) → 기존 operator-decision continuation worker 가 linkIssueId 의 assignee
//     (mission owner agent)를 wake → owner 가 기존 mission_owner_decision / owner-recovery API 로 실행.
//   - findings 는 공식 workflow verdict API 의 구조 제출(payload.findings)에서만 온다 —
//     자연어 comment/stdout 은 절대 파싱하지 않는다.

import type { Db } from "@paperclipai/db";
import { and, eq, like, ne } from "drizzle-orm";
import { operatorDecisions } from "@paperclipai/db";
import { resolveEdges, type EdgeBearingStep } from "./control-flow/edge-condition.js";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";

export const QA_SOURCE_DEFECT_CARD_SOURCE_TYPE = "workflow_qa_rejection";

/** 회사별 유니크 요청 키 — 동일 generation(producer×iteration) 의 카드는 정확히 1장. */
export function buildQaSourceDefectCardRequestKey(input: {
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
}): string {
  return `qa-source-defect:${input.workflowRunId}:${input.producerStepId}:${input.iteration}`;
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

/**
 * 카드 정의 빌더. **완전 결정적**이어야 한다 — (a)/(b) 두 생성 지점이 같은 generation 에 대해
 *   동일 requestHash 를 내면 replay 로 승인되고, 다르면 conflict 로 한쪽이 기각된다(로그됨).
 *   따라서 경로 구분 정보(어느 지점에서 만들었는지)는 콘텐츠에 절대 포함하지 않는다.
 */
function buildCardCreateInput(input: {
  readonly workflowRunId: string;
  readonly producerStepId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly findings: readonly WorkflowVerdictFinding[];
  readonly qaRefs: readonly QaSourceDefectCardQaRef[];
  readonly missionId: string | null;
  readonly linkIssueId: string | null;
}) {
  const findingsSorted = [...input.findings].sort((left, right) => left.id.localeCompare(right.id));
  const qaRefsSorted = [...input.qaRefs].sort((left, right) => left.qaStepId.localeCompare(right.qaStepId));
  const findingsLines = findingsSorted.map((finding) => `- [${finding.layer}] (${finding.id}) ${finding.summary}`);
  const sourceOnly = findingsSorted.every((finding) => finding.layer === "source_data");
  const qaList = qaRefsSorted
    .map((ref) => `- QA step \`${ref.qaStepId}\`${ref.qaIssueId ? ` (issue ${ref.qaIssueId})` : ""}`)
    .join("\n");

  const layerFact = {
    label: "결함 계층",
    value: findingsSorted.length === 0
      ? "미제출(구버전 판정)"
      : sourceOnly ? "전부 source_data(원천 데이터 결함)" : "혼합(artifact + source_data)",
    status: "known" as const,
  };
  const iterationFact = {
    label: "생산자 rework 상태",
    value: `iteration ${input.iteration}/${input.maxIterations}${sourceOnly ? " (원천 라우팅은 한도 미소모)" : ""}`,
    status: "known" as const,
  };
  const commonFacts = [layerFact, iterationFact];
  const commonEvidenceRefs = qaRefsSorted
    .filter((ref) => ref.qaIssueId)
    .map((ref) => ({ label: `QA 반려 이슈 (${ref.qaStepId})`, href: `/issues/${ref.qaIssueId}` }));

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
        label: `결함 ${finding.id}`.slice(0, 80),
        value: `[${finding.layer}] ${finding.summary}`.slice(0, 200),
        status: "known" as const,
      })),
    ],
    evidenceRefs: commonEvidenceRefs.slice(0, 10),
  });

  const definition = {
    options: [
      option(
        "rerun_source_collection",
        "원천 수집 재실행",
        "수집(collect) 계열 원천 스텝의 산출물이 결함의 원인입니다. 수집 스텝 이슈를 재실행(retry)해 원천 데이터를 다시 생성한 뒤 파이프라인이 이어지도록 지시합니다.",
      ),
      option(
        "extra_producer_rework",
        "생산자 재작업 1회 추가",
        `QA 반려가 산출물(artifact) 결함으로 판단되면 생산자 재작업을 1회 더 허용합니다. 재작업 한도 +1(qaReworkCapBoost) 부여 후 생산자 이슈 재작업을 지시합니다. 현재 iteration ${input.iteration}/${input.maxIterations}.`,
      ),
      option(
        "maintenance_issue",
        "[유지보수] 이슈 생성",
        "원천 데이터 결함이 코드/스킬/수집 파이프라인 수준의 근본 원인으로 의심되면 유지보수(maintenance) 트랙으로 이관합니다. 결함 findings를 근거로 유지보수 이슈를 생성합니다.",
      ),
      option(
        "replan_mission",
        "미션 재계획",
        "현재 접근으로는 완수할 수 없다고 판단되면 미션을 재계획(replan_mission)합니다.",
      ),
      option(
        "cancel",
        "취소",
        "조치 없이 카드를 닫습니다. 런은 현재 상태(failed/대기)로 유지됩니다.",
      ),
    ],
    actions: [
      { id: "submit", label: "결정 제출", outcome: "submit" as const, tone: "primary" as const, requiresSelection: true },
      { id: "dismiss", label: "카드 닫기", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
    ],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional" as const, label: "메모", placeholder: "결정 근거나 오너 에이전트에 전달할 지시를 남길 수 있습니다", maxLength: 2000 },
    approvedScope: ["operator_decision.resolve"],
    forbiddenScope: ["auto_retry", "producer_auto_rework"],
    humanReview: {
      schemaVersion: "human-review-v1" as const,
      decisionSubject: "QA 반려 계층 라우팅 — 원천 데이터 결함에 대한 오너 조치 선택",
      evidence: [
        {
          label: "QA 구조화 판정(findings)",
          href: `/issues/${qaRefsSorted.find((ref) => ref.qaIssueId)?.qaIssueId ?? input.producerStepId}`,
          location: `workflow run ${input.workflowRunId} / producer ${input.producerStepId}`,
          description: (findingsLines.join("\n") || "findings 미제출(구버전 판정 — cap 소진 경로)").slice(0, 1000),
        },
      ],
      interpretation: [
        `QA가 공식 verdict API(request_changes)로 제출한 결함 계층 태그 기준입니다.`,
        sourceOnly
          ? "모든 findings가 source_data(원천 데이터 결함)로 분류되었습니다 — 생산자(리포트 materialize)가 고칠 수 없는 결함이므로 자동 재작업을 돌리지 않고 즉시 오너 판단을 요청합니다."
          : "findings에 산출물(artifact) 계층이 포함되어 있거나 구버전 판정입니다 — 기존 재작업/cap 경로와 병행하여 오너 판단을 요청합니다.",
        "",
        "결함 항목:",
        ...(findingsLines.length > 0 ? findingsLines : ["- (findings 미제출)"]),
        "",
        `반려 QA: ${qaList || "(unknown)"}`,
      ].join("\n").slice(0, 4000),
      impact: {
        ifApproved: "선택한 옵션대로 오너 에이전트가 기존 실행 API(수집 재시도 / 재작업 승인 / 유지보수 이관 / 재계획)로 진행합니다.",
        ifRejected: "카드를 닫으면 런은 현재 상태로 유지되며 자동 재시도는 일어나지 않습니다.",
        ifWrong: "원천이 정상인데 수집을 재실행하면 세대가 낭비되고, 산출물 결함인데 수집만 재실행하면 같은 반려가 반복됩니다.",
      },
      unresolvedFacts: findingsSorted.length === 0 ? ["QA가 findings를 제출하지 않았습니다 — 계층 분류 없이 cap 소진으로만 판단됩니다."] : [],
      questions: sourceOnly
        ? ["원천 수집 스텝 재실행으로 결함이 해소될 것으로 보이는가, 유지보수 이관이 필요한 근본 원인인가?"]
        : ["산출물 계층 결함이 생산자 재작업으로 해소 가능한가?"],
      recommendedNextStep: sourceOnly
        ? "원천 수집 재실행(rerun_source_collection) 권장 — 생산자 재작업은 원천 결함을 고치지 못합니다."
        : "생산자 재작업 1회 추가(extra_producer_rework) 또는 미션 재계획(replan_mission) 검토.",
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
    title: `QA 반려 원천 데이터 결함 — 오너 결정 필요 (${input.producerStepId} iter ${input.iteration})`.slice(0, 200),
    description: [
      "## QA 반려 계층 라우팅 — 오너 결정 필요",
      "",
      `Producer: step \`${input.producerStepId}\` (iteration ${input.iteration}/${input.maxIterations})`,
      `Workflow run: ${input.workflowRunId}`,
      "",
      "QA가 반려(request_changes)했고, 결함 계층 태그(findings)에 따라 오너 조치가 필요합니다.",
      "",
      "결함 항목:",
      ...(findingsLines.length > 0 ? findingsLines : ["- (findings 미제출 — cap 소진 경로)"]),
      "",
      `반려 QA:`,
      qaList || "- (unknown)",
      "",
      "### 선택 후 실행 방법",
      "카드 해결 시 linkIssue assignee(mission owner agent)가 wake 됩니다. 오너 에이전트는 선택된 옵션에 따라 기존 실행 API로 진행합니다:",
      "- 원천 수집 재실행 → 수집 스텝 이슈 재시도(retry_source_issue, 수집 이슈 대상)",
      "- 생산자 재작업 추가 → 재작업 한도 +1(qaReworkCapBoost) 후 retry_source_issue(생산자 이슈 대상)",
      "- 유지보수 이관 → 유지보수 이슈 생성(결함 findings 근거 첨부)",
      "- 미션 재계획 → replan_mission",
      "Comments and markers are display-only and cannot authorize execution.",
    ].join("\n").slice(0, 4000),
    sourceType: QA_SOURCE_DEFECT_CARD_SOURCE_TYPE,
    sourceId: `${input.workflowRunId}:${input.producerStepId}:${input.iteration}`.slice(0, 200),
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
  const createInput = buildCardCreateInput(input);
  const write = operatorDecisionWriteService(input.db);

  // [supersede] 같은 (run, producer) 의 다른 requestKey 중 아직 pending 인 카드를 취소한다.
  //   cancel 은 기존 쓰기 서비스 경로(감사 로그 동반)를 그대로 쓴다 — 직접 UPDATE 금지.
  const staleRows = await input.db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    eq(operatorDecisions.sourceType, QA_SOURCE_DEFECT_CARD_SOURCE_TYPE),
    eq(operatorDecisions.status, "pending"),
    like(operatorDecisions.sourceId, `${input.workflowRunId}:${input.producerStepId}:%`),
    ne(operatorDecisions.requestKey, createInput.requestKey),
  ));
  for (const stale of staleRows) {
    await write.cancel(stale.id, { type: "user", id: "system" }, "qa_source_defect_card_superseded_by_newer_generation");
  }

  try {
    const result = await write.create(
      input.companyId,
      createInput,
      { type: "user", id: "system" },
    );
    return { outcome: result.replayed ? "replayed" : "created", decisionId: result.decision.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/conflict/iu.test(message)) return { outcome: "conflict", message };
    return { outcome: "failed", message };
  }
}


/** 정리 판정에 필요한 최소 stepRun 구조(구조적 호환). */
interface CleanupStepRun {
  readonly stepId: string;
  readonly status: string;
  readonly iterationIndex?: number | null;
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
