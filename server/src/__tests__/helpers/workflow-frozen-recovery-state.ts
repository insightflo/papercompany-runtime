import { asc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests,
  issueComments,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";

/**
 * [purpose] Task5a2b fix1 증거 헬퍼: 하나의 workflow run 에 정확히 스코프된 full rows 를
 *   읽기 전용으로 캡처한다(fail-closed 422 경로의 무변화 증명용). mock 없음 — 실제 Db SELECT 만.
 *   정렬은 각 테이블 id 오름차순(결정적 before/after 비교 보장). wakes 는 company 전체가 아니라
 *   정확히 해당 run 의 workflowRunId 로 한정한다. linked issues 는 run 의 stepRun.issueId 로
 *   도출하며, 없으면 빈 inArray 쿼리를 피하고 [] 를 반환한다.
 */
export interface FrozenRecoveryState {
  run: typeof workflowRuns.$inferSelect | undefined;
  steps: (typeof workflowStepRuns.$inferSelect)[];
  linkedIssues: (typeof issues.$inferSelect)[];
  linkedIssueComments: (typeof issueComments.$inferSelect)[];
  transitionEvents: (typeof workflowTransitionEvents.$inferSelect)[];
  wakeupRequests: (typeof agentWakeupRequests.$inferSelect)[];
}

export async function captureFrozenRecoveryState(db: Db, workflowRunId: string): Promise<FrozenRecoveryState> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
  const steps = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId)).orderBy(asc(workflowStepRuns.id));
  const linkedIssueIds = [...new Set(steps.map((step) => step.issueId).filter((id): id is string => Boolean(id)))];
  const linkedIssues = linkedIssueIds.length === 0
    ? []
    : await db.select().from(issues).where(inArray(issues.id, linkedIssueIds)).orderBy(asc(issues.id));
  const linkedIssueComments = linkedIssueIds.length === 0
    ? []
    : await db.select().from(issueComments).where(inArray(issueComments.issueId, linkedIssueIds)).orderBy(asc(issueComments.id));
  const transitionEvents = await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.workflowRunId, workflowRunId)).orderBy(asc(workflowTransitionEvents.id));
  const wakeupRequests = await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowRunId, workflowRunId)).orderBy(asc(agentWakeupRequests.id));
  return { run, steps, linkedIssues, linkedIssueComments, transitionEvents, wakeupRequests };
}
