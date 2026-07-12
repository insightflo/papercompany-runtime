import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanDecisionSubmissions,
  missions,
  toolDefinitions,
} from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping rejected PLAN recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rejected PLAN recovery", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rejected-plan-recovery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(missionPlanDecisionSubmissions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agentToolGrants);
    await db.delete(toolDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRejectedPlan() {
    const companyId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const ownerAgentId = randomUUID();
    const editorAgentId = randomUUID();
    const liaisonAgentId = randomUUID();
    const failedRunId = randomUUID();
    const publishToolId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Rejected PLAN Recovery Company",
      issuePrefix: `RP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: editorAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "editor",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: liaisonAgentId,
        companyId,
        name: "Hermes Operations Manager",
        role: "pm",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { operatingMode: "chief_of_staff_liaison" },
        permissions: {},
      },
    ]);
    await db.insert(toolDefinitions).values({
      id: publishToolId,
      companyId,
      name: "manual-onboarding-publish",
      description: "Publish a manual onboarding entry.",
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(agentToolGrants).values([
      { companyId, agentId: editorAgentId, toolId: publishToolId, grantedBy: "test" },
      { companyId, agentId: liaisonAgentId, toolId: publishToolId, grantedBy: "test" },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Publish an onboarding concept entry",
      description: "Write and publish the onboarding entry, then verify the destination.",
      status: "planning",
    });
    await db.insert(issues).values({
      id: planIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      identifier: "RP-PLAN",
      title: "[PLAN] Publish an onboarding concept entry",
      description: "stale PLAN prompt",
      status: "blocked",
      originKind: "mission_main_executor_plan",
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "issue_status_blocked",
      startedAt: new Date("2026-07-12T14:42:51.081Z"),
      finishedAt: new Date("2026-07-12T14:44:28.973Z"),
    });
    await db.insert(missionPlanDecisionSubmissions).values({
      companyId,
      missionId,
      planningIssueId: planIssueId,
      authorAgentId: ownerAgentId,
      sourceRunId: failedRunId,
      decisionHash: "rejected-plan-decision",
      decision: { selectedExecutionUnits: [] },
      status: "rejected",
      rejectionReason: "plan_intent_coverage_failed",
      diagnostics: [{ code: "missing_publish_unit", message: "A publish unit is required." }],
    });

    return { companyId, missionId, planIssueId, editorAgentId };
  }

  it("retries a rejected blocked PLAN once per changed candidate roster", async () => {
    const fixture = await seedRejectedPlan();
    const wakeKeys: string[] = [];
    const service = missionService(db, {
      onPlanSubmissionMissing: ({ idempotencyKey }) => {
        wakeKeys.push(idempotencyKey);
      },
    });

    const first = await service.runActiveMissionOwnerSupervision({
      companyId: fixture.companyId,
      staleAfterMinutes: 1,
      applySafeActions: true,
    });

    expect(wakeKeys).toHaveLength(1);
    expect(wakeKeys[0]).toMatch(/:prompt-v2:roster-[a-f0-9]{12}$/);
    expect(first.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", resultStatus: "wakeup_requested" }),
    ]));
    const [reopenedPlan] = await db
      .select({ description: issues.description, status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.planIssueId));
    expect(reopenedPlan?.status).toBe("todo");
    expect(reopenedPlan?.description).toContain("Synthesis Editor");
    expect(reopenedPlan?.description).toContain("tools=manual-onboarding-publish");
    expect(reopenedPlan?.description).toContain("include a publish/delivery unit assigned to that candidate");
    expect(reopenedPlan?.description).toContain("If a candidate has tools but no skills in the roster");
    expect(reopenedPlan?.description).not.toContain("Hermes Operations Manager");
    const unblockIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(unblockIssues).toEqual([]);

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.planIssueId));
    await db.insert(missionPlanDecisionSubmissions).values({
      companyId: fixture.companyId,
      missionId: fixture.missionId,
      planningIssueId: fixture.planIssueId,
      authorAgentId: randomUUID(),
      decisionHash: "second-rejected-plan-decision",
      decision: { selectedExecutionUnits: [] },
      status: "rejected",
      rejectionReason: "invalid_execution_placement",
      diagnostics: [{ code: "skill_ref_not_assigned_to_assignee", message: "The tool is not a skill." }],
    });
    const unchanged = await service.runActiveMissionOwnerSupervision({
      companyId: fixture.companyId,
      staleAfterMinutes: 1,
      applySafeActions: true,
    });

    expect(wakeKeys).toHaveLength(1);
    expect(unchanged.missions[0]?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", safeToAutoApply: false }),
    ]));

    const verifyToolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: verifyToolId,
      companyId: fixture.companyId,
      name: "manual-onboarding-verify",
      description: "Verify a manual onboarding entry.",
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(agentToolGrants).values({
      companyId: fixture.companyId,
      agentId: fixture.editorAgentId,
      toolId: verifyToolId,
      grantedBy: "test",
    });

    const changed = await service.runActiveMissionOwnerSupervision({
      companyId: fixture.companyId,
      staleAfterMinutes: 1,
      applySafeActions: true,
    });

    expect(wakeKeys).toHaveLength(2);
    expect(wakeKeys[1]).not.toBe(wakeKeys[0]);
    expect(changed.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", resultStatus: "wakeup_requested" }),
    ]));
  });
});
