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

import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import {
  conditionalEdgeHolds,
  resolveEdges,
  workflowHasConditionalEdges,
  type EdgeBearingStep,
  type PredFacts,
} from "./edge-condition.js";
import { resetStepRunForRework } from "./step-reset.js";
import { isDeliveryRelevantStep } from "../delivery-verification-gate.js";
import { qualityService } from "../../quality.js";
import type { StepIterationAttempt } from "./types.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

/** loop-driver 가 보는 run 의 최소 구조. dag-engine 의 workflowRuns row 가 구조적 호환. */
interface LoopRun {
  id: string;
  companyId: string;
  status: string;
}

const TERMINAL_STEP_RUN_STATUSES = new Set(["completed", "failed", "skipped"]);
const REQUEST_CHANGES_PATTERN = /\bREQUEST[_\s-]?CHANGES\b|request\s+changes/i;

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
}

export interface ApplyBackEdgeReworkResult {
  stepRuns: StepRun[];
  reworkedCount: number;
}

function truncateFeedback(body: string, maxLength = 4000): string {
  return body.length <= maxLength ? body : `${body.slice(0, maxLength)}\n\n[truncated]`;
}

function extractHeartbeatFeedback(resultJson: unknown, stdoutExcerpt: string | null): string | null {
  const result = resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
    ? resultJson as Record<string, unknown>
    : {};
  const candidates = [
    result.result,
    result.summary,
    result.message,
    result.stdout,
    stdoutExcerpt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    return truncateFeedback(trimmed);
  }
  return null;
}

async function loadQaReworkFeedback(input: {
  db: Db;
  qaIssueId: string | null;
}): Promise<string | null> {
  if (!input.qaIssueId) return null;
  const rows = await input.db
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(eq(issueComments.issueId, input.qaIssueId))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(5);
  const requestChangeRows = rows.filter((row) => REQUEST_CHANGES_PATTERN.test(row.body));
  const selectedRows = requestChangeRows.length > 0 ? requestChangeRows : rows.slice(0, 1);
  if (selectedRows.length > 0) {
    return selectedRows.map((row) => {
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : "unknown-time";
      return `### QA feedback at ${createdAt}\n${truncateFeedback(row.body)}`;
    })
    .join("\n\n");
  }

  const runRows = await input.db
    .select({
      resultJson: heartbeatRuns.resultJson,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.issueId, input.qaIssueId))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(5);
  for (const run of runRows) {
    const feedback = extractHeartbeatFeedback(run.resultJson, run.stdoutExcerpt);
    if (!feedback) continue;
    const observedAt = run.finishedAt ?? run.createdAt;
    const timestamp = observedAt instanceof Date ? observedAt.toISOString() : "unknown-time";
    return `### QA heartbeat feedback at ${timestamp}\n${feedback}`;
  }

  return null;
}

/**
 * [목적] producer 가 rework 재실행할 때 current(this-run) upstream(dependency) workProduct 절대경로를
 *   rework 댓글에 주입. agent 가 issue 댓글을 읽으므로, stale 이전-run 경로 대신 current 산출물을 보게 해
 *   "producer가 rework 후에도 stale/무생산을 반복"하는 deeper 루트(rework context freshness)를 끊는다.
 * [입력] db, stepRunMap(stepId→stepRun), producerStep(dependencies). [출력] current dependency artifact 섹션文本|null.
 */
async function loadProducerDependencyArtifacts(input: {
  db: Db;
  stepRunMap: Map<string, StepRun>;
  producerStep: { dependencies?: string[] };
}): Promise<string | null> {
  const depStepIds = Array.isArray(input.producerStep.dependencies) ? input.producerStep.dependencies : [];
  if (depStepIds.length === 0) return null;
  const issueToStepId = new Map<string, string>();
  const depIssueIds: string[] = [];
  for (const depStepId of depStepIds) {
    const issueId = input.stepRunMap.get(depStepId)?.issueId;
    if (typeof issueId === "string" && issueId.length > 0) {
      depIssueIds.push(issueId);
      issueToStepId.set(issueId, depStepId);
    }
  }
  if (depIssueIds.length === 0) return null;
  const products = await input.db
    .select({
      issueId: issueWorkProducts.issueId,
      title: issueWorkProducts.title,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      metadata: issueWorkProducts.metadata,
      status: issueWorkProducts.status,
    })
    .from(issueWorkProducts)
    .where(inArray(issueWorkProducts.issueId, depIssueIds));
  const byStepId = new Map<string, string[]>();
  for (const product of products) {
    if (typeof product.status === "string" && product.status !== "active") continue;
    const stepId = issueToStepId.get(product.issueId);
    if (!stepId) continue;
    const metaPath = product.metadata && typeof product.metadata === "object"
      ? (product.metadata as Record<string, unknown>).path
      : null;
    const ref = product.url ?? product.externalId ?? (typeof metaPath === "string" ? metaPath : null);
    if (typeof ref !== "string" || ref.trim().length === 0) continue;
    const arr = byStepId.get(stepId) ?? [];
    arr.push(`${product.title ?? "artifact"} → ${ref}`);
    byStepId.set(stepId, arr);
  }
  const lines = ["### Current upstream artifacts (refreshed for this rework — use THESE paths, not previous-run files):"];
  let any = false;
  for (const depStepId of depStepIds) {
    const arr = byStepId.get(depStepId);
    if (arr && arr.length > 0) {
      lines.push(`- ${depStepId}: ${arr.join("; ")}`);
      any = true;
    } else {
      lines.push(`- ${depStepId}: (no active workProduct registered)`);
    }
  }
  return any ? lines.join("\n") : null;
}

function buildProducerReworkComment(input: {
  producerStepId: string;
  qaStepId: string;
  qaIssueId: string | null;
  currentIteration: number;
  maxIterations: number;
  feedback: string | null;
  dependencyArtifacts?: string | null;
}): string {
  return [
    "## Workflow QA rework request",
    "",
    `QA step \`${input.qaStepId}\` requested changes, so producer step \`${input.producerStepId}\` was reset for rework.`,
    `- QA issue: ${input.qaIssueId ?? "unknown"}`,
    `- Rework iteration: ${input.currentIteration + 1}/${input.maxIterations}`,
    "- Required: update the deliverable to address the QA feedback, save it in the assigned output directory, and finish with the required `[ARTIFACT]: <absolute path>` line.",
    "- Do not close this issue as already complete unless the requested changes are actually reflected in the deliverable.",
    input.dependencyArtifacts ?? null,
    "",
    input.feedback ?? "No QA feedback comment was found on the validator issue. Inspect the validator issue before proceeding.",
  ]
    .filter((line) => line !== null)
    .join("\n");
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

  if (run.status === "cancelled") return { stepRuns: input.stepRuns, reworkedCount: 0 };
  if (!workflowHasConditionalEdges(steps)) return { stepRuns: input.stepRuns, reworkedCount: 0 };

  const stepRunMap = new Map(input.stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  let reworkedCount = 0;

  for (const step of steps) {
    // 이 step 이 back-edge 의 타겟(=rework 대상 producer) 인지. maxIterations≥1 동반만 유효.
    const backEdges = resolveEdges(step).filter(
      (edge) => edge.isBackEdge === true && typeof edge.maxIterations === "number" && edge.maxIterations >= 1,
    );
    if (backEdges.length === 0) continue;

    const stepRun = stepRunMap.get(step.id);
    // pending/running(이미 돌고있거나 대기) 은 rework 대상 아님. terminal 만.
    if (!stepRun || !TERMINAL_STEP_RUN_STATUSES.has(stepRun.status)) continue;

    const firingEdge = backEdges.find((edge) => conditionalEdgeHolds(edge, predsByStepId.get(edge.stepId)));
    if (!firingEdge) continue;
    const maxIterations = firingEdge.maxIterations!;
    const currentIteration = stepRun.iterationIndex ?? 0;

    // back-edge 가 지금 발화해야 하는가? = back-edge 의 when(qa_request_changes) 이 선행(QA) facts 에 성립.
    // classifyStepActivation 은 forward-gate 전용이라(P5: back-edge 제외) back-edge 발화 판정에 쓸 수 없다 —
    // 여기선 back-edge 의 when 을 직접 평가한다(conditionalEdgeHolds). live verdict 가 predFacts 에 채워져 있다.
    const predFacts = predsByStepId.get(firingEdge.stepId);

    // cap: iteration_index(수행된 rework 수) 가 maxIterations 에 도달하면 더 않는다(bounded).
    if (currentIteration >= maxIterations) {
      // QA 가 여전히 반려여도 rework 기회 소진 → step 은 terminal 에 머물 → 워크플로 failed 수렴.
      continue;
    }
    const attempt: StepIterationAttempt = {
      iteration: currentIteration,
      verdict: predFacts?.verdict === "pass" ? "pass" : "request_changes",
      completedAt: new Date().toISOString(),
    };
    const qaStepRun = stepRunMap.get(firingEdge.stepId);
    const qaFeedback = await loadQaReworkFeedback({ db, qaIssueId: qaStepRun?.issueId ?? null });
    const dependencyArtifacts = await loadProducerDependencyArtifacts({ db, stepRunMap, producerStep: step });

    await resetStepRunForRework({
      db,
      stepRun,
      companyId: run.companyId,
      attempt,
      reason: `qa_request_changes(back-edge ${step.id}←${firingEdge.stepId}, iteration ${currentIteration}/${maxIterations})`,
    });
      // Phase 5 (plan 8.1 delivery verification): a delivery-relevant QA step returning request_changes
      // → best-effort company-scoped quality review item with missing public_url/browser_readback surfaces.
      // Swallow errors: the rework loop must never depend on the quality board.
      const qaStepDef = steps.find((s) => s.id === firingEdge.stepId);
      if (
        qaStepDef &&
        isDeliveryRelevantStep({
          id: qaStepDef.id,
          name: (qaStepDef as { name?: string }).name ?? qaStepDef.id,
          description: (qaStepDef as { description?: string }).description,
        })
      ) {
        // Phase 5 (plan 8.1 delivery verification): best-effort, never blocks the rework loop.
        void qualityService(db)
          .createDeliveryFailureReviewItem({ companyId: run.companyId, stepId: qaStepDef.id })
          .catch(() => {});
      }
    if (stepRun.issueId) {
      await db.insert(issueComments).values({
        companyId: run.companyId,
        issueId: stepRun.issueId,
        body: buildProducerReworkComment({
          producerStepId: step.id,
          qaStepId: firingEdge.stepId,
          qaIssueId: qaStepRun?.issueId ?? null,
          currentIteration,
          maxIterations,
          feedback: qaFeedback,
          dependencyArtifacts,
        }),
      });
    }
    reworkedCount += 1;
  }

  if (reworkedCount > 0) {
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, run.id));
    return { stepRuns, reworkedCount };
  }
  return { stepRuns: input.stepRuns, reworkedCount };
}
