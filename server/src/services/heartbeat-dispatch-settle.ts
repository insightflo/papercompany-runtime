// server/src/services/heartbeat-dispatch-settle.ts
//
// [purpose] issue+workflowStepRunId 바인딩 디스패치 런이 종말 실패(retry/fallback 소진 포함)할 때
//   연결된 workflow 스텝을 failed 종말 전이하고 이슈를 blocked로 정산한다.
//   정산 없으면 스텝이 영구 running + 이슈가 in_progress로 남아 모든 회복 경로가 막힌다:
//   wakeExistingWorkflowStepIssue 는 in_progress 이슈를 거부하고, resume preview 는
//   active_work residue 로 차단되며, 이슈 상태 동기화는 running 스텝을 다시 running 으로 되돌린다.
// [호출부] heartbeat 의 releaseFinishedRun 진입부 — 모든 종말 실패 경로(fallback suppressed,
//   setup 실패, agent-missing 실패)가 통과하는 단일 깔때기. hold/early-return 전에 호출된다.
// [안전] 두 쓰기 모두 CAS(step: expected running/pending, issue: expected in_progress)라
//   재호출·경쟁 정산·이미 종결된 상태는 무변화 no-op. 성공한 run(status!=="failed")과
//   미바인딩 run 은 진입 조건에서 즉시 반환된다.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  heartbeatRuns,
  issueComments,
  issues,
  workflowStepRuns,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { setWorkflowStepRunStatus } from "./workflow/step-status-fencing.js";
import { recordWorkflowStepStatusTransition } from "./workflow/workflow-sync-source.js";
import { sanitizeErrorSummary } from "./workflow/retry-metadata.js";
import { runText } from "./heartbeat-run-presentation.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

const SETTLE_REASON_CODE = "dispatch_run_retries_exhausted";

function buildDispatchSettleComment(input: {
  run: HeartbeatRun;
  stepRunId: string;
  errorSummary: string | null;
}): string {
  const { run, stepRunId, errorSummary } = input;
  const rawReason = (run.error ?? run.stderrExcerpt ?? run.stdoutExcerpt ?? "").trim();
  const reasonExcerpt = rawReason.length > 1200 ? rawReason.slice(0, 1200) : rawReason;
  return [
    runText(
      run,
      "## 연결된 실행이 자동 재시도를 모두 소진해 업무를 차단했습니다 (linked dispatch run exhausted retries)\n다음 행동: 아래 기록을 확인한 뒤 업무 책임자가 재시도·담당 변경 여부를 결정해 주세요. blocked 상태의 업무는 검증된 재개 경로로 다시 깨울 수 있습니다. 이 댓글은 재실행 요청이 아닙니다.",
      "## Issue blocked — linked dispatch run exhausted retries\nNext action: review the record below, then let the owner decide whether to retry or reassign. A blocked issue can be re-dispatched through the verified resume path. This comment does not request another run.",
    ),
    `- 실행 runId: \`${run.id}\``,
    `- run status: \`${run.status}\``,
    `- workflow stepRun: \`${stepRunId}\``,
    `- 사유 코드: \`${SETTLE_REASON_CODE}\``,
    errorSummary ? `- 요약: ${errorSummary}` : "",
    reasonExcerpt ? ["", "### Failure excerpt", "```text", reasonExcerpt, "```"].join("\n") : "",
  ].filter((line) => line.length > 0).join("\n");
}

export async function settleDispatchBoundTerminalFailure(input: {
  db: Db;
  run: HeartbeatRun;
}): Promise<void> {
  const { db, run } = input;
  if (run.status !== "failed" || !run.issueId || !run.workflowStepRunId) return;

  const stepRun = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, run.workflowStepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!stepRun) {
    logger.warn(
      { runId: run.id, stepRunId: run.workflowStepRunId },
      "dispatch-bound terminal failure could not find linked step run",
    );
    return;
  }

  const finishedAt = run.finishedAt ?? new Date();
  const errorSummary = sanitizeErrorSummary(run.error) ?? SETTLE_REASON_CODE;

  // 1. 스텝 failed 종말 전이 — 디스패치 오너 참조는 전이 기록에 남기고 필드는 비운다
  //    (남은 live 참조가 없어야 resume preview 의 hasOwner/active_work 가드가 열린다).
  if (stepRun.status === "running" || stepRun.status === "pending") {
    const updated = await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "failed",
      patch: {
        completedAt: finishedAt,
        dispatchOwnerWakeupRequestId: null,
        dispatchOwnerHeartbeatRunId: null,
        lastDispatchErrorAt: finishedAt,
        lastDispatchErrorSummary: errorSummary,
      },
      expectedStatuses: ["running", "pending"],
    });
    if (!updated) {
      logger.info(
        { runId: run.id, stepRunId: stepRun.id, status: stepRun.status },
        "dispatch-bound step already left pre-terminal state",
      );
    } else {
      await recordWorkflowStepStatusTransition(db, {
        companyId: run.companyId,
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
        issueId: run.issueId,
        heartbeatRunId: run.id,
        fromStatus: stepRun.status,
        toStatus: "failed",
        source: "heartbeat_promotion",
        transitionVersion: updated.statusTransitionVersion > stepRun.statusTransitionVersion
          ? updated.statusTransitionVersion
          : null,
      });
    }
  }

  // 2. 이슈 blocked 정산 — in_progress 만 CAS(in_review·done 같은 사람 검토 상태는 건드리지 않는다).
  //    blocked 는 wakeExistingWorkflowStepIssue(allowBlockedIssue) 가 받는 상태라 native
  //    재개 경로가 열리고, 이슈 상태 동기화의 desiredStepRunStatus("blocked")→"failed" 가
  //    스텝 전이와 일치해 플랩이 없다.
  await db.transaction(async (tx) => {
    const [blocked] = await tx
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(and(
        eq(issues.id, run.issueId!),
        eq(issues.companyId, run.companyId),
        eq(issues.status, "in_progress"),
      ))
      .returning({ id: issues.id, companyId: issues.companyId });
    if (!blocked) return;

    await tx.insert(issueComments).values({
      companyId: blocked.companyId,
      issueId: blocked.id,
      authorAgentId: run.agentId,
      body: buildDispatchSettleComment({
        run,
        stepRunId: stepRun.id,
        errorSummary,
      }),
    });
    await tx.insert(activityLog).values({
      companyId: blocked.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.run_failure_auto_blocked",
      entityType: "issue",
      entityId: blocked.id,
      agentId: run.agentId,
      runId: run.id,
      details: {
        workflowStepRunId: stepRun.id,
        workflowRunId: stepRun.workflowRunId,
        reasonCode: SETTLE_REASON_CODE,
        dispatchBoundRun: true,
      },
    });
  });
}
