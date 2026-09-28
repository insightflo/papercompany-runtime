// server/src/__tests__/helpers/qa-source-defect-seed.ts
//
// [purpose] QA 원천결함 라우팅 통합테스트용 시나리오 시드.
//   qa-source-defect-owner-card-integration.test.ts 와 card 확보 실패 폴백 테스트가 공유한다.

import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { buildQaSourceDefectCardRequestKey } from "../../services/workflow/qa-source-defect-owner-card.js";

export const FINDINGS_SOURCE_ONLY = [
  { id: "kr-index-missing", summary: "kr_index artifact absent from collect step", layer: "source_data" as const },
  { id: "spot-investor-empty", summary: "spot_investor rows=0 in market data", layer: "source_data" as const },
];

export const FINDINGS_MIXED = [
  ...FINDINGS_SOURCE_ONLY,
  { id: "mobile-overflow", summary: "report table overflows on mobile", layer: "artifact" as const },
];

export type QaSourceDefectSeedDb = ReturnType<typeof createDb>;

export async function seedQaSourceDefectScenario(
  db: QaSourceDefectSeedDb,
  findings: unknown[] | null,
  options?: {
    /** 직전 세대 반려 findings — 지정 시 같은 QA stepRun 에 더 이른 판정 이벤트를 적재한다(재발 감지용). */
    readonly priorFindings?: unknown[] | null;
    /** 직전 세대 판정 관측 시각(기본: 생산자 완료 이전 10분 — 세대 경계 가드 통과). */
    readonly priorObservedAt?: Date;
  },
) {
  return insertScenario(db, findings, options);
}

async function insertScenario(
  db: QaSourceDefectSeedDb,
  findings: unknown[] | null,
  options?: {
    readonly priorFindings?: unknown[] | null;
    readonly priorObservedAt?: Date;
  },
) {
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "SrcDefectCo", issuePrefix: `SD${randomUUID().slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({
    id: ownerId, companyId, name: "owner", role: "mission_owner", status: "active",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "source defect mission", status: "active" });

  // mission oversight issue — the owner-assigned continuation anchor (existing supervision invariant).
  const [oversightIssue] = await db.insert(issues).values({
    companyId, missionId, title: "[OVERSIGHT] source defect mission",
    description: "oversight", status: "todo", assigneeAgentId: ownerId,
    originKind: "mission_main_executor_oversight",
  }).returning({ id: issues.id });

  const collectIssue = await db.insert(issues).values({ companyId, missionId, title: "collect-data", description: "Collect.", status: "done", assigneeAgentId: ownerId }).returning({ id: issues.id });
  const producerIssue = await db.insert(issues).values({ companyId, missionId, title: "produce-report", description: "Produce the report.", status: "in_progress", assigneeAgentId: ownerId }).returning({ id: issues.id });
  const qaIssue = await db.insert(issues).values({ companyId, missionId, title: "qa-validate", description: "Validate.", status: "done", assigneeAgentId: ownerId }).returning({ id: issues.id });

  const steps = [
    { id: "collect", name: "Collect", agentId: ownerId, dependencies: [], graphWorkProductRequired: true },
    {
      id: "produce", name: "Produce", agentId: ownerId, dependencies: ["collect"], graphWorkProductRequired: true,
      conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }],
    },
    { id: "qa-validate", name: "QA", agentId: ownerId, dependencies: ["produce"] },
  ];
  const wfId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "src-defect-wf", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

  await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "collect", companyId, issueId: collectIssue[0]!.id,
    status: "completed", completedAt: new Date(Date.now() - 120_000),
  });
  await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "produce", companyId, issueId: producerIssue[0]!.id,
    status: "completed", iterationIndex: 0, completedAt: new Date(Date.now() - 60_000),
  });
  const [qaStepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "qa-validate", companyId, issueId: qaIssue[0]!.id, status: "failed",
  }).returning({ id: workflowStepRuns.id });

  // [qa layer feedback loop] 직전 세대 반려 이벤트(선택) — 같은 QA stepRun 행 재사용 모델에서
  //   세대별 판정이 누적되는 상황을 시드한다. 기본 관측 시각은 생산자 완료 이전(정상 재발 시나리오).
  if (options?.priorFindings) {
    const priorHeartbeatId = randomUUID();
    const priorObservedAt = options.priorObservedAt ?? new Date(Date.now() - 600_000);
    await db.insert(heartbeatRuns).values({
      id: priorHeartbeatId, companyId, agentId: ownerId, issueId: qaIssue[0]!.id, status: "succeeded",
      startedAt: new Date(priorObservedAt.getTime() - 60_000), finishedAt: priorObservedAt,
    });
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: qaStepRun!.id, issueId: qaIssue[0]!.id,
      heartbeatRunId: priorHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: priorObservedAt,
      idempotencyKey: `src-defect-verdict-prior:${qaStepRun!.id}`,
      payload: {
        kind: "workflow_validation_verdict",
        workflowRunId: runId,
        stepRunId: qaStepRun!.id,
        issueId: qaIssue[0]!.id,
        verdict: "request_changes",
        reason: "prior generation rejection.",
        findings: options.priorFindings,
      },
    });
  }

  // Official workflow_api request_changes verdict bound to a checked-out heartbeat run scoped to the QA issue.
  const qaHeartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: qaHeartbeatId, companyId, agentId: ownerId, issueId: qaIssue[0]!.id, status: "succeeded",
    startedAt: new Date(Date.now() - 30_000), finishedAt: new Date(Date.now() - 20_000),
  });
  await db.insert(workflowTransitionEvents).values({
    companyId, missionId, workflowRunId: runId, workflowStepRunId: qaStepRun!.id, issueId: qaIssue[0]!.id,
    heartbeatRunId: qaHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `src-defect-verdict:${qaStepRun!.id}`,
    payload: {
      kind: "workflow_validation_verdict",
      workflowRunId: runId,
      stepRunId: qaStepRun!.id,
      issueId: qaIssue[0]!.id,
      verdict: "request_changes",
      reason: "source data incomplete for the KR report.",
      ...(findings ? { findings } : {}),
    },
  });

  return {
    companyId, ownerId, missionId, runId, oversightIssueId: oversightIssue!.id,
    producerIssueId: producerIssue[0]!.id, qaIssueId: qaIssue[0]!.id,
    steps, requestKey: buildQaSourceDefectCardRequestKey({ workflowRunId: runId, producerStepId: "produce", iteration: 0 }),
  };
}
