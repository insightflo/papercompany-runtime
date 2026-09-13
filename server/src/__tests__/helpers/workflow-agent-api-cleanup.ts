import {
  activityLog, agents, assets, companies, heartbeatRuns, issueComments, issueWorkProducts,
  issues, missionPlanArtifacts, missionPlanQaVerdicts, missions, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";

// Only for the caller-owned, isolated workflow-agent API test database.
// T7 PLAN-QA pinning now creates attachments/assets; issue deletion cascades attachment links.
export async function clearWorkflowAgentApiTestDb(db: Db) {
  await db.delete(activityLog);
  await db.delete(workflowTransitionEvents);
  await db.delete(issueWorkProducts);
  await db.delete(issueComments);
  await db.delete(missionPlanQaVerdicts);
  await db.delete(heartbeatRuns);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(issues);
  await db.delete(missionPlanArtifacts);
  await db.delete(missions);
  await db.delete(assets);
  await db.delete(agents);
  await db.delete(companies);
}
