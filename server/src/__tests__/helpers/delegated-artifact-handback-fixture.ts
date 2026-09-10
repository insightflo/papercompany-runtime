import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  issueComments,
  issues,
  issueWorkProducts,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";

const CHILD_ARTIFACT_PATH =
  "/srv/papercompany/projects/gazua-addon/produced_work/missions/m/runs/r/steps/strategy/report.md";
const PARENT_ARTIFACT_PATH =
  "/srv/papercompany/projects/gazua-addon/produced_work/missions/m/runs/r/steps/strategy/parent.md";

export type DelegatedArtifactSeed = {
  readonly assigneeAgentId: string;
  readonly childIssueId: string;
  readonly childWorkProductId: string;
  readonly companyId: string;
  readonly parentIssueId: string;
  readonly parentStepRunId: string;
  readonly workflowDefinitionId: string;
  readonly workflowRunId: string;
};

type DelegatedArtifactSeedOptions = {
  readonly parentOriginKind?: string;
  readonly parentHasWorkProduct?: boolean;
  readonly parentStatus?: string;
  /** [Task5a2c] 제공 시 run 을 실제 store.createWorkflowRun 으로 생성해 실행정의 스냅샷을 캡처하고
   *  이후 테스트 상태(status)만 복원한다. 생략 시 기존 legacy raw insert 동작이 그대로 유지된다. */
  readonly frozenSteps?: unknown[];
  /** frozenSteps 사용 시 parent issue 가 바인딩될 captured parent step id(기본 legacy "strategy"). */
  readonly parentStepId?: string;
};

type WakeupOptions = Parameters<IssueAssignmentWakeupDeps["wakeup"]>[1];

export async function clearDelegatedArtifactHandbackTestData(db: Db): Promise<void> {
  await db.delete(activityLog);
  await db.delete(agentWakeupRequests);
  await db.delete(issueComments);
  await db.delete(issueWorkProducts);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(issues);
  await db.delete(missions);
  await db.delete(agents);
  await db.delete(companies);
}

export async function seedDelegatedArtifactCase(
  db: Db,
  input: DelegatedArtifactSeedOptions = {},
): Promise<DelegatedArtifactSeed> {
  const companyId = randomUUID();
  const assigneeAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowDefinitionId = randomUUID();
  let workflowRunId = randomUUID();
  const parentIssueId = randomUUID();
  const childIssueId = randomUUID();
  const childWorkProductId = randomUUID();
  const parentStepRunId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Gazua",
    issuePrefix: "GAZ",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: assigneeAgentId,
    companyId,
    name: "Zhuge Liang",
    role: "strategist",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: assigneeAgentId,
    title: "gazua-morning",
    status: "active",
  });
  await db.insert(workflowDefinitions).values({
    id: workflowDefinitionId,
    companyId,
    name: "gazua-morning",
    stepsJson: input.frozenSteps ?? [{ id: "strategy", name: "Strategy", dependencies: [] }],
  });
  if (input.frozenSteps) {
    // [Task5a2c] 원자적 run+스냅샷 캡처(실제 store 경로, mock/hash 위조 없음). 생성은 pending 이므로
    //  테스트가 요구하는 기존 상태값(failed)만 복원한다. 이후 모든 참조는 반환된 id 를 쓴다.
    const created = await createWorkflowRun(db, {
      workflowId: workflowDefinitionId,
      companyId,
      missionId,
      triggeredBy: "system",
    });
    workflowRunId = created.id;
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, workflowRunId));
  } else {
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId: workflowDefinitionId,
      companyId,
      missionId,
      status: "failed",
      triggeredBy: "system",
    });
  }
  await db.insert(issues).values([
    {
      id: parentIssueId,
      companyId,
      missionId,
      identifier: "GAZ-260",
      title: "Strategy",
      status: input.parentStatus ?? "blocked",
      assigneeAgentId,
      originKind: input.parentOriginKind ?? "workflow_execution",
      originId: workflowRunId,
      originRunId: workflowRunId,
    },
    {
      id: childIssueId,
      companyId,
      missionId,
      parentId: parentIssueId,
      identifier: "GAZ-261",
      title: "Delegated strategy writeup",
      status: "done",
      assigneeAgentId,
      originKind: "manual",
    },
  ]);
  await db.insert(workflowStepRuns).values({
    id: parentStepRunId,
    workflowRunId,
    stepId: input.parentStepId ?? "strategy",
    issueId: parentIssueId,
    status: "failed",
    startedAt: new Date("2026-07-07T22:20:00.000Z"),
  });
  await db.insert(issueWorkProducts).values({
    id: childWorkProductId,
    companyId,
    issueId: childIssueId,
    type: "document",
    provider: "local",
    externalId: CHILD_ARTIFACT_PATH,
    title: "KR_Dashboard_Insight_Briefing_2026-07-08.md",
    status: "active",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    metadata: { path: CHILD_ARTIFACT_PATH },
  });
  if (input.parentHasWorkProduct) {
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId: parentIssueId,
      type: "document",
      provider: "local",
      externalId: PARENT_ARTIFACT_PATH,
      title: "parent.md",
      status: "active",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "unknown",
      metadata: { path: PARENT_ARTIFACT_PATH },
    });
  }

  return {
    assigneeAgentId,
    childIssueId,
    childWorkProductId,
    companyId,
    parentIssueId,
    parentStepRunId,
    workflowDefinitionId,
    workflowRunId,
  };
}

export function captureWakeups(): {
  readonly heartbeat: IssueAssignmentWakeupDeps;
  readonly wakeups: Array<{ readonly agentId: string; readonly opts: WakeupOptions }>;
} {
  const wakeups: Array<{ readonly agentId: string; readonly opts: WakeupOptions }> = [];
  const heartbeat: IssueAssignmentWakeupDeps = {
    wakeup: async (agentId, opts) => {
      wakeups.push({ agentId, opts });
      return { id: "queued-run" };
    },
  };
  return { heartbeat, wakeups };
}
