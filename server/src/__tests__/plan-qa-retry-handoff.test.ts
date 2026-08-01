// PLAN-QA retry handoff (slice A): a request_changes verdict must reopen the PLAN with the
// original mission instruction + complete prior decision + EXACT structured diagnostics, and
// never collapse them to an empty array or a generic fallback. Source-to-retry: real verdict
// row → recordLatestAuthorizedMissionOwnerPlanDecision → reopened PLAN issue description.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionPlanQaVerdicts,
  missions,
  qualityReviewItems,
  workflowDefinitions,
} from "@paperclipai/db";
import { recordLatestAuthorizedMissionOwnerPlanDecision, reopenPlanningIssueForPlanChanges } from "../services/mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { recordMissionOwnerPlanDecisionSubmission } from "../services/missions/mission-plan-decision-submissions.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip PLAN-QA retry handoff tests: ${support.reason ?? "unsupported"}`);

function structuralStyleDescription(extra: string): string {
  // Mirrors a structurally-rejected PLAN description: planning content, a LEGACY sentinel-less
  // revision baseline mid-description, then the decision shape + roster that must survive.
  return [
    "ORIGINAL-INSTRUCTION-MARKER: publish the beginner guide to the onboarding site.",
    "",
    "## Planning method",
    "- Decompose the outcome into execution units.",
    "",
    "## Revision baseline",
    "A previous Mission owner plan decision was rejected. Revise that decision rather than starting over.",
    "```json",
    JSON.stringify({ selectedExecutionUnits: [{ id: "unit-legacy-prior" }] }, null, 2),
    "```",
    "",
    "## Requested corrections",
    "- `plan_qa_legacy_gap`: Legacy gap that must be replaced by the latest verdict.",
    "",
    "## Required decision shape (structured submission)",
    "Submit via POST /api/issues/{planningIssueId}/mission-plan-decision",
    "",
    "## Available runnable company roster",
    "- owner agent (operator, active)",
    ...(extra ? [extra] : []),
  ].join("\n");
}

describeEP("PLAN-QA retry handoff", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-qa-retry-handoff-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(qualityReviewItems);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(missionPlanDecisionSubmissions);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(missionPlanArtifacts);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PlanQA Retry Co", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
      { id: qaAgentId, companyId, name: "Plan QA Reviewer", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    ]);
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Source WF", stepsJson: [{ id: "scout", name: "Scout", dependencies: [] }] });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan QA mission", description: "Select an executable plan for the original business request.", status: "active" });
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Mission owner planning", originKind: "mission_main_executor_plan", status: "todo" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    return { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId };
  }

  async function postDecision(f: Awaited<ReturnType<typeof seedFixture>>, unitId: string) {
    return recordMissionOwnerPlanDecisionSubmission({
      db,
      companyId: f.companyId,
      missionId: f.missionId,
      planningIssueId: f.planningIssueId,
      requestedBy: { actorType: "agent", actorId: f.ownerAgentId },
      decision: {
        missionId: f.missionId,
        missionGoal: "Ship controlled rollout",
        selectedExecutionUnits: [{
          id: unitId, kind: "workflow_definition_step", title: "Run smoke", reason: "source evidence",
          selectionState: "selected", sourceRef: { type: "workflow_definition_step", id: f.sourceWorkflowId, stepId: "scout" },
        }],
        ruleRefs: ["rule:security"], kbRefs: ["kb:rollout"], requiredInputs: ["stagingUrl"], successCriteria: ["smoke passes"], steps: [{ id: "step-1", title: "Verify staging" }],
      },
    });
  }

  async function activePlanQa(companyId: string, missionId: string) {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    if (!planQa?.issueId) throw new Error("no active PLAN-QA issue");
    return planQa;
  }

  it("forwards exact structured request_changes diagnostics into the reopened PLAN (sourceCommentId null)", async () => {
    const f = await seedFixture();
    const first = await postDecision(f, "unit-publish-distinctive");
    expect(first.status).toBe("plan_qa_pending");
    const planQa = await activePlanQa(f.companyId, f.missionId);

    // Realistic planning description carrying the original instruction + decision shape + roster.
    await db.update(issues).set({ description: structuralStyleDescription("") }).where(eq(issues.id, f.planningIssueId));

    await recordMissionPlanQaVerdict({
      db, companyId: f.companyId, missionId: f.missionId, planQaIssueId: planQa.issueId!,
      decisionHash: planQa.decisionHash ?? first.decisionHash ?? "", verdict: "request_changes",
      diagnostics: [{ code: "plan_qa_distinctive_gap", message: "Distinctive QA gap that must be forwarded" }],
      reviewedBy: { actorType: "agent", actorId: f.qaAgentId },
    });

    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });
    expect(second.status).toBe("plan_qa_changes_requested");

    const [reopened] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(reopened.status).toBe("todo");
    // (1) original mission instruction preserved
    expect(reopened.description).toContain("ORIGINAL-INSTRUCTION-MARKER");
    // (2) complete prior decision (exact prior unit id) forwarded
    expect(reopened.description).toContain("unit-publish-distinctive");
    // (3) exact structured diagnostics forwarded
    expect(reopened.description).toContain("plan_qa_distinctive_gap");
    expect(reopened.description).toContain("Distinctive QA gap that must be forwarded");
    // no generic fallback
    expect(reopened.description).not.toContain("No specific correction codes");
    // decision shape + roster preserved (not cut by the revision append)
    expect(reopened.description).toContain("## Required decision shape (structured submission)");
    expect(reopened.description).toContain("## Available runnable company roster");

    // Ledger submission + result carry the exact diagnostic (not an empty array).
    expect(second.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "plan_qa_distinctive_gap", message: "Distinctive QA gap that must be forwarded" }),
    ]));
    const [sub] = await db.select().from(missionPlanDecisionSubmissions)
      .where(and(eq(missionPlanDecisionSubmissions.companyId, f.companyId), eq(missionPlanDecisionSubmissions.missionId, f.missionId)))
      .orderBy(desc(missionPlanDecisionSubmissions.updatedAt));
    expect(sub.diagnostics as Array<Record<string, unknown>>).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "plan_qa_distinctive_gap" }),
    ]));
  });

  it("ignores legacy sourceCommentId PLAN-QA rows (display/audit only, no retry authority)", async () => {
    const f = await seedFixture();
    const first = await postDecision(f, "unit-source-comment-case");
    expect(first.status).toBe("plan_qa_pending");
    const planQa = await activePlanQa(f.companyId, f.missionId);
    await db.update(issues).set({ description: structuralStyleDescription("") }).where(eq(issues.id, f.planningIssueId));

    // Legacy comment-derived ledger rows are not execution authority.
    await db.insert(missionPlanQaVerdicts).values({
      companyId: f.companyId, missionId: f.missionId, planQaIssueId: planQa.issueId!,
      decisionHash: planQa.decisionHash ?? first.decisionHash ?? "", verdict: "request_changes",
      diagnostics: [{ code: "plan_qa_sourcecomment_gap", message: "Diagnostic from a sourceCommentId structured row" }],
      sourceCommentId: randomUUID(), reviewerAgentId: f.qaAgentId,
    });

    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });
    expect(second.status).not.toBe("plan_qa_changes_requested");
    const [planning] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(planning.description ?? "").not.toContain("plan_qa_sourcecomment_gap");
  });

  it("replaces a legacy structural revision baseline instead of duplicating it, preserving decision shape + roster", async () => {
    const f = await seedFixture();
    const first = await postDecision(f, "unit-second-attempt");
    expect(first.status).toBe("plan_qa_pending");
    const planQa = await activePlanQa(f.companyId, f.missionId);
    await db.update(issues).set({ description: structuralStyleDescription("") }).where(eq(issues.id, f.planningIssueId));

    await recordMissionPlanQaVerdict({
      db, companyId: f.companyId, missionId: f.missionId, planQaIssueId: planQa.issueId!,
      decisionHash: planQa.decisionHash ?? first.decisionHash ?? "", verdict: "request_changes",
      diagnostics: [{ code: "plan_qa_new_gap", message: "Latest verdict gap" }],
      reviewedBy: { actorType: "agent", actorId: f.qaAgentId },
    });

    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });
    expect(second.status).toBe("plan_qa_changes_requested");

    const [reopened] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    // Exactly one revision baseline — the legacy block was replaced, not duplicated.
    expect(reopened.description.split("## Revision baseline").length - 1).toBe(1);
    // The latest diagnostic wins; the legacy diagnostic is gone.
    expect(reopened.description).toContain("plan_qa_new_gap");
    expect(reopened.description).toContain("Latest verdict gap");
    expect(reopened.description).not.toContain("plan_qa_legacy_gap");
    expect(reopened.description).not.toContain("Legacy gap that must be replaced");
    // Decision shape + roster preserved.
    expect(reopened.description).toContain("## Required decision shape (structured submission)");
    expect(reopened.description).toContain("## Available runnable company roster");
  });

  it("does not leak a foreign company's PLAN-QA verdict into this mission's retry (company-scoped read)", async () => {
    const f = await seedFixture();
    const first = await postDecision(f, "unit-owner-scope");
    expect(first.status).toBe("plan_qa_pending");
    const planQa = await activePlanQa(f.companyId, f.missionId);

    // Foreign company inserts a verdict row referencing THIS plan-QA issue id with a distinctive
    // diagnostic. The company-scoped read must ignore it (no request_changes for this company).
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign Co", issuePrefix: `FC${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(missionPlanQaVerdicts).values({
      companyId: foreignCompanyId, missionId: randomUUID(), planQaIssueId: planQa.issueId!,
      decisionHash: planQa.decisionHash ?? first.decisionHash ?? "", verdict: "request_changes",
      diagnostics: [{ code: "foreign-leak-diagnostic", message: "must not appear in the owner company retry" }],
      reviewerAgentId: f.qaAgentId,
    });

    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });
    // Foreign verdict does not satisfy this company → still pending, no reopen with foreign content.
    expect(second.status).toBe("plan_qa_pending");
    const [planning] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(planning.description ?? "").not.toContain("foreign-leak-diagnostic");
  });
  it("does not mutate the planning issue when companyId or missionId does not match (scoped reopen)", async () => {
    const f = await seedFixture();
    // Plant a terminal planning issue so the terminal UPDATE path is the one that could mutate.
    await db.update(issues).set({ status: "done", description: "PROTECTED-DESCRIPTION" }).where(eq(issues.id, f.planningIssueId));
    const priorDecision = { selectedExecutionUnits: [{ id: "unit-scope" }] };
    const diagnostics = [{ code: "plan_qa_scope_gap", message: "must not apply under a mismatched scope" }];

    // Wrong missionId (companyId correct) → SELECT/UPDATE predicates match no row → no mutation.
    const wrongMission = await reopenPlanningIssueForPlanChanges({ db, companyId: f.companyId, missionId: randomUUID(), planningIssueId: f.planningIssueId, priorDecision, diagnostics });
    expect(wrongMission).toBeNull();
    let [issue] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(issue.status).toBe("done");
    expect(issue.description).toBe("PROTECTED-DESCRIPTION");

    // Wrong companyId (missionId correct) → no mutation.
    const wrongCompany = await reopenPlanningIssueForPlanChanges({ db, companyId: randomUUID(), missionId: f.missionId, planningIssueId: f.planningIssueId, priorDecision, diagnostics });
    expect(wrongCompany).toBeNull();
    [issue] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(issue.status).toBe("done");
    expect(issue.description).toBe("PROTECTED-DESCRIPTION");

    // Control: correct scope mutates (reopens terminal → todo, appends revision baseline).
    const ok = await reopenPlanningIssueForPlanChanges({ db, companyId: f.companyId, missionId: f.missionId, planningIssueId: f.planningIssueId, priorDecision, diagnostics });
    expect(ok).not.toBeNull();
    [issue] = await db.select().from(issues).where(eq(issues.id, f.planningIssueId));
    expect(issue.status).toBe("todo");
    expect(issue.description).toContain("PROTECTED-DESCRIPTION");
    expect(issue.description).toContain("plan_qa_scope_gap");
  });
});
