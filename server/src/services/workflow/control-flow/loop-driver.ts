/**
 * [파일 목적] bounded back-edge loop 의 "재발화 pass". syncWorkflowRunState 의 한 단계로 한 번 호출되어
 *   QA 반려(request_changes) 로 인해 back-edge 가 발화해야 하는 terminal step(=producer) 을 찾아
 *   리셋(rework) 시킨다(P4). 리셋된 step 은 이어지는 launch while-loop 에서 재실행된다.
 * [동작 모델]
 *   - back-edge 는 producer 의 conditionalDependencies 에 {stepId:"<qa>", when:"qa_request_changes",
 *     isBackEdge:true, maxIterations:N} 형태로 존재(producer 가 QA 로 back-edge).
 *   - "발화해야 하는가" 는 edge-condition.classifyStepActivation(producer, predsByStepId).runnable 으로 판정 —
 *     predsByStepId 를 dag-engine 이 live verdict 를 채워 넘기므로 qa_request_changes 가 정밀 평가된다
 *     (generic failure/infra 에러로 loop 발화 ❌ — PLAN 설계결정 "loop 발화 조건").
 *   - cap: iteration_index < maxIterations 일 때만 리셋. iteration_index = 수행된 rework 수(초기실행=0).
 *     매 리셋마다 +1(step-reset). cap 도달 시 리셋 중단 → step 은 terminal 에 머물고 QA 도 재발화하지 않아
 *     워크플로가 failed 로 수렴(또는 QA pass 면 completed). **이 cap 이 가즈아 25h hang 회귀 방지의 핵심**.
 * [주요 흐름] applyBackEdgeReworkPass:
 *   1. cancelled 거부 / conditional edge 없으면 no-op.
 *   2. 각 step 중 back-edge 를 가진 terminal step 에 대해:
 *      classifyStepActivation.runnable && iteration_index<maxIterations → resetStepRunForRework(attempt archive).
 *   2b. [qa defect layer routing] 반려 QA 의 공식 findings 전부 source_data(원천 데이터 결함) 면
 *      생산자 리셋/한도 소모 없이 즉시 오너 카드(operator_decisions)로 에스컬레이션하고 이 step 을 skip.
 *      혼재(artifact 포함)면 기존 재작업 경로 + 오너 카드 병행, 미제출(구버전 판정)이면 카드 없이 기존 경로.
 *   3. 리셋 발생 시 stepRuns 재조회 반환.
 * [외부 연결] consumer: dag-engine.ts syncWorkflowRunState(skip-pass 직후, launch while-loop 직전).
 *   의존: edge-condition(classifyStepActivation/resolveEdges/workflowHasConditionalEdges, PredFacts),
 *   step-reset(resetStepRunForRework), types. **dag-engine 을 import 하지 않는다(순환/결합 회피).**
 * [수정시 주의]
 *   - **무한 loop 금지**: 리셋은 pass 당 step 당 최대 1회, 그리고 iteration_index 단조 증가 + maxIterations
 *     하드 cap 덕에 유한. sync 간에도 총 리셋 수 ≤ Σ(maxIterations). reconciler(60min) 이 최후 안전망.
 *   - QA 재실행은 여기서 담당하지 않는다 — 기존 validation-recheck(syncStepRunsFromIssueState L748-815) 가
 *     producer 재완료 후 QA issue 를 "todo" 로 돌려 재QA 시킨다. 본 pass 는 producer 리셋(=rework)만 새로 담당.
 *   - 본 pass 는 동일 sync 내에서 한 번만 실행(syncWorkflowRunState 가 1회 호출). while-loop 은 이 pass 를
 *     재호출하지 않으므로 1 sync = (step 당) 최대 1 리셋.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import {
  conditionalEdgeHolds,
  resolveEdges,
  workflowHasConditionalEdges,
  type EdgeBearingStep,
  type PredFacts,
} from "./edge-condition.js";
import { resetStepRunForRework } from "./step-reset.js";
import { filterFreshRejectedQas } from "./stale-verdict-guard.js";
import { isDeliveryRelevantStep } from "../delivery-verification-gate.js";
import { writeQualityFinding } from "../../quality-finding-writer.js";
import { buildWorkflowReworkContract, renderWorkflowReworkComment } from "./rework-contract.js";
import { loadProducerDependencyArtifacts, loadProducerOwnReworkContext } from "./rework-producer-context.js";
import { applyCapAcceptancePass } from "./qa-cap-acceptance.js";
import { loadWorkflowApiFeedback, loadWorkflowApiFindings } from "../validation-verdict-ledger.js";
import { tryQaRemediationPass } from "./qa-remediation.js";
import { readCapBoostAmount, type StepIterationAttempt } from "./types.js";
import {
  buildQaSourceDefectCardRequestKey,
  ensureQaSourceDefectOwnerCard,
  type QaSourceDefectCardQaRef,
} from "../qa-source-defect-owner-card.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

/** loop-driver 가 보는 run 의 최소 구조. dag-engine 의 workflowRuns row 가 구조적 호환. */
interface LoopRun {
  id: string;
  companyId: string;
  status: string;
  missionId?: string | null;
}

const TERMINAL_STEP_RUN_STATUSES = new Set(["completed", "failed", "skipped"]);

export interface ApplyBackEdgeReworkInput {
  db: Db;
  run: LoopRun;
  steps: ReadonlyArray<EdgeBearingStep>;
  stepRuns: StepRun[];
  /**
   * dag-engine 이 buildPredFactsMap 으로 조립한 선행 facts 맵. **반드시 live validation verdict 가 채워져야**
   * 한다(qa_request_changes 정밀 평가). verdict 가 비면 P2 fallback(status:failed) 으로 떨어져 infra 에러
   * 까지 loop 를 발화시킬 수 있다.
   */
  predsByStepId: Map<string, PredFacts>;
  /**
   * QA issueId → 최신 verdict 관측 시각. stale verdict 재소비 차단(RES-995)에 사용:
   * producer 가 rework 후 completed 된 시점보다 **이전**에 관측된 verdict 는 그 producer generation
   * 에 대한 판정이 아니므로 rework cap 소모에 쓰지 않는다. producer 완료 후 새 QA run 이 observedAt >=
   * producerCompletedAt 인 verdict 를 낼 때만 rework 를 일으킨다.
   */
  validationVerdictsByIssueId?: ReadonlyMap<string, { observedAt: Date | null } | undefined>;
  /**
   * [qa mechanical remediation] QA 스텝 재실행(wake) 콜백 — dag-engine 이 wakeExistingWorkflowStepIssue
   * 를 래핑해 주입한다(순환 import 회피). 미제공 시 remediation pass 는 비활성(기존 재작업 경로만).
   */
  refireQaStep?: (qa: { stepId: string; stepRunId: string; issueId: string }) => Promise<boolean>;
}

export interface ApplyBackEdgeReworkResult {
  stepRuns: StepRun[];
  reworkedCount: number;
  /** 기계적 remediation 으로 생산자 재실행 없이 해결된 producer 수(관측용). */
  remediatedCount: number;
}

async function loadQaReworkFeedback(input: {
  db: Db;
  companyId: string;
  qaIssueId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
}): Promise<string | null> {
  // [rework feedback authority] the request-changes rationale is read ONLY from the official
  //   workflow_api verdict event payload bound to this QA issue's current run + step. Comments,
  //   heartbeat result, and stdout are not parsed for feedback.
  if (!input.qaIssueId || !input.workflowRunId || !input.workflowStepRunId) return null;
  return loadWorkflowApiFeedback({
    db: input.db,
    companyId: input.companyId,
    issueId: input.qaIssueId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
  });
}

interface RejectedQaWithFindings {
  readonly qaStepId: string;
  readonly qaIssueId: string | null;
  readonly findings: readonly WorkflowVerdictFinding[] | null;
}

/** findings 병기 태그 — 원천 결함 항목을 생산자 재작업 계약 feedback 에 구조적으로 병기한다(표시 전용). */
function renderSourceScopeTag(findings: readonly WorkflowVerdictFinding[]): string {
  const lines = findings
    .filter((finding) => finding.layer === "source_data")
    .map((finding) => `- (${finding.id}) ${finding.summary}`);
  return ["#### [생산자 범위 밖 — 원천 데이터 결함] 아래 항목은 원천(수집) 산출물 결함으로 생산자가 고칠 수 없습니다. 원천 라우팅 대상입니다:", ...lines].join("\n");
}

/**
 * [qa defect layer — 즉시 오너 에스컬레이션] findings 전부 source_data 인 generation 은 생산자 리셋/한도
 *   소모 없이 오너 카드로 즉시 넘긴다. 카드는 operator_decisions(기존 시스템)에 행만 추가하며, 해결 체인
 *   (continuation worker → owner wake → mission_owner_decision API)은 기존 것을 재사용한다(규칙 7).
 *   mission/oversight 이슈가 없으면 false 를 반환 — caller 는 기존 재작업 경로로 fail-closed 한다.
 */
async function escalateQaSourceDefectToOwner(input: {
  readonly db: Db;
  readonly run: LoopRun;
  readonly producerStepId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly rejectedQas: readonly RejectedQaWithFindings[];
  /** 라우팅 결과 — source_only: 리셋 대체 즉시 에스컬레이션, mixed: 기존 재작업과 병행 카드. */
  readonly route: "source_only" | "mixed";
}): Promise<boolean> {
  const { db, run } = input;
  if (!run.missionId) return false;
  // continuation wake 대상: mission owner agent 가 assignee 인 oversight 이슈(기존 감독이 유지하는 상시 이슈).
  const [oversight] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, run.companyId),
      eq(issues.missionId, run.missionId),
      eq(issues.originKind, "mission_main_executor_oversight"),
    ))
    .limit(1);
  if (!oversight) return false;

  const qaRefs: QaSourceDefectCardQaRef[] = input.rejectedQas.map((qa) => ({
    qaStepId: qa.qaStepId,
    qaIssueId: qa.qaIssueId,
  }));
  const findings = input.rejectedQas.flatMap((qa) => qa.findings ?? []);
  const requestKey = buildQaSourceDefectCardRequestKey({
    workflowRunId: run.id,
    producerStepId: input.producerStepId,
    iteration: input.iteration,
  });

  // 1) durable routing evidence — 왜 이 generation 에 오너 카드가 떴는지의 DB 기록(규칙 8).
  await db.insert(workflowTransitionEvents).values({
    companyId: run.companyId,
    missionId: run.missionId,
    workflowRunId: run.id,
    eventType: "qa_source_defect_routed",
    layer: "workflow_validation",
    decision: input.route === "source_only" ? "owner_escalation" : "rework_with_card",
    reason: "qa_defect_layer_routing",
    reasonCode: "qa_defect_layer_routing",
    idempotencyKey: `qa-source-defect-routed:${run.companyId}:${run.id}:${input.producerStepId}:${input.iteration}`,
    payload: {
      kind: "qa_source_defect_routed",
      route: input.route,
      producerStepId: input.producerStepId,
      iteration: input.iteration,
      maxIterations: input.maxIterations,
      findings,
      qaRefs,
      cardRequestKey: requestKey,
    },
  }).onConflictDoNothing();

  // 2) interactive owner card — requestKey 멱등(회사+키 unique). 실패해도 라우팅 사실(1)은 남는다.
  await ensureQaSourceDefectOwnerCard({
    db,
    companyId: run.companyId,
    missionId: run.missionId,
    workflowRunId: run.id,
    producerStepId: input.producerStepId,
    iteration: input.iteration,
    maxIterations: input.maxIterations,
    findings,
    qaRefs,
    linkIssueId: oversight.id,
  });
  return true;
}

/**
 * [목적] back-edge(QA 반려) 로 발화해야 하는 terminal step 들을 cap 내에서 리셋(rework).
 * [입력] ApplyBackEdgeReworkInput. [출력] { stepRuns(리셋 반영), reworkedCount }.
 * [주의] 동일 sync 내 1회 호출 전제. cap 초과 시 해당 step 은 건드리지 않는다(bounded 종료).
 */
export async function applyBackEdgeReworkPass(
  input: ApplyBackEdgeReworkInput,
): Promise<ApplyBackEdgeReworkResult> {
  const { db, run, steps, predsByStepId } = input;

  if (run.status === "cancelled") return { stepRuns: input.stepRuns, reworkedCount: 0, remediatedCount: 0 };
  if (!workflowHasConditionalEdges(steps)) return { stepRuns: input.stepRuns, reworkedCount: 0, remediatedCount: 0 };

  const stepRunMap = new Map(input.stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  let reworkedCount = 0;
  let remediatedCount = 0;

  for (const step of steps) {
    // 이 step 이 back-edge 의 타겟(=rework 대상 producer) 인지. maxIterations≥1 동반만 유효.
    const backEdges = resolveEdges(step).filter(
      (edge) => edge.isBackEdge === true && typeof edge.maxIterations === "number" && edge.maxIterations >= 1,
    );
    if (backEdges.length === 0) continue;

    const stepRun = stepRunMap.get(step.id);
    // pending/running(이미 돌고있거나 대기) 은 rework 대상 아님. terminal 만.
    if (!stepRun || !TERMINAL_STEP_RUN_STATUSES.has(stepRun.status)) continue;

    // [QA loop hardening] coalesce: 한 producer 에 여러 back-edge QA validator 가 달려 있을 때,
    //   각 QA verdict 가 비동기로 도착한다고 해서 verdict 단위로 producer 를 따로 리셋하지 않는다.
    //   같은 producer 산출물에 대한 모든 sibling QA 가 terminal 될 때까지 대기(barrier)한 뒤,
    //   request_changes 들을 하나의 rework 사이클로 합쳐 producer iteration 을 1 만 소모하게 한다.
    //   목적: maxIterations 가 QA verdict 단위가 아니라 producer rework 사이클 단위로 소모되도록.
    const siblingQas = backEdges.map((edge) => {
      const qaRun = stepRunMap.get(edge.stepId);
      const pred = predsByStepId.get(edge.stepId);
      const terminal = !!qaRun && TERMINAL_STEP_RUN_STATUSES.has(qaRun.status);
      // rejected = 이 QA 가 terminal 이며 when(qa_request_changes) 이 성립(verdict=request_changes).
      const rejected = conditionalEdgeHolds(edge, pred);
      return { edge, qaRun, pred, terminal, rejected };
    });
    // barrier: sibling QA 중 pending/running(또는 아직 stepRun 자체가 없는) 이 있으면 이번 sync 에는
    //   리셋하지 않고 다음 tick 에 재평가. conservative — 모든 relevant QA 가 끝난 뒤에만 rework.
    if (!siblingQas.every((q) => q.terminal)) continue;
    const rejectedQasRaw = siblingQas.filter((q) => q.rejected);
    if (rejectedQasRaw.length === 0) continue; // 전원 pass(또는 반려 아님) → rework 없이 forward

    // RES-995: drop QA verdicts observed before this producer iteration completed —
    // they belong to a previous generation and must not consume the rework cap again.
    // Verdict timing is conservative (unknown => not stale) to preserve prior behavior.
    const producerCompletedAt = stepRun.completedAt ?? null;
    const rejectedQas = filterFreshRejectedQas(
      rejectedQasRaw,
      producerCompletedAt,
      input.validationVerdictsByIssueId,
    );
    if (rejectedQas.length === 0) continue; // all stale -> wait for a fresh QA verdict, no rework

    // producer-level cap: iterationIndex 는 producer stepRun 에서 모든 back-edge 가 공유하므로,
    //   cap 도 QA edge 단위가 아닌 producer 단위로 판정한다(여러 edge 의 max 이상치 사용).
    const maxIterations = Math.max(...siblingQas.map((q) => q.edge.maxIterations!));
    const currentIteration = stepRun.iterationIndex ?? 0;

    // [qa defect layer routing] 각 fresh 반려 QA 의 구조화 findings 를 공식 verdict 이벤트에서만 로드한다.
    //   (a) findings 전부 source_data → 생산자 리셋 스킵/한도 미소모 + 즉시 오너 카드 에스컬레이션.
    //   (b) artifact 계층 혼재 → 기존 재작업 경로(리셋)를 그대로 밟되 오너 카드를 병행 생성하고,
    //       source_data 항목은 재작업 계약 feedback 에 '생산자 범위 밖' 태그로 병기한다.
    //   (c) findings 미제출(구버전 판정) → 기존 동작 100% 유지, 카드 없음(fail-closed).
    const rejectedWithFindings: RejectedQaWithFindings[] = [];
    for (const q of rejectedQas) {
      // 구조 권위 경로: QA issue/run/stepRun 바인딩이 온전할 때만 공식 verdict 이벤트에서 findings 를 읽는다.
      const findings = q.qaRun?.issueId && q.qaRun?.id
        ? await loadWorkflowApiFindings({
            db,
            companyId: run.companyId,
            issueId: q.qaRun.issueId,
            workflowRunId: q.qaRun.workflowRunId ?? run.id,
            workflowStepRunId: q.qaRun.id,
          })
        : null;
      rejectedWithFindings.push({
        qaStepId: q.edge.stepId,
        qaIssueId: q.qaRun?.issueId ?? null,
        findings,
      });
    }
    const allFindingsPresent = rejectedWithFindings.every((qa) => (qa.findings?.length ?? 0) > 0);
    const allSourceData = allFindingsPresent
      && rejectedWithFindings.every((qa) => qa.findings!.every((finding) => finding.layer === "source_data"));
    if (allFindingsPresent) {
      // 구조화 findings 가 있으면(원천-only 또는 혼합) 오너 카드를 띄운다 — 원천-only 는 리셋을 대체하고,
      //       혼합은 기존 재작업 경로와 병행한다(운영자가 원천 부분을 조기에 볼 수 있다).
      const escalated = await escalateQaSourceDefectToOwner({
        db,
        run,
        producerStepId: step.id,
        iteration: currentIteration,
        maxIterations,
        rejectedQas: rejectedWithFindings,
        route: allSourceData ? "source_only" : "mixed",
      });
      if (allSourceData && escalated) {
        // 생산자 리셋 스킵 — iteration 불변(한도 미소모). 런은 QA failed 로 수담하고 오너 카드가 조치를 기다린다.
        continue;
      }
      // 혼합 경로 또는 에스컬레이션 불가(mission/oversight 부재) → 기존 재작업 경로로 흐른다(fail-closed).
    }
    // [operator cap boost] operator 가 명시적으로 부여한 일시 추가 한도(metadata.qaReworkCapBoost.amount).
    //   기본 0 — 부여하지 않으면 기존 maxIterations 그대로. boost 는 오직 이번 stepRun 세대의 cap 판정에만 쓴다.
    const capBoost = readCapBoostAmount(stepRun.metadata);

    // cap: iteration_index(수행된 rework 수) 가 maxIterations+boost 에 도달하면 더 리셋하지 않는다(bounded).
    //   cap-exhausted → owner/replan 신호는 Patch 2 가 supervision 과 연결; 여기선 기존대로 terminal 유지.
    if (currentIteration >= maxIterations + capBoost) continue;

    // [qa mechanical remediation] fresh 반려 QA 전원이 schema-validated remediations 를 동봉했고 결정론적
    //   적용이 검증되면 생산자 재실행 없이 패치 + QA 스텝만 재실행한다(재작업 한도 미소모). 검증 실패/
    //   remediations 미제출/하드블록 게이트/시도 상한 초과면 not_applicable → 아래 기존 재작업 경로로 폴백.
    //   "waiting" = 해당 verdict 들은 이미 remediation 적용된 상태(재QA 대기 중) → 재작업도 스킵.
    if (input.refireQaStep) {
      const findingsByQaStepId = new Map<string, readonly WorkflowVerdictFinding[] | null>(
        rejectedWithFindings.map((r) => [r.qaStepId, r.findings]),
      );
      const remediation = await tryQaRemediationPass({
        db,
        run,
        steps,
        producerStep: step,
        producerRun: stepRun,
        rejectedQas,
        findingsByQaStepId,
        refireQaStep: input.refireQaStep,
      });
      if (remediation.outcome === "applied") {
        remediatedCount += 1;
        continue;
      }
      if (remediation.outcome === "waiting") {
        continue;
      }
    }

    const attempt: StepIterationAttempt = {
      iteration: currentIteration,
      verdict: "request_changes",
      completedAt: stepRun.completedAt?.toISOString() ?? new Date().toISOString(),
    };
    const dependencyArtifacts = await loadProducerDependencyArtifacts({ db, companyId: run.companyId, stepRunMap, producerStep: step });
    const producerOwnContext = await loadProducerOwnReworkContext({ db, companyId: run.companyId, missionId: run.missionId ?? null, workflowRunId: run.id, producerStepId: step.id, producerIssueId: stepRun.issueId ?? null });

    // 모든 반려 QA 의 feedback 을 합쳐 하나의 rework comment 로 생산자에게 전달.
    //   [qa defect layer] 혼재 경로에서 source_data 항목은 '생산자 범위 밖' 태그로 병기된다(표시 전용 —
    //   라우팅 권위는 아니고, 생산자가 원천 결함을 자기 탓으로 재작업하지 않게 안내한다).
    const qaFeedbacks = [];
    for (const q of rejectedQas) {
      const layered = rejectedWithFindings.find((r) => r.qaStepId === q.edge.stepId) ?? null;
      const sourceFindings = layered?.findings?.filter((finding) => finding.layer === "source_data") ?? [];
      const baseFeedback = await loadQaReworkFeedback({
        db,
        companyId: run.companyId,
        qaIssueId: q.qaRun?.issueId ?? null,
        workflowRunId: q.qaRun?.workflowRunId ?? null,
        workflowStepRunId: q.qaRun?.id ?? null,
      });
      const feedback = sourceFindings.length > 0 && layered?.findings
        ? [baseFeedback, renderSourceScopeTag(layered.findings)].filter((part) => part !== null).join("\n\n")
        : baseFeedback;
      qaFeedbacks.push({
        qaStepId: q.edge.stepId,
        qaIssueId: q.qaRun?.issueId ?? null,
        feedback,
      });
    }
    const reworkContract = buildWorkflowReworkContract({
      producerStepId: step.id,
      qaFeedbacks,
      currentIteration,
      maxIterations,
      dependencyArtifacts,
      producerIssueInstruction: producerOwnContext.instruction,
      producerWorkProducts: producerOwnContext.workProducts,
    });

    await resetStepRunForRework({
      db,
      stepRun,
      companyId: run.companyId,
      attempt,
      reworkContract,
      reason: `qa_request_changes(merged back-edge ${step.id}←[${rejectedQas.map((q) => q.edge.stepId).join(",")}], iteration ${currentIteration}/${maxIterations})`,
    });
    // Phase 5 (plan 8.1 delivery verification): 각 반려 QA 마다 best-effort company-scoped quality
    //   review item. Narrow dedupe by QA issue id; carry run/step context in triggerMetadata +
    //   evidence `expected` so the collector knows what to probe.
    for (const q of rejectedQas) {
      const qaStepDef = steps.find((s) => s.id === q.edge.stepId);
      if (
        qaStepDef &&
        isDeliveryRelevantStep({
          id: qaStepDef.id,
          name: (qaStepDef as { name?: string }).name ?? qaStepDef.id,
          description: (qaStepDef as { description?: string }).description,
        })
      ) {
        try {
          const qaIssueId = q.qaRun?.issueId ?? null;
          const expected = { workflowRunId: run.id, qaStepId: qaStepDef.id, qaIssueId, producerStepId: step.id };
          await writeQualityFinding(db, {
            companyId: run.companyId,
            missionId: run.missionId ?? null,
            title: `Delivery verification failed: ${qaStepDef.id}`,
            targetType: "public_url",
            triggerSource: "delivery_verification",
            targetId: qaIssueId ? `${run.id}:${qaIssueId}` : `${run.id}:${qaStepDef.id}`,
            failureType: "delivery_url_404",
            triggerMetadata: expected,
            evidenceRefs: [
              { surface: "public_url", status: "missing", blocking: true, expected },
              { surface: "browser_readback", status: "missing", blocking: true, expected },
            ],
          });
        } catch {
          // swallowed: the rework loop must never depend on the quality board.
        }
      }
    }
    if (stepRun.issueId) {
      await db.insert(issueComments).values({
        companyId: run.companyId,
        issueId: stepRun.issueId,
        body: renderWorkflowReworkComment(reworkContract),
      });
    }
    reworkedCount += 1;
  }

  const effectiveStepRuns = reworkedCount > 0
    ? await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
    : input.stepRuns;
  // [qa-cap acceptance] at-cap opted-in back-edge 는, 모든 current fresh 반려 semantic QA 가 공식
  //   nonblocking verdict 로 수용되면 해당 FAILED QA 만 CAS completed 로 바꾼다(producer/reset/retry ❌).
  //   under-cap 은 위 rework path 가 담당하므로 여기선 no-op. 결과 stepRuns 를 cap pass 가 갱신한다.
  const capResult = await applyCapAcceptancePass({
    db,
    run,
    steps,
    stepRuns: effectiveStepRuns,
    predsByStepId,
    validationVerdictsByIssueId: input.validationVerdictsByIssueId,
  });
  return { stepRuns: capResult.stepRuns, reworkedCount, remediatedCount };
}
