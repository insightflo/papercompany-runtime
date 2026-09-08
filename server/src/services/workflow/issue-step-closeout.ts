import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  recordWorkflowStepStatusTransition,
  type WorkflowSyncSource,
} from "./workflow-sync-source.js";
import { readOwnResumeRequestId } from "./resume-scope-fence.js";
import { readWorkflowReworkContract } from "./control-flow/rework-contract.js";

type WorkflowStepRunWriteDb = Pick<Db, "select" | "update" | "insert" | "transaction">;

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

export async function completeLinkedWorkflowStepRunsForIssue(input: {
  db: WorkflowStepRunWriteDb;
  issueId: string;
  completedAt: Date;
  source?: WorkflowSyncSource;
  heartbeatRunId?: string | null;
}): Promise<string[]> {
  const linkedStepRuns = await input.db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      issueId: workflowStepRuns.issueId,
      status: workflowStepRuns.status,
      startedAt: workflowStepRuns.startedAt,
      metadata: workflowStepRuns.metadata,
      executionGeneration: workflowStepRuns.executionGeneration,
      runMetadata: workflowRuns.metadata,
      companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(eq(workflowStepRuns.issueId, input.issueId), ACTIVE_STEP_STATUS_CONDITION));

  const issueStartedAt = await input.db
    .select({ startedAt: issues.startedAt })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1)
    .then((rows) => rows[0]?.startedAt ?? null);

  const completedIds: string[] = [];
  for (const stepRun of linkedStepRuns) {
    // [rework startedAt 타이밍] rework 리셋 후 stepRun.startedAt 이 null 인 채로 closeout 완료되면
    //   종전에는 완료 시각(completedAt)이 startedAt 로 찍혀, 같은 시도가 막 생산한 work product
    //   (updatedAt 이 몇 초 먼저)가 "이전 시도 산물(stale)"로 오분류돼 하류 IF 노드의 신선도 검사
    //   (condition-source-resolver)가 실패했다(2026-08-15 RES concept-radar 사고). dag-engine 의
    //   syncStepRunsFromIssueState 와 동일한 폴백 사슬을 쓴다: stepRun → issue → rework 계약 → 완료 시각.
    const reworkStartedAt = (() => {
      const contract = readWorkflowReworkContract(
        (stepRun.metadata as Record<string, unknown> | null)?.workflowReworkContract,
      );
      return contract?.createdAt ? new Date(contract.createdAt) : null;
    })();
    const attemptStartedAt = stepRun.startedAt ?? issueStartedAt ?? reworkStartedAt ?? input.completedAt;
    // [Task6c-C] resume run(step stamp 존재)의 closeout 은 세대/stamp 정체로 한 세대에만 수렴한다.
    //   (a) step stamp ≠ 부모 run 현재 stamp → 이 step 은 현재 resume 세대에서 재시작되지 않은
    //   이전 세대 잔존물 — 무음 스킵(stale). (b) stamp 이 일치해도 generation CAS 를 where 에
    //   추가해 select/update 사이 concurrent resume reset 이 끼어들면 0 row 로 무음 스킵한다.
    //   ordinary run(step stamp 없음)은 조건 추가 없이 기존 where 그대로 — byte-identical.
    const resumeStamp = readOwnResumeRequestId(stepRun.metadata);
    if (resumeStamp !== null && readOwnResumeRequestId(stepRun.runMetadata) !== resumeStamp) continue;
    const resumeCloseoutCondition = resumeStamp !== null
      ? eq(workflowStepRuns.executionGeneration, stepRun.executionGeneration)
      : undefined;
    const [updated] = await input.db
      .update(workflowStepRuns)
      .set({
        status: "completed",
        startedAt: attemptStartedAt,
        completedAt: input.completedAt,
      })
      .where(resumeCloseoutCondition
        ? and(
          eq(workflowStepRuns.id, stepRun.id),
          ACTIVE_STEP_STATUS_CONDITION,
          resumeCloseoutCondition,
        )
        : and(eq(workflowStepRuns.id, stepRun.id), ACTIVE_STEP_STATUS_CONDITION))
      .returning({
        id: workflowStepRuns.id,
        transitionVersion: workflowStepRuns.statusTransitionVersion,
      });
    if (!updated) continue;
    completedIds.push(updated.id);
    await recordWorkflowStepStatusTransition(input.db, {
      companyId: stepRun.companyId,
      missionId: stepRun.missionId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
      issueId: stepRun.issueId,
      fromStatus: stepRun.status,
      toStatus: "completed",
      source: input.source ?? "workflow_issue_closeout",
      heartbeatRunId: input.heartbeatRunId,
      transitionVersion: updated.transitionVersion,
    });
  }

  return completedIds;
}
