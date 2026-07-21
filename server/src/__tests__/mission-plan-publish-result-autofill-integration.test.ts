import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants, agents, activityLog, companies, createDb, issues, missions, toolDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping publish-result autofill integration tests: ${support.reason ?? "unsupported"}`);
}

// [ purpose ] The authoritative record path applies the bounded
//   manual-onboarding publish-result autofill exactly once after source-ref
//   and execution-placement validation succeed, before PLAN-QA / intent
//   coverage / structural validation / materialization observe the draft.
//   A plan that would otherwise fail with `missing_manual_onboarding_verify_tool`
//   (subcode of `plan_intent_coverage_failed`) because the verifier omits
//   `publishResultPath` now proceeds past the intent gate, the active plan
//   carries the canonical reference, and the activity log payload is bounded
//   to identifiers only (no toolArgs leak).
describeEP("mission.plan.autofilled — authoritative path integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("publish-autofill-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Autofill Co", status: "active",
      issuePrefix: `AF${randomUUID().slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Mission Owner", role: "operator",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId,
      title: "Publish the site update",
      description: "Deploy via manual onboarding and verify the published destination.",
      status: "active",
    });
    await db.insert(issues).values({
      id: planningIssueId, companyId, missionId, title: "Mission owner planning",
      originKind: "mission_main_executor_plan", status: "todo",
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [],
    });

    const publishToolId = randomUUID();
    const verifyToolId = randomUUID();
    await db.insert(toolDefinitions).values([
      { id: publishToolId, companyId, name: "manual-onboarding-publish", description: "", adapterType: "builtin", adapterConfig: {}, enabled: true },
      { id: verifyToolId, companyId, name: "manual-onboarding-verify", description: "", adapterType: "builtin", adapterConfig: {}, enabled: true },
    ]);
    await db.insert(agentToolGrants).values([
      { id: randomUUID(), companyId, agentId: ownerAgentId, toolId: publishToolId, grantedBy: "test" },
      { id: randomUUID(), companyId, agentId: ownerAgentId, toolId: verifyToolId, grantedBy: "test" },
    ]);
    return { companyId, ownerAgentId, missionId, planningIssueId };
  }

  function decisionWithMissingPublishResultPath(ownerAgentId: string, missionId: string) {
    return {
      missionId,
      missionGoal: "Publish and verify",
      selectedExecutionUnits: [
        {
          id: "unit-build", kind: "mission_plan_unit", title: "[ACTION] Build artifact",
          assigneeAgentId: ownerAgentId, selectionState: "selected", reason: "produce the deliverable",
          sourceRef: { type: "mission_plan_unit", id: "unit-build" },
          dependsOn: [], toolNames: [], toolArgs: {}, knowledgeBaseIds: [], skillRefs: [],
          graphWorkProductRequired: true,
        },
        {
          id: "unit-artifact-qa", kind: "mission_plan_unit", title: "[QA] Artifact review",
          assigneeAgentId: ownerAgentId, selectionState: "selected", reason: "review the artifact",
          sourceRef: { type: "mission_plan_unit", id: "unit-artifact-qa" },
          dependsOn: ["unit-build"], toolNames: [], toolArgs: {}, knowledgeBaseIds: [], skillRefs: [],
          graphWorkProductRequired: false,
        },
        {
          id: "publish", kind: "mission_plan_unit", title: "[ACTION] Publish via manual onboarding",
          assigneeAgentId: ownerAgentId, selectionState: "selected", reason: "deliver to the destination",
          sourceRef: { type: "mission_plan_unit", id: "publish" },
          dependsOn: ["unit-artifact-qa"],
          toolNames: ["manual-onboarding-publish"], toolArgs: {}, knowledgeBaseIds: [], skillRefs: [],
          graphWorkProductRequired: true,
        },
        {
          id: "verify", kind: "mission_plan_unit", title: "[QA] Verify published destination readback",
          assigneeAgentId: ownerAgentId, selectionState: "selected", reason: "verify the published result",
          sourceRef: { type: "mission_plan_unit", id: "verify" },
          dependsOn: ["publish"],
          toolNames: ["manual-onboarding-verify"],
          toolArgs: { timeoutMs: 5000 },
          knowledgeBaseIds: [], skillRefs: [],
          graphWorkProductRequired: false,
        },
      ],
      ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    };
  }

  it("autofills publishResultPath and proceeds past the intent-coverage gate", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seed();
    const decision = decisionWithMissingPublishResultPath(ownerAgentId, missionId);

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId,
      missionId,
      preParsedDecision: { decision, planningIssueId, commentId: "structured-submission" },
    });

    // Without autofill the verifier's missing publishResultPath would surface as
    // missing_manual_onboarding_verify_tool under plan_intent_coverage_failed.
    expect(result.status).not.toBe("invalid");
    if (result.status === "invalid") throw new Error("expected non-invalid status");

    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan).toBeTruthy();
    const refs = (activePlan?.refs ?? {}) as Record<string, unknown>;
    const units = (refs.selectedExecutionUnits ?? []) as Array<Record<string, unknown>>;
    const verifyUnit = units.find((u) => u.id === "verify");
    expect(verifyUnit?.toolArgs).toMatchObject({
      timeoutMs: 5000,
      publishResultPath: "{$steps.publish.workProductPath}",
    });

    const autofillActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.plan.autofilled"));
    expect(autofillActivities.length).toBe(1);
    const activity = autofillActivities[0]!;
    expect(activity.details).toEqual(expect.objectContaining({
      planningIssueId,
      publisherUnitId: "publish",
      verifierUnitId: "verify",
      field: "publishResultPath",
    }));
    const detailsJson = JSON.stringify(activity.details);
    expect(detailsJson).not.toContain("toolArgs");
    expect(detailsJson).not.toContain("workProductPath");
  });

  it("does not log autofill activity when the canonical path is already present", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seed();
    const decision = decisionWithMissingPublishResultPath(ownerAgentId, missionId);
    // Pre-populate the canonical reference so autofill is a no-op.
    const verifyUnit = decision.selectedExecutionUnits[3]!;
    verifyUnit.toolArgs = { timeoutMs: 5000, publishResultPath: "{$steps.publish.workProductPath}" };

    const beforeCount = (await db.select().from(activityLog).where(eq(activityLog.action, "mission.plan.autofilled"))).length;
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db, companyId, missionId,
      preParsedDecision: { decision, planningIssueId, commentId: "structured-submission-noop" },
    });
    expect(result.status).not.toBe("invalid");
    const afterCount = (await db.select().from(activityLog).where(eq(activityLog.action, "mission.plan.autofilled"))).length;
    expect(afterCount).toBe(beforeCount);
  });
});
