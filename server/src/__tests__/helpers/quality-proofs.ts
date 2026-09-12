// server/src/__tests__/helpers/quality-proofs.ts
//
// [purpose] T3 통합 증명 helper. readCanonicalCounts 는 브리프가 지정한 테스트 helper로
//   정식 실행 생성이 실제 DB 행을 남겼는지(또는 rollback 후 남기지 않았는지)를 잰다.
//   seedCurrentOutputScenario 는 진행 중 원본 mission + producer/QA binding + 공식
//   request_changes verdict(remediations 포함) 시나리오를 실제 행으로 만든다.

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missionAgents,
  missions,
  qualityActions,
  qualityOccurrences,
  qualityReviewItems,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import type { SourceAttempt } from "@paperclipai/shared";

/** 브리프 계약: mission/missionAgents/oversight·step issue/counter/run/step/activity/action 연결의 실제 행 수. */
export async function readCanonicalCounts(db: Db, companyId: string): Promise<Record<string, number>> {
  const [company] = await db.select({ c: companies.issueCounter }).from(companies).where(eq(companies.id, companyId));
  const [missionRow] = await db.select({ c: sql<number>`count(*)::int` }).from(missions).where(eq(missions.companyId, companyId));
  const [agentRow] = await db.select({ c: sql<number>`count(*)::int` })
    .from(missionAgents).innerJoin(missions, eq(missions.id, missionAgents.missionId)).where(eq(missions.companyId, companyId));
  const [oversightRow] = await db.select({ c: sql<number>`count(*)::int` }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_main_executor_oversight")));
  const [stepIssueRow] = await db.select({ c: sql<number>`count(*)::int` }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "workflow_execution")));
  const [runRow] = await db.select({ c: sql<number>`count(*)::int` }).from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
  const [stepRunRow] = await db.select({ c: sql<number>`count(*)::int` })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(eq(workflowRuns.companyId, companyId));
  const [activityRow] = await db.select({ c: sql<number>`count(*)::int` }).from(activityLog).where(eq(activityLog.companyId, companyId));
  const [boundRow] = await db.select({ c: sql<number>`count(*)::int` }).from(qualityActions)
    .where(and(eq(qualityActions.companyId, companyId), isNotNull(qualityActions.canonicalBinding)));
  return {
    missions: missionRow!.c,
    missionAgents: agentRow!.c,
    oversightIssues: oversightRow!.c,
    stepIssues: stepIssueRow!.c,
    issueCounter: company!.c,
    workflowRuns: runRow!.c,
    workflowStepRuns: stepRunRow!.c,
    activityLog: activityRow!.c,
    boundActions: boundRow!.c,
  };
}

export interface CurrentOutputSeed {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  producerStepRunId: string;
  producerIssueId: string;
  qaStepRunId: string;
  qaIssueId: string;
  verdictEventId: string;
  verdictHeartbeatId: string;
  verifierAgentId: string;
  source: SourceAttempt;
}

export interface SeedCurrentOutputInput {
  companyId: string;
  authorAgentId: string;
  verifierAgentId: string;
  artifactUrl: string;
  remediations: Record<string, unknown>;
}

/**
 * 진행 중 원본: active mission + running workflow(producer→QA back edge) + 완료된 producer
 * step/issue/heartbeat + 최신 공식 request_changes verdict(스키마 검증된 remediations).
 * producer heartbeat 는 source attempt 검증에 필요한 step/generation binding 을 가진다.
 */
export async function seedCurrentOutputScenario(db: Db, input: SeedCurrentOutputInput): Promise<CurrentOutputSeed> {
  const missionId = randomUUID();
  await db.insert(missions).values({
    id: missionId, companyId: input.companyId, ownerAgentId: input.authorAgentId,
    title: `quality current-output source ${missionId.slice(0, 8)}`, status: "active",
  });
  const producer = "produce";
  const qa = "qa-validate";
  const steps = [
    { id: producer, name: "Produce", agentId: input.authorAgentId, dependencies: [],
      conditionalDependencies: [{ stepId: qa, when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] },
    { id: qa, name: "[QA] Validate", agentId: input.verifierAgentId, dependencies: [producer] },
  ];
  const workflowId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId: input.companyId, name: `quality-co-wf-${workflowId.slice(0, 8)}`, stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId: input.companyId, workflowId, missionId, status: "running", triggeredBy: "test" });

  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  await db.insert(issues).values({ id: producerIssueId, companyId: input.companyId, missionId, title: "produce-report", description: "Produce the deliverable.", status: "done", assigneeAgentId: input.authorAgentId });
  await db.insert(issues).values({ id: qaIssueId, companyId: input.companyId, missionId, title: "[QA] Validate", description: "Validate the deliverable.", status: "todo", assigneeAgentId: input.verifierAgentId });
  await db.insert(issueWorkProducts).values({
    companyId: input.companyId, issueId: producerIssueId, type: "file", provider: "local", title: "report", status: "active", url: input.artifactUrl,
  });

  const producerCompletedAt = new Date(Date.now() - 60_000);
  const [producerRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: producer, issueId: producerIssueId,
    status: "completed", iterationIndex: 0, completedAt: producerCompletedAt, executionGeneration: 1,
  }).returning();
  const [qaRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: qa, issueId: qaIssueId,
    status: "failed", completedAt: new Date(Date.now() - 20_000), executionGeneration: 1,
  }).returning();

  const [producerHeartbeat] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId, agentId: input.authorAgentId, issueId: producerIssueId,
    executionEpoch: 1, workflowStepRunId: producerRun!.id, workflowExecutionGeneration: 1,
    status: "succeeded", startedAt: producerCompletedAt, finishedAt: producerCompletedAt, createdAt: producerCompletedAt,
  }).returning();

  const wakeupId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId: input.companyId, agentId: input.verifierAgentId, source: "workflow.dispatch", workflowStepRunId: qaRun!.id });
  const hbAt = new Date(Date.now() - 15_000);
  const [verdictHeartbeat] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId, agentId: input.verifierAgentId, issueId: qaIssueId, executionEpoch: 1,
    workflowStepRunId: qaRun!.id, workflowExecutionGeneration: 1, status: "succeeded",
    wakeupRequestId: wakeupId, startedAt: hbAt, finishedAt: hbAt, createdAt: hbAt,
  }).returning();
  const [verdictEvent] = await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun!.id, issueId: qaIssueId,
    heartbeatRunId: verdictHeartbeat!.id, eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `verdict:${qaRun!.id}:${verdictHeartbeat!.id}`,
    payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaRun!.id, issueId: qaIssueId, verdict: "request_changes", reason: "term exposure", remediations: input.remediations },
  }).returning({ id: workflowTransitionEvents.id });

  return {
    companyId: input.companyId, missionId, workflowRunId: runId,
    producerStepRunId: producerRun!.id, producerIssueId,
    qaStepRunId: qaRun!.id, qaIssueId,
    verdictEventId: verdictEvent!.id, verdictHeartbeatId: verdictHeartbeat!.id,
    verifierAgentId: input.verifierAgentId,
    source: {
      companyId: input.companyId, issueId: producerIssueId, heartbeatRunId: producerHeartbeat!.id,
      executionEpoch: 1, inputHash: "ab".repeat(32),
      mission: { kind: "mission", id: missionId },
      workflow: { kind: "workflow_step", runId, stepRunId: producerRun!.id, generation: 1, dispatchAuthorityVersion: 0 },
    },
  };
}

/** 조치를 current_output 형태로 고정한다(스코프 회사 안에서만). occurrence 로 review item 을 조치에 연결한다. */
export async function reviewItemForAction(db: Db, companyId: string, source: SourceAttempt, producerRunId: string): Promise<{ reviewItemId: string; occurrenceId: string }> {
  const [review] = await db.insert(qualityReviewItems).values({
    companyId, title: "current output review", targetType: "current_output", triggerSource: "test", failureType: "missing_evidence",
  }).returning({ id: qualityReviewItems.id });
  const [occurrence] = await db.insert(qualityOccurrences).values({
    companyId, reviewItemId: review!.id, producerRunId, submissionKey: `proof-${randomUUID().slice(0, 8)}`,
    payloadHash: "44".repeat(32), sourceBinding: source, evidenceRefIds: [], occurredAt: new Date(),
  }).returning({ id: qualityOccurrences.id });
  return { reviewItemId: review!.id, occurrenceId: occurrence!.id };
}

export async function countWakeups(db: Db, companyId: string): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  return row!.c;
}
