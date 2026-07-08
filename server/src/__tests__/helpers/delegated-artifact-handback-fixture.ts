import { randomUUID } from "node:crypto";
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
  readonly workflowRunId: string;
};

type DelegatedArtifactSeedOptions = {
  readonly parentOriginKind?: string;
  readonly parentHasWorkProduct?: boolean;
  readonly parentStatus?: string;
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
  const workflowRunId = randomUUID();
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
    stepsJson: [{ id: "strategy", name: "Strategy", dependencies: [] }],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId,
    workflowId: workflowDefinitionId,
    companyId,
    missionId,
    status: "failed",
    triggeredBy: "system",
  });
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
    stepId: "strategy",
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
