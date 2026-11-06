import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { ValidationVerdict, ValidationVerdictObservation } from "./dag-readiness-facts.js";
import { desiredStepRunStatusFromIssueStatus } from "./workflow-step-issue-records.js";

export function desiredValidationCheckStepStatus(input: {
  issueStatus: string;
  latestVerdict: ValidationVerdictObservation | undefined;
}): "pending" | "running" | "completed" | "failed" {
  if (input.issueStatus !== "done") {
    return desiredStepRunStatusFromIssueStatus(input.issueStatus);
  }
  if (input.latestVerdict?.verdict === "pass") return "completed";
  if (input.latestVerdict?.verdict === "request_changes") return "failed";
  return "running";
}

function isNewerValidationVerdict(
  next: ValidationVerdictObservation,
  current: ValidationVerdictObservation | undefined,
): boolean {
  if (!current) return true;
  const nextTime = next.observedAt?.getTime() ?? 0;
  const currentTime = current.observedAt?.getTime() ?? 0;
  return nextTime >= currentTime;
}

function setLatestValidationVerdict(
  verdictsByIssueId: Map<string, ValidationVerdictObservation>,
  issueId: string | null,
  verdict: ValidationVerdict | null,
  observedAt: Date | null,
): void {
  if (!issueId) return;
  const next = { verdict, observedAt };
  if (isNewerValidationVerdict(next, verdictsByIssueId.get(issueId))) {
    verdictsByIssueId.set(issueId, next);
  }
}

/**
 * [목적] 주어진 issue 들에 대해 최신 validation verdict(pass|request_changes|null) 를 durable
 *   workflow_validation_verdict event 에서만 읽어 issueId→observation 맵으로 반환.
 *   syncStepRunsFromIssueState 와 syncWorkflowRunState(loop-driver predFacts 빌드) 가 동일 원천을 공유.
 * [scope fail-closed] 각 issue 의 CURRENT workflow run + step run + company exact binding 만 인정.
 *   재사용된 issue의 과거 run/step verdict 가 현재 DAG 판정을 좌우하지 않는다(startedAt 단독 대체 ❌).
 */
export type WorkflowValidationIssueBinding = {
  readonly companyId: string;
  readonly workflowRunId: string;
  readonly workflowStepRunId: string;
};

export async function loadLatestValidationVerdicts(
  db: Db,
  bindings: ReadonlyMap<string, WorkflowValidationIssueBinding>,
): Promise<Map<string, ValidationVerdictObservation>> {
  const verdicts = new Map<string, ValidationVerdictObservation>();
  if (bindings.size === 0) return verdicts;

  const issueIds = [...bindings.keys()];
  const issueRows = await db
    .select({
      id: issues.id,
      startedAt: issues.startedAt,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const minObservedAtByIssueId = new Map(issueRows.map((issue) => [issue.id, issue.startedAt ?? null]));
  const isWithinCurrentExecutionWindow = (issueId: string | null, observedAt: Date | null): boolean => {
    if (!issueId || !observedAt) return true;
    const minObservedAt = minObservedAtByIssueId.get(issueId);
    return !minObservedAt || observedAt.getTime() >= minObservedAt.getTime();
  };

  const eventRows = await db
    .select({
      issueId: workflowTransitionEvents.issueId,
      verdict: workflowTransitionEvents.verdict,
      createdAt: workflowTransitionEvents.createdAt,
      companyId: workflowTransitionEvents.companyId,
      workflowRunId: workflowTransitionEvents.workflowRunId,
      workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      inArray(workflowTransitionEvents.issueId, issueIds),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      // structured authority only: ignore legacy comment/heartbeat_result derived events.
      eq(workflowTransitionEvents.reason, "workflow_api"),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  // [verdict authority] batch-resolve backing heartbeat runs and keep only those scoped (company +
  //   issue) to their QA issue — the verdict API always runs on a checked-out run of the QA issue.
  const heartbeatRunIds = Array.from(new Set(
    eventRows.map((event) => event.heartbeatRunId).filter((id): id is string => typeof id === "string"),
  ));
  const heartbeatRunScopeById = new Map<string, { companyId: string | null; issueId: string | null }>();
  if (heartbeatRunIds.length > 0) {
    const runScopeRows = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, heartbeatRunIds));
    for (const row of runScopeRows) {
      heartbeatRunScopeById.set(row.id, { companyId: row.companyId, issueId: row.issueId });
    }
  }
  for (const event of eventRows) {
    const observedAt = event.createdAt ?? null;
    if (!isWithinCurrentExecutionWindow(event.issueId, observedAt)) continue;
    if (event.verdict !== "pass" && event.verdict !== "request_changes") continue;
    // [scope fail-closed] exact binding to the issue's current workflow run + step run + company.
    //   a reused issue's prior-run verdict must never drive the current DAG verdict.
    const binding = event.issueId ? bindings.get(event.issueId) : null;
    if (
      !binding ||
      event.companyId !== binding.companyId ||
      event.workflowRunId !== binding.workflowRunId ||
      event.workflowStepRunId !== binding.workflowStepRunId
    ) {
      continue;
    }
    // [verdict authority] the backing heartbeat run must be a checked-out run scoped to this QA issue.
    const runScope = event.heartbeatRunId ? heartbeatRunScopeById.get(event.heartbeatRunId) : null;
    if (!runScope || runScope.companyId !== binding.companyId || runScope.issueId !== event.issueId) {
      continue;
    }
    setLatestValidationVerdict(verdicts, event.issueId, event.verdict, observedAt);
  }
  return verdicts;
}
