import { activityLog, missionDelegations, issueWorkProducts, pluginEntities, missionPlanArtifacts, missionSessions, workflowStepRuns, heartbeatRunEvents, heartbeatRuns, agentWakeupRequests, workflowRuns, workflowDefinitions, plugins, issueComments, issues, missions, agentRuntimeState, companySecrets, companySkills, assets, agents, companies, type createDb } from "@paperclipai/db";

export async function cleanMissionServiceFixture(db: ReturnType<typeof createDb>) {
    await db.delete(activityLog);
    await db.delete(missionDelegations);
    await db.delete(issueWorkProducts);
    await db.delete(pluginEntities);
    await db.delete(missionPlanArtifacts);
    await db.delete(missionSessions);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySecrets);
    await db.delete(companySkills);
    // assets 는 companies(company_id) 와 agents(created_by_agent_id) 를 참조하므로
    // 두 부모 테이블보다 먼저 비운다(첨부 FK teardown 누락 수정).
    await db.delete(assets);
    await db.delete(agents);
    await db.delete(companies);
}
