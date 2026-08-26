import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  hashOwnerPlanDecision,
  recordLatestAuthorizedMissionOwnerPlanDecision,
} from "../../services/mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";

export async function cleanupPaqoImmutabilityTables(db: Db): Promise<void> {
  await db.delete(activityLog);
  await db.delete(heartbeatRunEvents);
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(agentRuntimeState);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(issueComments);
  await db.delete(issues);
  await db.delete(workflowDefinitions);
  await db.delete(plugins);
  await db.delete(missions);
  await db.delete(agents);
  await db.delete(companies);
}

export async function seedPaqoMissionFixture(db: Db, goal: string) {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const otherAgentId = randomUUID();
  const missionId = randomUUID();
  const planningIssueId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: `Paqo Immutability Co ${goal}`,
    issuePrefix: `PI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    {
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    },
    {
      id: otherAgentId,
      companyId,
      name: "Other Agent",
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    },
  ]);
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId,
    title: `Mission ${goal}`,
    status: "active",
  });
  await db.insert(issues).values({
    id: planningIssueId,
    companyId,
    missionId,
    title: "Mission owner planning",
    originKind: "mission_main_executor_plan",
    status: "todo",
  });
  await missionPlanArtifactService(db).createInitialMissionPlan({
    companyId,
    missionId,
    refs: {},
    requiredInputs: [],
    successCriteria: [],
    steps: [],
  });

  return { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId };
}

export function buildPaqoDecision(
  fixture: { missionId: string; ownerAgentId: string; otherAgentId: string },
  goal: string,
  unitTitles: string[],
) {
  const { missionId, ownerAgentId, otherAgentId } = fixture;
  return {
    missionId,
    missionGoal: goal,
    selectedExecutionUnits: unitTitles.map((title, index) => ({
      id: `unit-${index + 1}`,
      kind: "mission_plan_unit",
      title,
      assigneeAgentId: index % 2 === 0 ? otherAgentId : ownerAgentId,
      sourceRef: { type: "mission_plan_unit", id: `unit-${index + 1}` },
      ...(index > 0 ? { dependsOn: [`unit-${index}`] } : {}),
    })),
    ruleRefs: [],
    kbRefs: [],
    requiredInputs: [],
    successCriteria: [`${goal} done`],
    steps: unitTitles.map((title) => ({ id: title, title })),
  };
}

export async function materializePaqoPlan(
  db: Db,
  opts: {
    companyId: string;
    missionId: string;
    planningIssueId: string;
    ownerAgentId: string;
    decision: Record<string, unknown>;
  },
) {
  await upsertMissionPlanDecisionSubmission({
    db,
    companyId: opts.companyId,
    missionId: opts.missionId,
    planningIssueId: opts.planningIssueId,
    decision: opts.decision,
    decisionHash: hashOwnerPlanDecision(opts.decision as Parameters<typeof hashOwnerPlanDecision>[0]),
    authorAgentId: opts.ownerAgentId,
    status: "submitted",
  });
  let result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: opts.companyId, missionId: opts.missionId });
  if (result.status === "plan_qa_pending") {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: opts.companyId, missionId: opts.missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    if (planQa?.issueId && planQa.decisionHash) {
      await recordMissionPlanQaVerdict({
        db,
        companyId: opts.companyId,
        missionId: opts.missionId,
        planQaIssueId: planQa.issueId,
        decisionHash: planQa.decisionHash,
        verdict: "pass",
        reviewedBy: { actorType: "user", actorId: "board-user-test" },
      });
    }
    result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: opts.companyId, missionId: opts.missionId });
  }
  return result;
}

export async function paqoDefinitionsFor(db: Db, companyId: string) {
  return db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.sourceKind, "paqo")));
}
