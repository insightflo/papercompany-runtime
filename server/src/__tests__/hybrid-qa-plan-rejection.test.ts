import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants, agents, companies, createDb, issues, missions, toolDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { recordMissionOwnerPlanDecisionSubmission } from "../services/missions/mission-plan-decision-submissions.js";
import { STRUCTURAL_VALIDATION_CAPABILITY } from "../services/workflow/control-flow/structural-gate-readiness.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping PLAN-side-effect rejection tests: ${support.reason ?? "unsupported"}`);
}

// [ purpose ] Before PLAN-QA issue/wakeup/materialization, an invalid declared
//   structural plan is rejected with public status:"invalid" and reason
//   "structural_plan_validation_failed" (never "invalid_plan"), and NO PLAN-QA
//   side effect (issue) is created. The plans below pass the pre-existing
//   source-ref + execution-placement validations (assignee is a known granted
//   agent) so that the STRUCTURAL validation is the rejector. A valid structural
//   plan still proceeds (no over-rejection).
describeEP("hybrid QA — pre-PLAN structural rejection (PLAN-QA side-effect guard)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-plan-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  // Seeds a company whose plans pass source-ref + placement validation: the
  // owner agent is active and is granted both a capability-bearing tool and a
  // capability-less tool, so structural validation is the only remaining gate.
  async function seed() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Plan Reject Co", status: "active",
      issuePrefix: `PR${randomUUID().slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Mission Owner", role: "operator",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId, title: "Structural gate mission",
      description: "Select an executable plan.", status: "active",
    });
    await db.insert(issues).values({
      id: planningIssueId, companyId, missionId, title: "Mission owner planning",
      originKind: "mission_main_executor_plan", status: "todo",
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [],
    });

    const capToolId = randomUUID();
    const noCapToolId = randomUUID();
    const capToolName = `struct-cap-${randomUUID().slice(0, 6)}`;
    const noCapToolName = `no-cap-${randomUUID().slice(0, 6)}`;
    await db.insert(toolDefinitions).values([
      { id: capToolId, companyId, name: capToolName, description: "", adapterType: "builtin",
        adapterConfig: { capabilities: [STRUCTURAL_VALIDATION_CAPABILITY] }, enabled: true },
      { id: noCapToolId, companyId, name: noCapToolName, description: "", adapterType: "builtin",
        adapterConfig: { capabilities: [] }, enabled: true },
    ]);
    await db.insert(agentToolGrants).values([
      { id: randomUUID(), companyId, agentId: ownerAgentId, toolId: capToolId, grantedBy: "test" },
      { id: randomUUID(), companyId, agentId: ownerAgentId, toolId: noCapToolId, grantedBy: "test" },
    ]);
    return { companyId, ownerAgentId, missionId, planningIssueId, capToolName, noCapToolName };
  }

  async function postDecision(companyId: string, planningIssueId: string, ownerAgentId: string, missionId: string, units: Record<string, unknown>[]) {
    return recordMissionOwnerPlanDecisionSubmission({
      db,
      companyId,
      missionId,
      planningIssueId,
      requestedBy: { actorType: "agent", actorId: ownerAgentId },
      decision: {
        missionId,
        missionGoal: "Validate structural gating",
        selectedExecutionUnits: units,
        ruleRefs: [],
        kbRefs: [],
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      },
    });
  }

  async function countCompanyIssues(companyId: string): Promise<number> {
    const rows = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId));
    return rows.length;
  }

  const producerUnit = (ownerAgentId: string) => ({
    id: "unit-source-1", kind: "mission_plan_unit", title: "[ACTION] Produce",
    assigneeAgentId: ownerAgentId, selectionState: "selected",
    sourceRef: { type: "mission_plan_unit", id: "unit-source-1" }, dependsOn: [],
  });
  const gateUnit = (ownerAgentId: string, toolName: string) => ({
    id: "unit-gate-1", kind: "mission_plan_unit", type: "tool", qaType: "structural",
    title: "[QA] Structural gate", assigneeAgentId: ownerAgentId, selectionState: "selected",
    toolNames: [toolName], sourceRef: { type: "mission_plan_unit", id: "unit-gate-1" },
    dependsOn: ["unit-source-1"],
  });

  it("rejects a gate tool lacking the capability before PLAN-QA side effects", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, noCapToolName } = await seed();
    const before = await countCompanyIssues(companyId);
    const result = await postDecision(companyId, planningIssueId, ownerAgentId, missionId, [
      producerUnit(ownerAgentId), gateUnit(ownerAgentId, noCapToolName),
    ]);

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("expected invalid");
    expect(result.reason).toBe("structural_plan_validation_failed");
    expect(result.reason).not.toBe("invalid_plan");
    // No PLAN-QA side-effect issue was created.
    expect(await countCompanyIssues(companyId)).toBe(before);
  });

  it("rejects bad gate topology (QA omits a related gate) before PLAN-QA side effects", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, capToolName } = await seed();
    const result = await postDecision(companyId, planningIssueId, ownerAgentId, missionId, [
      producerUnit(ownerAgentId),
      gateUnit(ownerAgentId, capToolName),
      { id: "unit-qa-1", kind: "mission_plan_unit", title: "[QA] Semantic review",
        assigneeAgentId: ownerAgentId, selectionState: "selected",
        sourceRef: { type: "mission_plan_unit", id: "unit-qa-1" }, dependsOn: ["unit-source-1"] },
    ]);

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("expected invalid");
    expect(result.reason).toBe("structural_plan_validation_failed");
  });

  it("a valid structural plan still proceeds (no over-rejection)", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, capToolName } = await seed();
    const result = await postDecision(companyId, planningIssueId, ownerAgentId, missionId, [
      producerUnit(ownerAgentId),
      gateUnit(ownerAgentId, capToolName),
      { id: "unit-qa-1", kind: "mission_plan_unit", title: "[QA] Semantic review",
        assigneeAgentId: ownerAgentId, selectionState: "selected",
        sourceRef: { type: "mission_plan_unit", id: "unit-qa-1" },
        dependsOn: ["unit-source-1", "unit-gate-1"] },
    ]);

    expect(result.status).not.toBe("invalid");
  });
});
