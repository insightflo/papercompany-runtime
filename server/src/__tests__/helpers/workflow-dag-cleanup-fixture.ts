import { instanceSettings, workflowTransitionEvents, activityLog, heartbeatRuns, agentWakeupRequests, issueWorkProducts, workflowDelegations, workflowStepRuns, workflowRuns, workflowDefinitions, pluginEntities, plugins, issueComments, issues, missionPlanArtifacts, missions, agents, companies, type createDb } from "@paperclipai/db";

export async function cleanWorkflowDagFixture(db: ReturnType<typeof createDb>) {
    await db.delete(instanceSettings);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowDelegations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
}
