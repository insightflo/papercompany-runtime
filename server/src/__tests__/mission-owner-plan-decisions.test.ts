import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missionDelegations,
  missionPlanArtifacts,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  buildMissionOwnerPlanRevisionDraft,
  findLatestAuthorizedMissionOwnerPlanDecision,
  parseMissionOwnerPlanDecision,
  recordLatestAuthorizedMissionOwnerPlanDecision,
} from "../services/mission-owner-plan-decisions.js";
import { setMissionPlanQaCritiqueHook, type PlanQaDiagnostic } from "../services/missions/mission-plan-qa.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission owner plan decision tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const validDecision = {
  missionId: "mission-1",
  missionGoal: "Ship controlled rollout",
  selectedExecutionUnits: [{ id: "unit-1", title: "Run smoke" }],
  ruleRefs: ["rule:security"],
  kbRefs: ["kb:rollout"],
  requiredInputs: ["stagingUrl"],
  successCriteria: ["smoke passes"],
  steps: [{ id: "step-1", title: "Verify staging" }],
};

const validAssessment = {
  objectiveRestatement: "Ship controlled rollout after reviewing available execution assets.",
  availableAssetsReviewed: [{ kind: "workflow", id: "workflow-smoke" }, "rule:security"],
  assetEvaluation: [{ asset: "workflow-smoke", verdict: "fit" }],
  gaps: [{ id: "gap-staging-url", severity: "blocked" }],
  researchPerformed: [{ query: "existing rollout KB", result: "kb:rollout" }],
};

function decisionComment(decision: Record<string, unknown>) {
  return `### Mission owner plan decision
\`\`\`json
${JSON.stringify(decision)}
\`\`\``;
}

describe("parseMissionOwnerPlanDecision", () => {
  it("returns null for plain comments without the exact decision heading", () => {
    expect(parseMissionOwnerPlanDecision("Looks good. {\"missionId\":\"mission-1\"}")).toBeNull();
  });

  it("parses a fenced json decision block after the exact heading and preserves materialization fields", () => {
    const result = parseMissionOwnerPlanDecision(`Intro text

### Mission owner plan decision

\`\`\`json
${JSON.stringify(validDecision, null, 2)}
\`\`\`

Tail text`);

    expect(result).toEqual({
      ok: true,
      decision: validDecision,
    });
  });

  it("parses a raw json object immediately after the exact heading", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
${JSON.stringify({ ...validDecision, goal: "Use goal field" })}`);

    expect(result).toEqual({
      ok: true,
      decision: { ...validDecision, goal: "Use goal field" },
    });
  });

  it("parses a fenced json decision when the heading has a parenthesized revision note", () => {
    const revisedDecision = { ...validDecision, selectedExecutionUnits: [{ id: "unit-revised" }] };
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision (rev 2 — QA REQUEST_CHANGES reflected)

The mission owner revised the plan after QA feedback.

\`\`\`json
${JSON.stringify(revisedDecision)}
\`\`\``);

    expect(result).toEqual({ ok: true, decision: revisedDecision });
  });

  it("returns the latest valid decision when multiple decision blocks exist", () => {
    const first = { ...validDecision, missionId: "mission-old" };
    const latest = { ...validDecision, missionId: "mission-latest", selectedExecutionUnits: [{ id: "unit-latest" }] };

    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
${JSON.stringify(first)}
\`\`\`

Comment between decisions.

### Mission owner plan decision
\`\`\`json
${JSON.stringify(latest)}
\`\`\``);

    expect(result).toEqual({ ok: true, decision: latest });
  });

  it("returns the latest valid decision when a later decision block has invalid json", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
${JSON.stringify(validDecision)}
\`\`\`

### Mission owner plan decision
\`\`\`json
{ invalid json
\`\`\``);

    expect(result).toEqual({ ok: true, decision: validDecision });
  });

  it("returns a diagnostic result instead of throwing when decision json is invalid", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
{ invalid json
\`\`\``);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_json",
        message: expect.stringContaining("Invalid Mission owner plan decision JSON"),
      }),
    });
  });

  it("ignores json-looking blocks under other headings", () => {
    const result = parseMissionOwnerPlanDecision(`### Other heading
\`\`\`json
${JSON.stringify(validDecision)}
\`\`\``);

    expect(result).toBeNull();
  });

  it("requires the exact h3 markdown heading", () => {
    expect(parseMissionOwnerPlanDecision(`## Mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
    expect(parseMissionOwnerPlanDecision(`#### Mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
    expect(parseMissionOwnerPlanDecision(`### mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
  });
});

describeEmbeddedPostgres("findLatestAuthorizedMissionOwnerPlanDecision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-owner-plan-decisions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedMissionFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plan Decision Company",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning mission",
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

    return { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId };
  }

  it("returns the owner-agent decision from the canonical planning issue with metadata", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const commentId = randomUUID();
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "owner-unit" }] };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId })).resolves.toEqual({
      ok: true,
      decision,
      planningIssueId,
      commentId,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [],
    });
  });

  it("accepts a board/user decision comment as full-control operator context", async () => {
    const { companyId, missionId, planningIssueId } = await seedMissionFixture();
    const commentId = randomUUID();
    const boardUserId = "board-user-1";
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "board-unit" }] };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorUserId: boardUserId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId })).resolves.toMatchObject({
      ok: true,
      decision,
      planningIssueId,
      commentId,
      author: { kind: "user", id: boardUserId },
    });
  });

  it("ignores newer other-agent decisions and falls back to an older owner-agent decision", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const unauthorizedCommentId = randomUUID();
    const ownerCommentId = randomUUID();
    const ownerDecision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "owner-old" }] };

    await db.insert(issueComments).values([
      {
        id: ownerCommentId,
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: decisionComment(ownerDecision),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: unauthorizedCommentId,
        companyId,
        issueId: planningIssueId,
        authorAgentId: otherAgentId,
        body: decisionComment({ ...validDecision, missionId, selectedExecutionUnits: [{ id: "other-new" }] }),
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);

    const result = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    expect(result).toMatchObject({
      ok: true,
      decision: ownerDecision,
      planningIssueId,
      commentId: ownerCommentId,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [
        {
          commentId: unauthorizedCommentId,
          code: "unauthorized_author",
        },
      ],
    });
  });

  it("ignores valid decisions on non-planning issues", async () => {
    const { companyId, ownerAgentId, missionId } = await seedMissionFixture();
    const workflowIssueId = randomUUID();

    await db.insert(issues).values({
      id: workflowIssueId,
      companyId,
      missionId,
      title: "Workflow issue",
      originKind: "workflow_execution",
      status: "todo",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: workflowIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({ ...validDecision, missionId, selectedExecutionUnits: [{ id: "wrong-issue" }] }),
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId })).resolves.toEqual({
      ok: false,
      reason: "no_authorized_decision",
      planningIssueId: expect.any(String),
      diagnostics: [],
    });
  });

  it("returns inert no-decision results for cross-company/missing mission or missing planning issue", async () => {
    const { companyId, missionId } = await seedMissionFixture();
    const otherCompanyId = randomUUID();
    const missingMissionId = randomUUID();
    const noPlanningCompanyId = randomUUID();
    const noPlanningOwnerAgentId = randomUUID();
    const noPlanningMissionId = randomUUID();

    await db.insert(companies).values([
      {
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: `OC${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: noPlanningCompanyId,
        name: "No Planning Company",
        issuePrefix: `NP${noPlanningCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: noPlanningOwnerAgentId,
      companyId: noPlanningCompanyId,
      name: "No Planning Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: noPlanningMissionId,
      companyId: noPlanningCompanyId,
      ownerAgentId: noPlanningOwnerAgentId,
      title: "Mission without planning issue",
      status: "active",
    });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: otherCompanyId, missionId })).resolves.toEqual({
      ok: false,
      reason: "mission_not_found",
      planningIssueId: null,
      diagnostics: [],
    });
    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId: missingMissionId })).resolves.toEqual({
      ok: false,
      reason: "mission_not_found",
      planningIssueId: null,
      diagnostics: [],
    });
    await expect(
      findLatestAuthorizedMissionOwnerPlanDecision({
        db,
        companyId: noPlanningCompanyId,
        missionId: noPlanningMissionId,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "planning_issue_not_found",
      planningIssueId: null,
      diagnostics: [],
    });
  });

  it("does not throw on an invalid latest authorized comment and falls back to an older valid one", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const invalidCommentId = randomUUID();
    const validCommentId = randomUUID();
    const olderDecision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "older-valid" }] };

    await db.insert(issueComments).values([
      {
        id: validCommentId,
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: decisionComment(olderDecision),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: invalidCommentId,
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: `### Mission owner plan decision
\`\`\`json
{ invalid json
\`\`\``,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);

    const result = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    expect(result).toMatchObject({
      ok: true,
      decision: olderDecision,
      planningIssueId,
      commentId: validCommentId,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [
        {
          commentId: invalidCommentId,
          code: "invalid_decision",
          message: expect.stringContaining("Invalid Mission owner plan decision JSON"),
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 3C – buildMissionOwnerPlanRevisionDraft (pure, no DB)
// ---------------------------------------------------------------------------

describe("buildMissionOwnerPlanRevisionDraft", () => {
  const baseDecision = {
    missionId: "mission-42",
    missionGoal: "Ship controlled rollout",
    selectedExecutionUnits: [{ id: "unit-1", title: "Run smoke" }],
    ruleRefs: ["rule:security"],
    kbRefs: ["kb:rollout"],
    requiredInputs: ["stagingUrl"],
    successCriteria: ["smoke passes"],
    steps: [{ id: "step-1", title: "Verify staging" }],
  };

  const baseArgs = {
    expectedMissionId: "mission-42",
    planningIssueId: "issue-99",
    commentId: "comment-77",
  };

  it("defaults omitted array fields to empty arrays for a minimal decision", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { missionId: "mission-42" },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: {
        missionId: "mission-42",
        refs: {
          schemaVersion: 3,
          selectedExecutionUnits: [],
          ruleRefs: [],
          kbRefs: [],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        },
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      },
    });
  });

  it("defaults null array fields to empty arrays", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        missionId: "mission-42",
        selectedExecutionUnits: null,
        ruleRefs: null,
        kbRefs: null,
        requiredInputs: null,
        successCriteria: null,
        steps: null,
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          selectedExecutionUnits: [],
          ruleRefs: [],
          kbRefs: [],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        }),
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      }),
    });
  });

  // 1. Valid decision with missionGoal normalizes all fields correctly
  it("normalizes a valid decision with missionGoal into a complete draft", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: baseDecision,
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: {
        missionId: "mission-42",
        missionGoal: "Ship controlled rollout",
        refs: {
          schemaVersion: 3,
          selectedExecutionUnits: [{ id: "unit-1", title: "Run smoke" }],
          ruleRefs: ["rule:security"],
          kbRefs: ["kb:rollout"],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        },
        requiredInputs: ["stagingUrl"],
        successCriteria: ["smoke passes"],
        steps: [{ id: "step-1", title: "Verify staging" }],
      },
    });
  });

  it("preserves dynamic mission planning fields in plan refs", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        missionInvariant: ["RPA 과강제 금지", { principle: "slice vs E2E 분리" }],
        scopeHypothesis: "This slice proves the mission owner can request evidence-gated work.",
        executionSlice: {
          inScope: ["runtime brief parsing"],
          outOfScope: ["deploy", "workflow run"],
          approvalGates: ["push requires user approval"],
        },
        evidenceRequired: ["focused test output", { kind: "typecheck", command: "pnpm --filter @paperclipai/server typecheck" }],
        gate: {
          validator: "Report Validator",
          pass: ["all evidence read back"],
          requestChanges: ["missing evidence"],
          blocked: ["needs user approval"],
        },
        promotion: {
          promote: ["repeatable evidence template"],
          doNotPromote: ["PR number", "one-off log"],
        },
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          dynamicMissionPlanning: {
            missionInvariant: ["RPA 과강제 금지", { principle: "slice vs E2E 분리" }],
            scopeHypothesis: "This slice proves the mission owner can request evidence-gated work.",
            executionSlice: {
              inScope: ["runtime brief parsing"],
              outOfScope: ["deploy", "workflow run"],
              approvalGates: ["push requires user approval"],
            },
            evidenceRequired: ["focused test output", { kind: "typecheck", command: "pnpm --filter @paperclipai/server typecheck" }],
            gate: {
              validator: "Report Validator",
              pass: ["all evidence read back"],
              requestChanges: ["missing evidence"],
              blocked: ["needs user approval"],
            },
            promotion: {
              promote: ["repeatable evidence template"],
              doNotPromote: ["PR number", "one-off log"],
            },
          },
        }),
      }),
    });
  });

  it("preserves self-improvement candidates in plan refs", () => {
    const candidates = [
      {
        assetType: "skill",
        assetRef: "research-news-synthesis",
        evidenceSource: ["issue:planning-1", { kind: "test", command: "pnpm vitest run news.test.ts" }],
        pattern: "Repeatedly missed source freshness labels.",
        proposedEdit: {
          operation: "add",
          section: "Validation checklist",
          content: "Verify source date and separate freshness from importance.",
        },
        validationPlan: "Replay against the last 3 AI news notes.",
        rejectedEditNote: "none",
        gateOwner: "peer:validator",
        autoAdoptionResult: "queued_for_validation",
      },
    ];

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: candidates,
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          selfImprovementCandidates: candidates,
        }),
      }),
    });
  });

  it("rejects malformed self-improvement candidates instead of silently omitting them", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: ["not-a-candidate-object"],
      },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selfImprovementCandidates/i.test(d.message))).toBe(true);
    }
  });

  it("rejects self-improvement candidates missing required contract fields", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [
          {
            assetType: "skill",
            assetRef: "research-news-synthesis",
            evidenceSource: ["issue:planning-1"],
            proposedEdit: { operation: "add", section: "Validation checklist" },
            validationPlan: "Replay against reference notes.",
            gateOwner: "peer:validator",
            autoAdoptionResult: "queued_for_validation",
          },
        ],
      },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /pattern/i.test(d.message))).toBe(true);
    }
  });

  it("rejects self-improvement candidates with invalid contract enums", () => {
    const invalidCandidates = [
      { assetType: "memory", proposedEdit: { operation: "add" }, autoAdoptionResult: "queued_for_validation" },
      { assetType: "skill", proposedEdit: { operation: "rewrite" }, autoAdoptionResult: "queued_for_validation" },
      { assetType: "skill", proposedEdit: { operation: "add" }, autoAdoptionResult: "needs_user_approval" },
    ].map((candidate) => ({
      assetRef: "research-news-synthesis",
      evidenceSource: ["issue:planning-1"],
      pattern: "Repeatedly missed source freshness labels.",
      validationPlan: "Replay against reference notes.",
      gateOwner: "peer:validator",
      ...candidate,
    }));

    for (const candidate of invalidCandidates) {
      const result = buildMissionOwnerPlanRevisionDraft({
        decision: {
          ...baseDecision,
          selfImprovementCandidates: [candidate],
        },
        ...baseArgs,
      });

      expect(result).not.toEqual({ ok: true, draft: expect.anything() });
      if (!result.ok) {
        expect(result.diagnostics.some((d) => /selfImprovementCandidates/i.test(d.message))).toBe(true);
      }
    }
  });

  it("requires rejectedEditNote only when self-improvement candidates are rejected", () => {
    const validBaseCandidate = {
      assetType: "skill",
      assetRef: "research-news-synthesis",
      evidenceSource: ["issue:planning-1"],
      pattern: "Repeatedly missed source freshness labels.",
      proposedEdit: { operation: "add", section: "Validation checklist" },
      validationPlan: "Replay against reference notes.",
      gateOwner: "peer:validator",
    };

    const queuedResult = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [{ ...validBaseCandidate, autoAdoptionResult: "queued_for_validation" }],
      },
      ...baseArgs,
    });
    expect(queuedResult).toEqual({ ok: true, draft: expect.anything() });

    const rejectedMissingNote = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [{ ...validBaseCandidate, autoAdoptionResult: "rejected" }],
      },
      ...baseArgs,
    });
    expect(rejectedMissingNote).not.toEqual({ ok: true, draft: expect.anything() });
    if (!rejectedMissingNote.ok) {
      expect(rejectedMissingNote.diagnostics.some((d) => /rejectedEditNote/i.test(d.message))).toBe(true);
    }

    const rejectedWithNote = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [
          { ...validBaseCandidate, autoAdoptionResult: "rejected", rejectedEditNote: "Too broad for one bounded patch." },
        ],
      },
      ...baseArgs,
    });
    expect(rejectedWithNote).toEqual({ ok: true, draft: expect.anything() });
  });

  // 2. goal fallback: uses decision.goal when decision.missionGoal is absent
  it("falls back to decision.goal when missionGoal is absent", () => {
    const { missionGoal: _, ...withoutGoal } = baseDecision;
    const decision = { ...withoutGoal, goal: "Fallback goal text" };

    const result = buildMissionOwnerPlanRevisionDraft({
      decision,
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        missionGoal: "Fallback goal text",
      }),
    });
  });

  // 3. Missing goal omitted when both missionGoal and goal are absent or empty
  it("omits missionGoal when both missionGoal and goal are absent", () => {
    const { missionGoal: _, ...withoutGoal } = baseDecision;

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: withoutGoal,
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.not.objectContaining({ missionGoal: expect.anything() }) });
  });

  it("omits missionGoal when both missionGoal and goal are empty strings", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, missionGoal: "", goal: "" },
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.not.objectContaining({ missionGoal: expect.anything() }) });
  });

  // 4. missionId mismatch → invalid result, no throw
  it("returns invalid result (no throw) when missionId does not match expectedMissionId", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, missionId: "WRONG-MISSION" },
      expectedMissionId: "mission-42",
      planningIssueId: "issue-99",
      commentId: "comment-77",
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.some((d) => /missionId/i.test(d.message) || /mismatch/i.test(d.message))).toBe(true);
    }
  });

  it("returns ok when missionId is absent from decision", () => {
    const { missionId: _, ...withoutId } = baseDecision;
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: withoutId,
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.objectContaining({ missionId: "mission-42" }) });
  });

  // 5. Wrong top-level shapes rejected with diagnostics
  it("rejects selectedExecutionUnits that is not an array", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: "not-an-array" },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("rejects selectedExecutionUnits containing non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: ["string-not-allowed"] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selectedExecutionUnits/i.test(d.message))).toBe(true);
    }
  });

  it("rejects ruleRefs that is not an array", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: 42 },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects ruleRefs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: [123] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects kbRefs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, kbRefs: [true] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects requiredInputs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, requiredInputs: [null] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects successCriteria containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, successCriteria: [undefined] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects steps containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, steps: [42] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  // 6. Over-cap arrays rejected
  it("rejects absurdly large selectedExecutionUnits array", () => {
    const huge = Array.from({ length: 1100 }, (_, i) => ({ id: `unit-${i}` }));
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: huge },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selectedExecutionUnits/i.test(d.message))).toBe(true);
    }
  });

  it("rejects absurdly large ruleRefs array", () => {
    const huge = Array.from({ length: 1100 }, (_, i) => `rule:${i}`);
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: huge },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  // 7. selectedExecutionUnits preserve arbitrary object structure without DB validation
  it("preserves arbitrary object structure in selectedExecutionUnits without DB validation", () => {
    const customUnits = [
      { id: "custom-1", foo: "bar", nested: { deep: true }, count: 42 },
      { name: "unit-no-id", metadata: [{ tag: "a" }] },
    ];

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: customUnits },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({ selectedExecutionUnits: customUnits }),
      }),
    });
  });

  it("preserves a valid assessment under refs.ownerPlanDecision.assessment", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, assessment: validAssessment },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          ownerPlanDecision: {
            planningIssueId: "issue-99",
            commentId: "comment-77",
            assessment: validAssessment,
          },
        }),
      }),
    });
  });

  it("omits malformed assessment arrays without rejecting an otherwise valid draft", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, assessment: { ...validAssessment, gaps: "not-an-array" } },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          ownerPlanDecision: {
            planningIssueId: "issue-99",
            commentId: "comment-77",
            assessment: expect.objectContaining({
              objectiveRestatement: validAssessment.objectiveRestatement,
              assetEvaluation: validAssessment.assetEvaluation,
              researchPerformed: validAssessment.researchPerformed,
            }),
          },
        }),
      }),
    });
    if (result.ok) {
      expect(result.draft.refs.ownerPlanDecision.assessment).not.toHaveProperty("gaps");
    }
  });

  it("preserves mixed string and object entries in ruleRefs", () => {
    const mixed = ["rule:a", { ref: "rule:b", confidence: 0.9 }];
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: mixed },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({ refs: expect.objectContaining({ ruleRefs: mixed }) }),
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 3D – recordLatestAuthorizedMissionOwnerPlanDecision (DB-backed)
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("recordLatestAuthorizedMissionOwnerPlanDecision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-record-owner-plan-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missionDelegations);
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

  async function seedFullMissionFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Record Plan Company",
      issuePrefix: `RP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning mission",
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

    return { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId };
  }

  // Test 1: Valid owner decision creates revision 2
  it("creates revision 2 with selectedExecutionUnits, refs, requiredInputs, successCriteria, steps and logs mission.owner_plan.recorded", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create referenced workflow definition in same company
    const wfPlan1Id = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfPlan1Id,
      companyId,
      name: "Smoke Test Workflow",
    });

    // Create initial plan (revision 1)
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    // Add valid decision comment
    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Ship controlled rollout",
      selectedExecutionUnits: [
        {
          id: `wf:${wfPlan1Id}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Required for validation",
          sourceRef: { type: "workflow_definition_step", id: wfPlan1Id, stepId: "smoke" },
        },
      ],
      ruleRefs: ["rule:security"],
      kbRefs: ["kb:rollout"],
      assessment: validAssessment,
      requiredInputs: ["stagingUrl"],
      successCriteria: ["smoke passes"],
      steps: [{ id: "step-1", title: "Verify staging" }],
    };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.revision).toBe(2);
    expect(result.commentId).toBe(commentId);

    // Verify the plan artifact was created
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan).toBeDefined();
    expect(activePlan!.revision).toBe(2);
    expect(activePlan!.missionGoal).toBe("Ship controlled rollout");

    const refs = activePlan!.refs as Record<string, unknown>;
    expect(refs.selectedExecutionUnits).toBeDefined();
    expect(Array.isArray(refs.selectedExecutionUnits)).toBe(true);
    expect((refs.selectedExecutionUnits as unknown[]).length).toBe(1);
    expect(refs.ownerPlanDecision).toMatchObject({
      planningIssueId,
      commentId,
      decisionHash: expect.any(String),
      assessment: validAssessment,
    });

    expect(activePlan!.requiredInputs).toEqual(["stagingUrl"]);
    expect(activePlan!.successCriteria).toEqual(["smoke passes"]);
    expect(activePlan!.steps).toEqual([{ id: "step-1", title: "Verify staging" }]);

    // Verify activity log
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.entityType).toBe("mission");
    expect(activities[0]!.entityId).toBe(missionId);
    expect(activities[0]!.companyId).toBe(companyId);
    expect(activities[0]!.details).toMatchObject({
      missionPlanArtifactId: activePlan!.id,
      revision: 2,
      planningIssueId,
      commentId,
      decisionMakerKind: "agent",
      decisionMakerId: ownerAgentId,
      decisionHash: expect.any(String),
      idempotencyKey: expect.stringContaining(commentId),
    });
  });

  it("[P1 ownership-drift] planning issue assignee 가 mission owner 와 불일치하면 ownership_drift 로 fail-fast 한다", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Drift Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Drift test",
      selectedExecutionUnits: [{
        id: `wf:${wfId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required",
        sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" },
      }],
      ruleRefs: [],
      kbRefs: [],
      assessment: validAssessment,
      requiredInputs: [],
      successCriteria: ["smoke passes"],
      steps: [],
    };
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    // drift: planning issue 를 mission owner 가 아닌 agent 에게 재할당
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, planningIssueId));

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toBe("ownership_drift");
    expect(result.diagnostics.some((d) => d.code === "ownership_drift")).toBe(true);
  });

  it("[P1 ownership-drift] planning issue assignee == mission owner 면 drift 없이 materialize 한다", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Owner Assigned Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Owner assigned",
      selectedExecutionUnits: [{
        id: `wf:${wfId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required",
        sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" },
      }],
      ruleRefs: [],
      kbRefs: [],
      assessment: validAssessment,
      requiredInputs: [],
      successCriteria: ["smoke passes"],
      steps: [],
    };
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    // owner 에게 명시 할당 → drift 없음
    await db.update(issues).set({ assigneeAgentId: ownerAgentId }).where(eq(issues.id, planningIssueId));

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
  });

  it("[P2 critique] LLM critique hook 이 invalid diagnostic 을 추가하면 materialization 을 차단한다", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Critique Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Critique test",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: ["smoke passes"], steps: [],
    };
    await db.insert(issueComments).values({ id: randomUUID(), companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, body: decisionComment(decision), createdAt: new Date("2026-01-01T00:00:00.000Z") });
    // title "Planning mission" → deterministic 없음. critique 가 invalid 추가 → 차단.
    setMissionPlanQaCritiqueHook(async () => [{ code: "missing_publish_unit", severity: "invalid", message: "critique: publish missing" }] as PlanQaDiagnostic[]);
    try {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.diagnostics.some((d) => d.code === "missing_publish_unit")).toBe(true);
    } finally {
      setMissionPlanQaCritiqueHook(null);
    }
  });

  it("[P2 critique] deterministic invalid 는 critique 가 needs_clarification 를 반환해도 invalid 로 유지된다(완화 금지)", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    // mission title → publish intent → deterministic missing_publish_unit(invalid).
    await db.update(missions).set({ title: "가이드를 site에 올리도록" }).where(eq(missions.id, missionId));
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Det Hold Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "Det hold test",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: [], steps: [],
    };
    await db.insert(issueComments).values({ id: randomUUID(), companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, body: decisionComment(decision), createdAt: new Date("2026-01-01T00:00:00.000Z") });
    setMissionPlanQaCritiqueHook(async () => [{ code: "missing_audience_split", severity: "needs_clarification", message: "soft" }] as PlanQaDiagnostic[]);
    try {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
      expect(result.status).toBe("invalid"); // deterministic invalid 유지
      if (result.status !== "invalid") return;
      expect(result.diagnostics.some((d) => d.code === "missing_publish_unit")).toBe(true);
    } finally {
      setMissionPlanQaCritiqueHook(null);
    }
  });

  it("[P4 surface] plan_intent_coverage_failed 시 mission.plan.rejected activity 가 로깅된다(operator 가시)", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await db.update(missions).set({ title: "가이드를 site에 올리도록" }).where(eq(missions.id, missionId));
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Surface Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = {
      missionId,
      missionGoal: "surface",
      selectedExecutionUnits: [{ id: `wf:${wfId}:step:smoke`, kind: "workflow_definition_step", title: "Run smoke", selectionState: "selected", reason: "R", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "smoke" } }],
      ruleRefs: [], kbRefs: [], assessment: validAssessment, requiredInputs: [], successCriteria: [], steps: [],
    };
    await db.insert(issueComments).values({ id: randomUUID(), companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, body: decisionComment(decision), createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    const rejected = await db.select().from(activityLog).where(eq(activityLog.action, "mission.plan.rejected"));
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.details).toMatchObject({ reason: "plan_intent_coverage_failed" });
  });

  it("materializes selected execution units into a mission-scoped PAQO workflow DAG with ACTION gated before QA", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await db
      .update(companies)
      .set({ workProductRoot: "/tmp/paperclip-test-work-products" })
      .where(eq(companies.id, companyId));
    const sourceWorkflowId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowId,
      companyId,
      name: "Source Research Workflow",
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate PAQO workflow pivot",
      selectedExecutionUnits: [
        {
          id: "research-scout",
          kind: "workflow_definition_step",
          title: "Research current workflow surfaces",
          reason: "Need source evidence before synthesis",
          sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: ["workflow source evidence"],
      successCriteria: ["QA verifies the synthesized result"],
      steps: [{ id: "qa", title: "Verify synthesized result" }],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate PAQO workflow pivot"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[]; agentId: string; graphWorkProductRequired?: boolean }>;
    expect(paqoSteps.map((step) => step.name)).toEqual([
      "[ACTION] Research current workflow surfaces",
      "[QA] Verify mission result",
    ]);
    expect(paqoSteps[0]!.agentId).toBe(ownerAgentId);
    expect(paqoSteps[0]!.graphWorkProductRequired).toBe(true);
    expect(paqoSteps[1]!.graphWorkProductRequired).toBe(false);
    expect(paqoSteps[1]!.dependencies).toEqual([paqoSteps[0]!.id]);
    // [P5 control-flow loop] ACTION producer 에 QA rework back-edge 가 합성되었는지(wiring 회귀 감지).
    const paqoStepsRaw = paqoDefinitions[0]!.stepsJson as Array<{
      id: string;
      conditionalDependencies?: Array<{ stepId: string; when: string; isBackEdge?: boolean; maxIterations?: number }>;
    }>;
    const actionWithEdge = paqoStepsRaw.find((step) => step.id === paqoSteps[0]!.id)!;
    expect(actionWithEdge.conditionalDependencies).toEqual([
      { stepId: paqoSteps[1]!.id, when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(paqoStepsRaw.find((step) => step.id === paqoSteps[1]!.id)!.conditionalDependencies).toBeUndefined();

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ companyId, missionId, status: "running" });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    const actionRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[0]!.id);
    const qaRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[1]!.id);
    expect(actionRun?.issueId).toEqual(expect.any(String));
    expect(actionRun?.status).toBe("pending");
    expect(qaRun?.issueId).toBeNull();
    expect(qaRun?.status).toBe("pending");

    const actionIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, actionRun!.issueId!))
      .then((rows) => rows[0]);
    expect(actionIssue).toMatchObject({
      companyId,
      missionId,
      title: "[ACTION] Research current workflow surfaces",
      originKind: "workflow_execution",
      originRunId: runs[0]!.id,
      parentId: null,
    });
    expect(actionIssue?.title).not.toContain("PAQO WBS");
    expect(actionIssue?.description).toContain("Deliverable output (use exactly this directory):");
    expect(actionIssue?.description).toContain("WorkProduct registration contract:");
    expect(actionIssue?.description).toContain("[ARTIFACT]: <absolute path>");

    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      paqoWorkflow: {
        workflowDefinitionId: paqoDefinitions[0]!.id,
        workflowRunId: runs[0]!.id,
        workflowName: "PAQO WBS: Validate PAQO workflow pivot",
        stepIds: paqoSteps.map((step) => step.id),
        decisionHash: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });

    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_oversight"));
    expect(oversightIssues).toHaveLength(0);
  });

  it("does not materialize PAQO OVERSIGHT units as workflow DAG steps", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Keep oversight outside workflow DAG",
      selectedExecutionUnits: [
        {
          id: "unit-data",
          kind: "mission_plan_unit",
          title: "[ACTION] Collect market data",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-data" },
        },
        {
          id: "unit-owner-oversight",
          kind: "oversight",
          title: "[OVERSIGHT] Owner monitors and coordinates recovery",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-owner-oversight" },
          dependsOn: ["unit-data"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["Owner oversight remains mission-level, not workflow-level"],
      steps: [
        { id: "collect", units: ["unit-data"] },
        { id: "oversee", units: ["unit-owner-oversight"], dependsOn: ["unit-data"] },
      ],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T00:10:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Keep oversight outside workflow DAG"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[]; agentId: string }>;
    expect(paqoSteps.map((step) => step.name)).toEqual([
      "[ACTION] Collect market data",
      "[QA] Verify mission result",
    ]);
    expect(paqoSteps.some((step) => step.name.includes("[OVERSIGHT]"))).toBe(false);
    expect(paqoSteps[1]!.dependencies).toEqual([paqoSteps[0]!.id]);
    // [P5 control-flow loop] ACTION producer 에 QA rework back-edge 가 합성되었는지(wiring 회귀 감지).
    const paqoStepsRaw = paqoDefinitions[0]!.stepsJson as Array<{
      id: string;
      conditionalDependencies?: Array<{ stepId: string; when: string; isBackEdge?: boolean; maxIterations?: number }>;
    }>;
    const actionWithEdge = paqoStepsRaw.find((step) => step.id === paqoSteps[0]!.id)!;
    expect(actionWithEdge.conditionalDependencies).toEqual([
      { stepId: paqoSteps[1]!.id, when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(paqoStepsRaw.find((step) => step.id === paqoSteps[1]!.id)!.conditionalDependencies).toBeUndefined();

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns.map((stepRun) => stepRun.stepId).sort()).toEqual(paqoSteps.map((step) => step.id).sort());
  });

  it("materializes PLAN-managed mission units with explicit assignees into native DAG steps", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate PLAN-owned assignment structure",
      selectedExecutionUnits: [
        {
          id: "unit-source-research",
          kind: "mission_plan_unit",
          title: "Research source evidence",
          assigneeAgentId: otherAgentId,
          selectionState: "selected",
          reason: "PLAN selected the worker from the company roster",
          sourceRef: { type: "mission_plan_unit", id: "unit-source-research" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["worker ACTION completes before QA"],
      steps: [{ id: "research", title: "Research source evidence" }],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T00:30:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate PLAN-owned assignment structure"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[]; agentId: string; description: string }>;
    expect(paqoSteps[0]).toMatchObject({
      name: "[ACTION] Research source evidence",
      agentId: otherAgentId,
    });
    expect(paqoSteps[0]!.description).toContain(`Assigned by PLAN decision to agentId: ${otherAgentId}`);
    expect(paqoSteps[1]).toMatchObject({
      name: "[QA] Verify mission result",
      agentId: ownerAgentId,
      dependencies: [paqoSteps[0]!.id],
    });

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    const actionRun = stepRuns.find((stepRun) => stepRun.stepId === paqoSteps[0]!.id);
    expect(actionRun?.issueId).toEqual(expect.any(String));
    const actionIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, actionRun!.issueId!))
      .then((rows) => rows[0]);
    expect(actionIssue).toMatchObject({
      companyId,
      missionId,
      title: expect.stringMatching(/^\[ACTION\] Research source evidence/),
      assigneeAgentId: otherAgentId,
      originKind: "workflow_execution",
      parentId: null,
    });
  });

  it("automatically creates cross-company delegated missions from owner PLAN selected units", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const targetCompanyId = randomUUID();
    const targetOwnerAgentId = randomUUID();

    await db.insert(companies).values({
      id: targetCompanyId,
      name: "Research Company",
      issuePrefix: `RC${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: targetOwnerAgentId,
      companyId: targetCompanyId,
      name: "Research Director",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Build daily briefing dashboard",
      selectedExecutionUnits: [
        {
          id: "research-daily-brief-inputs",
          kind: "cross_company_mission",
          title: "Research daily briefing workflow inputs",
          targetCompanyId,
          targetOwnerAgentId,
          reason: "Development mission needs Research Company evidence before implementation planning",
          sourceRef: { type: "cross_company_mission", id: "research-daily-brief-inputs" },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["delegated research mission returns official workProducts"],
      steps: ["delegate research to Research Company before implementation planning"],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T00:45:00.000Z"),
    });

    const result1 = await recordThroughQaPass({ companyId, missionId });
    const result2 = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    expect(result1.status).toBe("recorded");
    expect(result2.status).toBe("noop");

    const delegations = await db.select().from(missionDelegations).where(eq(missionDelegations.sourceMissionId, missionId));
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      sourceCompanyId: companyId,
      targetCompanyId,
      status: "active",
      externalKey: expect.stringContaining("owner-plan:"),
    });

    const sourceTracker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, delegations[0]!.sourceIssueId!))
      .then((rows) => rows[0]);
    expect(sourceTracker).toMatchObject({
      companyId,
      missionId,
      status: "blocked",
      originKind: "mission_delegation_source",
      assigneeAgentId: ownerAgentId,
    });

    const targetMission = await db
      .select()
      .from(missions)
      .where(eq(missions.id, delegations[0]!.targetMissionId))
      .then((rows) => rows[0]);
    expect(targetMission).toMatchObject({
      companyId: targetCompanyId,
      ownerAgentId: targetOwnerAgentId,
      title: "[DELEGATED] Research daily briefing workflow inputs",
      status: "planning",
    });

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Build daily briefing dashboard"));
    expect(paqoDefinitions).toHaveLength(0);

    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      crossCompanyDelegations: [
        {
          delegationId: delegations[0]!.id,
          sourceIssueId: delegations[0]!.sourceIssueId,
          targetCompanyId,
          targetMissionId: delegations[0]!.targetMissionId,
          decisionHash: expect.any(String),
        },
      ],
    });
  });

  it("preserves PLAN unit dependencies and QA grouping in the native PAQO DAG", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate ordered PLAN unit graph",
      selectedExecutionUnits: [
        {
          id: "unit-research-a",
          kind: "mission_plan_unit",
          title: "Research source A",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-research-a" },
        },
        {
          id: "unit-research-b",
          kind: "mission_plan_unit",
          title: "Research source B",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-research-b" },
        },
        {
          id: "unit-html-synthesis",
          kind: "mission_plan_unit",
          title: "[ACTION] Write HTML report",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-html-synthesis" },
          dependsOn: ["unit-research-a", "unit-research-b"],
        },
        {
          id: "unit-qa-validation",
          kind: "qa",
          title: "[QA] Fact-check HTML report",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-qa-validation" },
          dependsOn: ["unit-html-synthesis"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["QA runs only after synthesis"],
      steps: ["Phase 1: parallel research", "Phase 2: synthesis", "Phase 3: QA"],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T01:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate ordered PLAN unit graph"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[] }>;
    const researchA = paqoSteps.find((step) => step.name === "[ACTION] Research source A");
    const researchB = paqoSteps.find((step) => step.name === "[ACTION] Research source B");
    const synthesis = paqoSteps.find((step) => step.name === "[ACTION] Write HTML report");
    const validator = paqoSteps.find((step) => step.name === "[QA] Fact-check HTML report");
    const ownerQa = paqoSteps.find((step) => step.name === "[QA] Verify mission result");

    expect(researchA?.dependencies).toEqual([]);
    expect(researchB?.dependencies).toEqual([]);
    expect(synthesis?.dependencies).toEqual(expect.arrayContaining([researchA!.id, researchB!.id]));
    expect(synthesis?.dependencies).toHaveLength(2);
    expect(validator?.dependencies).toEqual([synthesis!.id]);
    expect(ownerQa?.dependencies).toEqual(expect.arrayContaining([
      researchA!.id,
      researchB!.id,
      synthesis!.id,
      validator!.id,
    ]));
    expect(ownerQa?.dependencies).toHaveLength(4);

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns.find((stepRun) => stepRun.stepId === researchA!.id)?.issueId).toEqual(expect.any(String));
    expect(stepRuns.find((stepRun) => stepRun.stepId === researchB!.id)?.issueId).toEqual(expect.any(String));
    expect(stepRuns.find((stepRun) => stepRun.stepId === synthesis!.id)?.issueId).toBeNull();
    expect(stepRuns.find((stepRun) => stepRun.stepId === validator!.id)?.issueId).toBeNull();
  });

  it("refreshes an existing PAQO workflow definition when PLAN steps change", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const staleDefinitionId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: staleDefinitionId,
      companyId,
      name: "PAQO WBS: Validate stale PAQO definition",
      stepsJson: [
        {
          id: "action-stale",
          name: "[ACTION] Stale action",
          agentId: ownerAgentId,
          dependencies: [],
        },
        {
          id: "qa-stale",
          name: "[QA] Verify mission result",
          agentId: ownerAgentId,
          dependencies: ["action-stale"],
        },
      ],
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate stale PAQO definition",
      selectedExecutionUnits: [
        {
          id: "unit-a",
          kind: "mission_plan_unit",
          title: "Research A",
          assigneeAgentId: otherAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-a" },
        },
        {
          id: "unit-b",
          kind: "mission_plan_unit",
          title: "Synthesize B",
          assigneeAgentId: ownerAgentId,
          sourceRef: { type: "mission_plan_unit", id: "unit-b" },
          dependsOn: ["unit-a"],
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: [],
      successCriteria: ["B waits for A"],
      steps: ["A then B"],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T01:30:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Validate stale PAQO definition"));
    expect(paqoDefinitions).toHaveLength(1);
    expect(paqoDefinitions[0]!.id).toBe(staleDefinitionId);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ id: string; name: string; dependencies: string[] }>;
    const research = paqoSteps.find((step) => step.name === "[ACTION] Research A");
    const synthesis = paqoSteps.find((step) => step.name === "[ACTION] Synthesize B");
    expect(research?.dependencies).toEqual([]);
    expect(synthesis?.dependencies).toEqual([research!.id]);
  });

  it("materializes selected execution units with issue sourceRefs emitted by PLAN heartbeat output", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {},
      requiredInputs: [],
      successCriteria: [],
      steps: [],
    });

    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Validate live PLAN heartbeat issue refs",
      selectedExecutionUnits: [
        {
          id: "live-action-1",
          title: "Live verification action A",
          reason: "Matches process adapter PLAN stdout shape",
          sourceRef: { type: "issue", identifier: "PLAN-1", issueId: planningIssueId },
        },
      ],
      ruleRefs: [],
      kbRefs: [],
      requiredInputs: ["live heartbeat auto-complete stdout"],
      successCriteria: ["workflowRun exists"],
      steps: ["hold QA behind dependencies"],
    };
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-02T01:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });

    expect(result.status).toBe("recorded");
    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(activePlan?.refs).toMatchObject({
      paqoWorkflow: {
        workflowRunId: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs).toHaveLength(1);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns.some((stepRun) => stepRun.issueId && stepRun.status === "pending")).toBe(true);
    expect(stepRuns.some((stepRun) => stepRun.issueId === null && stepRun.status === "pending")).toBe(true);
  });

  // Test 2: Invalid mission id returns invalid / no revision / no activity
  it("returns invalid for unknown or cross-company mission with no revision or activity", async () => {
    const { companyId, missionId } = await seedFullMissionFixture();
    const wrongMissionId = randomUUID();
    const wrongCompanyId = randomUUID();

    // Cross-company: wrong company, correct mission id
    const resultCross = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: wrongCompanyId,
      missionId,
    });
    expect(resultCross.status).toBe("invalid");

    // Unknown mission: correct company, wrong mission id
    const resultMissing = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId,
      missionId: wrongMissionId,
    });
    expect(resultMissing.status).toBe("invalid");

    // No revisions created
    const plans = await db.select().from(missionPlanArtifacts);
    expect(plans).toHaveLength(0);

    // No activity logged
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  // Test 3: Unknown/cross-company workflow sourceRef rejected
  it("rejects selectedExecutionUnits with cross-company workflow sourceRef, no revision, no activity", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create workflow definition in a DIFFERENT company
    const otherCompanyId = randomUUID();
    const wfOtherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `OC${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: wfOtherCompanyId,
      companyId: otherCompanyId,
      name: "Other Company Workflow",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
    });

    // Add decision with cross-company sourceRef
    const commentId = randomUUID();
    const decision = {
      missionId,
      selectedExecutionUnits: [
        {
          id: `wf:${wfOtherCompanyId}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Selected",
          sourceRef: { type: "workflow_definition_step", id: wfOtherCompanyId, stepId: "smoke" },
        },
      ],
    };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");

    // No new revision
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1); // only initial plan
    expect(plans[0]!.revision).toBe(1);

    // No activity
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  it("rejects PLAN mission units assigned to non-runnable agents", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const errorAgentId = randomUUID();
    await db.insert(agents).values({
      id: errorAgentId,
      companyId,
      name: "Unavailable Agent",
      role: "worker",
      status: "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({
        missionId,
        missionGoal: "Do not dispatch to unavailable agents",
        selectedExecutionUnits: [
          {
            id: "unit-error-agent",
            kind: "mission_plan_unit",
            title: "Should not run",
            assigneeAgentId: errorAgentId,
            sourceRef: { type: "mission_plan_unit", id: "unit-error-agent" },
          },
        ],
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      }),
      createdAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("invalid_selected_execution_unit_source_ref");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "assignee_agent_not_runnable",
        message: expect.stringContaining("status=error"),
      }),
    ]);

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Do not dispatch to unavailable agents"));
    expect(paqoDefinitions).toHaveLength(0);
  });

  it("materializes PLAN mission units assigned to currently running agents", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const runningAgentId = randomUUID();
    await db.insert(agents).values({
      id: runningAgentId,
      companyId,
      name: "Busy but runnable agent",
      role: "worker",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({
        missionId,
        missionGoal: "Dispatch after current run",
        selectedExecutionUnits: [
          {
            id: "unit-running-agent",
            kind: "mission_plan_unit",
            title: "Run after current assignment",
            assigneeAgentId: runningAgentId,
            sourceRef: { type: "mission_plan_unit", id: "unit-running-agent" },
          },
        ],
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      }),
      createdAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Dispatch after current run"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoSteps = paqoDefinitions[0]!.stepsJson as Array<{ agentId: string }>;
    expect(paqoSteps[0]?.agentId).toBe(runningAgentId);
  });

  it("omits malformed assessment without blocking valid plan materialization", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Assessment Workflow" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({
        missionId,
        selectedExecutionUnits: [
          {
            id: `wf:${wfId}:step:run`,
            kind: "workflow_definition_step",
            selectionState: "selected",
            reason: "Required",
            sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "run" },
          },
        ],
        assessment: { ...validAssessment, assetEvaluation: "not-an-array" },
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(2);
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan!.revision).toBe(2);
    const refs = activePlan!.refs as Record<string, unknown>;
    expect(refs.ownerPlanDecision).toMatchObject({
      planningIssueId,
      decisionHash: expect.any(String),
      assessment: expect.objectContaining({
        objectiveRestatement: validAssessment.objectiveRestatement,
        gaps: validAssessment.gaps,
      }),
    });
    expect((refs.ownerPlanDecision as Record<string, unknown>).assessment).not.toHaveProperty("assetEvaluation");

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
  });

  // Test 4: Existing legacy refs preserved/merged
  it("preserves existing v2 legacy refs and merges with v3 selectedExecutionUnits", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create referenced workflow definitions
    const wfLegacyId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfLegacyId,
      companyId,
      name: "Legacy Workflow",
    });

    // Create initial plan with v2 legacy refs
    await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: {
        schemaVersion: 2,
        executionUnits: [
          { sourceRef: { type: "native_workflow_run", id: "run-legacy-1" }, status: "completed" },
        ],
        ruleRefs: [{ id: "approval-before-publish", mode: "approval_gate" }],
        oversightIssueId: "legacy-issue-1",
      },
      requiredInputs: [{ key: "qa-owner", status: "missing" }],
      successCriteria: [{ description: "Legacy criterion" }],
      steps: [{ id: "legacy-step", title: "Legacy step", status: "completed" }],
    });

    // Add valid decision with v3 selectedExecutionUnits
    const commentId = randomUUID();
    const decision = {
      missionId,
      missionGoal: "Revised rollout plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfLegacyId}:step:smoke`,
          kind: "workflow_definition_step",
          title: "Run smoke",
          selectionState: "selected",
          reason: "Required",
          sourceRef: { type: "workflow_definition_step", id: wfLegacyId, stepId: "smoke" },
        },
      ],
    };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    const activePlan = plans.find((p) => p.status === "active");
    expect(activePlan).toBeDefined();

    const refs = activePlan!.refs as Record<string, unknown>;
    // v2 executionUnits preserved
    expect(Array.isArray(refs.executionUnits)).toBe(true);
    expect((refs.executionUnits as unknown[]).length).toBe(1);
    // v2 ruleRefs preserved
    expect(Array.isArray(refs.ruleRefs)).toBe(true);
    expect((refs.ruleRefs as unknown[]).length).toBe(1);
    // v3 selectedExecutionUnits added
    expect(Array.isArray(refs.selectedExecutionUnits)).toBe(true);
    expect((refs.selectedExecutionUnits as unknown[]).length).toBe(1);
    // schemaVersion upgraded to 3
    expect(refs.schemaVersion).toBe(3);
    // legacy arbitrary key preserved
    expect(refs.oversightIssueId).toBe("legacy-issue-1");
  });

  // Test 5: Idempotent rerun same decision
  it("returns noop when same authorized decision comment has already been recorded", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    const wfIdemId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfIdemId,
      companyId,
      name: "Idempotency Workflow",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    const commentId = randomUUID();
    const decision = {
      missionId,
      selectedExecutionUnits: [
        {
          id: `wf:${wfIdemId}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "Required",
          sourceRef: { type: "workflow_definition_step", id: wfIdemId, stepId: "run" },
        },
      ],
      assessment: validAssessment,
    };

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    // First call should record
    const result1 = await recordThroughQaPass({ companyId, missionId });
    expect(result1.status).toBe("recorded");

    // Second call should be noop with the same decision hash, including assessment content
    const result2 = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result2.status).toBe("noop");
    expect(result2.decisionHash).toBe(result1.status === "recorded" ? result1.decisionHash : undefined);

    // Verify only one revision was created (plus initial = 2 total plans)
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(2); // initial + one recorded revision

    // Verify only one activity log entry
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(1);
  });

  // Test 6: Later valid authorized decision creates next revision
  it("creates next revision when a newer authorized decision supersedes prior active", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    const wfV1Id = randomUUID();
    const wfV2Id = randomUUID();
    await db.insert(workflowDefinitions).values([
      { id: wfV1Id, companyId, name: "Workflow V1" },
      { id: wfV2Id, companyId, name: "Workflow V2" },
    ]);

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    // First decision comment
    const commentId1 = randomUUID();
    const decision1 = {
      missionId,
      missionGoal: "V1 plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfV1Id}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "First decision",
          sourceRef: { type: "workflow_definition_step", id: wfV1Id, stepId: "run" },
        },
      ],
    };

    await db.insert(issueComments).values({
      id: commentId1,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision1),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result1 = await recordThroughQaPass({ companyId, missionId });
    expect(result1.status).toBe("recorded");
    if (result1.status !== "recorded") return;
    expect(result1.revision).toBe(2);

    // Second (newer) decision comment
    const commentId2 = randomUUID();
    const decision2 = {
      missionId,
      missionGoal: "V2 updated plan",
      selectedExecutionUnits: [
        {
          id: `wf:${wfV2Id}:step:run`,
          kind: "workflow_definition_step",
          selectionState: "selected",
          reason: "Second decision",
          sourceRef: { type: "workflow_definition_step", id: wfV2Id, stepId: "run" },
        },
      ],
    };

    await db.insert(issueComments).values({
      id: commentId2,
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment(decision2),
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const result2 = await recordThroughQaPass({ companyId, missionId });
    expect(result2.status).toBe("recorded");
    if (result2.status !== "recorded") return;
    expect(result2.revision).toBe(3);
    expect(result2.commentId).toBe(commentId2);

    // Verify plan history
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(3);
    const active = plans.find((p) => p.status === "active");
    expect(active!.revision).toBe(3);
    expect(active!.missionGoal).toBe("V2 updated plan");

    // Verify 2 activity log entries
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(2);
  });

  // Test 7: Non-planning issue JSON-looking comment ignored via collector
  it("ignores JSON-looking comments on non-planning issues and returns noop", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    // Create a non-planning issue
    const workflowIssueId = randomUUID();
    await db.insert(issues).values({
      id: workflowIssueId,
      companyId,
      missionId,
      title: "Workflow execution issue",
      originKind: "workflow_execution",
      status: "in_progress",
    });

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });

    // Add JSON-looking decision comment on NON-planning issue
    await db.insert(issueComments).values({
      companyId,
      issueId: workflowIssueId,
      authorAgentId: ownerAgentId,
      body: decisionComment({
        missionId,
        selectedExecutionUnits: [
          {
            id: "wf:wf-fake:step:run",
            selectionState: "selected",
            reason: "Should be ignored",
            sourceRef: { type: "workflow_definition_step", id: "wf-fake", stepId: "run" },
          },
        ],
      }),
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.reason).toBe("no_authorized_decision");
      expect(result.planningIssueId).toBe(planningIssueId);
    }

    // No new revision
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1); // only initial plan

    // No activity
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  it("treats Markdown-only planning comments as noop unless a structured JSON decision block exists", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();

    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId });
    await db.insert(issueComments).values({
      companyId,
      issueId: planningIssueId,
      authorAgentId: ownerAgentId,
      body: `### Mission Planning Assessment\n\nReady to plan, but this is only prose and has no accepted decision JSON block.`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("noop");
    if (result.status === "noop") {
      expect(result.reason).toBe("no_authorized_decision");
      expect(result.planningIssueId).toBe(planningIssueId);
    }

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.revision).toBe(1);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mission.owner_plan.recorded"));
    expect(activities).toHaveLength(0);
  });

  // ── Plan-QA gate tests (QA reviewer 가 있으면 게이트 활성) ──

  async function seedQaFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Plan QA Gate Company", issuePrefix: `PQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
      { id: qaAgentId, companyId, name: "Report Validator", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    ]);
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Plan QA Source Workflow", stepsJson: [{ id: "scout", name: "Scout", dependencies: [] }] });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan QA mission", status: "active" });
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Mission owner planning", originKind: "mission_main_executor_plan", status: "todo" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    return { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId };
  }

  async function postDecisionComment(opts: { companyId: string; issueId: string; authorAgentId: string; missionId: string; sourceWorkflowId: string; unitId?: string }) {
    const decision = {
      ...validDecision,
      missionId: opts.missionId,
      selectedExecutionUnits: [{
        id: opts.unitId ?? "unit-1",
        kind: "workflow_definition_step",
        title: "Run smoke",
        reason: "source evidence",
        sourceRef: { type: "workflow_definition_step", id: opts.sourceWorkflowId, stepId: "scout" },
      }],
    };
    await db.insert(issueComments).values({ companyId: opts.companyId, issueId: opts.issueId, authorAgentId: opts.authorAgentId, body: decisionComment(decision) });
  }

  async function postPlanQaVerdict(opts: { companyId: string; missionId: string; verdict: "pass" | "request_changes"; authorAgentId: string; detail?: string }) {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: opts.companyId, missionId: opts.missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    const issueId = planQa?.issueId;
    if (!issueId) throw new Error("no active PLAN-QA issue to verdict");
    const body = opts.verdict === "pass" ? "Plan is sound.\nPASS" : `Plan has gaps.\nREQUEST_CHANGES: ${opts.detail ?? "needs work"}`;
    await db.insert(issueComments).values({ companyId: opts.companyId, issueId, authorAgentId: opts.authorAgentId, body });
  }

  async function countWorkflowDefinitions(companyId: string) {
    const rows = await db.select({ id: workflowDefinitions.id }).from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.name, `PAQO WBS: ${validDecision.missionGoal}`)));
    return rows.length;
  }

  // Plan-QA gate 가 항상 켜져 있으므로, materialization 을 assert 하는 기존 테스트는
  // record → (PLAN-QA PASS 심기) → record 재호입 2-phase 로 구워야 materialize 된다.
  async function recordThroughQaPass(opts: { companyId: string; missionId: string }) {
    let result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: opts.companyId, missionId: opts.missionId });
    if (result.status === "plan_qa_pending") {
      const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: opts.companyId, missionId: opts.missionId });
      const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
      if (planQa?.issueId) {
        await db.insert(issueComments).values({ companyId: opts.companyId, issueId: planQa.issueId, authorUserId: "board-user-test", body: "Plan is sound.\nPASS" });
      }
      result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: opts.companyId, missionId: opts.missionId });
    }
    return result;
  }

  it("plan-QA gate: a new decision creates a [PLAN-QA] issue and defers materialization (pending)", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    expect(result.status).toBe("plan_qa_pending");

    const planQaIssues = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa")));
    expect(planQaIssues).toHaveLength(1);
    expect(planQaIssues[0]!.assigneeAgentId).toBe(qaAgentId);
    expect(planQaIssues[0]!.description).toContain("PASS");
    expect(planQaIssues[0]!.description).toContain("REQUEST_CHANGES");
    expect(enqueuePlanQaWakeup).toHaveBeenCalledTimes(1);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      issueId: planQaIssues[0]!.id,
      issueStatus: "todo",
      missionId,
      planningIssueId,
    }));
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: PASS verdict materializes the PAQO workflow and records verdict=pass", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId });

    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
    const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs.length).toBeGreaterThan(0);
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { verdict?: string } | undefined;
    expect(planQa?.verdict).toBe("pass");
    const [planQaIssue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue.status).toBe("done");
  });

  it("plan-QA gate: REQUEST_CHANGES blocks materialization and reopens the PLAN issue to actionable", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, planningIssueId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    await postPlanQaVerdict({ companyId, missionId, verdict: "request_changes", authorAgentId: qaAgentId });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_changes_requested");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, planningIssueId));
    expect(planIssue.status).toBe("in_progress");
    const [planQaIssue] = await db.select({ status: issues.status }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue.status).toBe("done");
  });

  it("plan-QA gate: the newest authorized explicit verdict wins by createdAt even when an older PASS is inserted later", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, planningIssueId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    expect(planQa?.issueId).toBeDefined();
    await db.insert(issueComments).values({
      companyId,
      issueId: planQa!.issueId!,
      authorAgentId: qaAgentId,
      body: "Newer review found a blocking gap.\nREQUEST_CHANGES: add publish smoke QA",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: planQa!.issueId!,
      authorAgentId: qaAgentId,
      body: "Older optimistic review.\nPASS",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_changes_requested");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, planningIssueId));
    expect(planIssue.status).toBe("in_progress");
  });

  it("plan-QA gate: ignores PASS verdicts from non-QA agents", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    expect(planQa?.issueId).toBeDefined();
    await db.insert(issueComments).values({
      companyId,
      issueId: planQa!.issueId!,
      authorAgentId: ownerAgentId,
      body: "Mission owner tries to approve their own plan.\nPASS",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const unauthorizedPass = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(unauthorizedPass.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    await db.insert(issueComments).values({
      companyId,
      issueId: planQa!.issueId!,
      authorAgentId: qaAgentId,
      body: "QA approves after review.\nPASS",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });

    const qaPass = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(qaPass.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("plan-QA gate: reprocessing the same decision hash does not duplicate the [PLAN-QA] issue and stays deferred", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    const second = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });
    expect(second.status).toBe("plan_qa_pending");

    const planQaIssues = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa")));
    expect(planQaIssues).toHaveLength(1);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledTimes(2);
    expect(enqueuePlanQaWakeup).toHaveBeenLastCalledWith(expect.objectContaining({
      issueId: planQaIssues[0]!.id,
      missionId,
      planningIssueId,
    }));
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: a PASS verdict on an older decision hash does not pass a newer decision (no stale PASS leak)", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #1 (hash A)
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId }); // PASS on hash A gate

    // newer decision (hash B) — must NOT be passed by the stale hash-A PASS
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId, unitId: "unit-2" });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
  });

  it("plan-QA gate: after REQUEST_CHANGES a revised decision opens a new gate and materializes only on its own PASS", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #1
    await postPlanQaVerdict({ companyId, missionId, verdict: "request_changes", authorAgentId: qaAgentId });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // changes_requested
    expect(await countWorkflowDefinitions(companyId)).toBe(0);

    // revised decision (new hash) -> new gate
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId, unitId: "unit-2" });
    await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId }); // pending #2
    await postPlanQaVerdict({ companyId, missionId, verdict: "pass", authorAgentId: qaAgentId }); // PASS on new gate
    const result = await recordThroughQaPass({ companyId, missionId });
    expect(result.status).toBe("recorded");
    expect(await countWorkflowDefinitions(companyId)).toBeGreaterThan(0);
  });

  it("plan-QA gate: a qa-role agent with status=idle is still selected as reviewer and the gate applies", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    const [qa] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "qa"))).limit(1);
    if (qa) await db.update(agents).set({ status: "idle" }).where(eq(agents.id, qa.id));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    expect(await countWorkflowDefinitions(companyId)).toBe(0);
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBe(qa?.id ?? null);
  });

  it("plan-QA gate: a qa-role agent with status=running is still selected and queued", async () => {
    const { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId } = await seedQaFixture();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, qaAgentId));
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });
    const enqueuePlanQaWakeup = vi.fn();

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });

    expect(result.status).toBe("plan_qa_pending");
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBe(qaAgentId);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      missionId,
      planningIssueId,
    }));
  });

  it("plan-QA gate: reprocessing an unassigned gate assigns a newly available reviewer and queues it", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const sourceWorkflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Recover Plan QA Source Workflow", stepsJson: [{ id: "run", name: "Run", dependencies: [] }] });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    await postDecisionComment({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, missionId, sourceWorkflowId });

    const initial = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(initial.status).toBe("plan_qa_pending");
    const [unassignedPlanQaIssue] = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(unassignedPlanQaIssue).toBeDefined();
    expect(unassignedPlanQaIssue.assigneeAgentId).toBeNull();

    const qaAgentId = randomUUID();
    await db.insert(agents).values({
      id: qaAgentId,
      companyId,
      name: "Late Report Validator",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    const enqueuePlanQaWakeup = vi.fn();
    const recovered = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId, enqueuePlanQaWakeup });

    expect(recovered.status).toBe("plan_qa_pending");
    const [recoveredPlanQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(eq(issues.id, unassignedPlanQaIssue.id)).limit(1);
    expect(recoveredPlanQaIssue.assigneeAgentId).toBe(qaAgentId);
    expect(enqueuePlanQaWakeup).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId: qaAgentId,
      issueId: unassignedPlanQaIssue.id,
      missionId,
      planningIssueId,
    }));
  });

  it("plan-QA gate: with no qa/reviewer/validator agent the [PLAN-QA] issue is created unassigned and materialization stays blocked", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedFullMissionFixture();
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "NoQA Source Workflow", stepsJson: [{ id: "run", name: "Run", dependencies: [] }] });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "unit-1", kind: "workflow_definition_step", title: "Run smoke", reason: "x", sourceRef: { type: "workflow_definition_step", id: wfId, stepId: "run" } }] };
    await db.insert(issueComments).values({ companyId, issueId: planningIssueId, authorAgentId: ownerAgentId, body: decisionComment(decision) });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result.status).toBe("plan_qa_pending");
    const [planQaIssue] = await db.select({ assigneeAgentId: issues.assigneeAgentId, description: issues.description }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"))).limit(1);
    expect(planQaIssue).toBeDefined();
    expect(planQaIssue.assigneeAgentId).toBeNull();
    expect(planQaIssue.description).toContain("QA reviewer assignment required");
  });
});
