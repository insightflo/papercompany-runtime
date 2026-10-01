import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, issues, missions, missionPlanArtifacts, workflowDefinitions } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";

describeQualityDb("plan policy rejection before execution side effects", () => {
  let fixture: QualityTestDb;
  beforeAll(async () => { fixture = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it.each(["deliveryVerification", "capAcceptance"])("returns a structured %s diagnostic without persisting a plan or dispatching work", async (field) => {
    const db = fixture.db;
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID(), planningIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Policy rejection", issuePrefix: companyId });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Produce artifact" });
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Planning", originKind: "mission_main_executor_plan" });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId,
      requestedBy: { actorType: "agent", actorId: ownerAgentId },
      preParsedDecision: { planningIssueId, decision: {
        missionId, missionGoal: "Produce artifact", selectedExecutionUnits: [
          { id: "work", type: "action", assigneeAgentId: ownerAgentId, sourceRef: { type: "mission_plan_unit", id: "work" }, [field]: "off" },
        ], ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
      } },
    });
    expect(result).toMatchObject({ status: "invalid", reason: "invalid_dependency_graph", diagnostics: [
      expect.objectContaining({ code: "board_only_plan_policy", message: expect.stringContaining(field) }),
    ] });
    expect(await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.companyId, companyId))).toEqual([]);
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.companyId, companyId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).map(issue => issue.id)).toEqual([planningIssueId]);
  });
});
