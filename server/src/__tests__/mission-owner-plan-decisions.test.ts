
// zz-t7-fixture: PLAN-QA manifest attachments create assets rows (no company FK cascade).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentRuntimeState, agentWakeupRequests, agents, assets, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, missionDelegations, missionPlanArtifacts, missions, plugins, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { findLatestAuthorizedMissionOwnerPlanDecision, hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { registerOwnerPlanParseCases } from "./helpers/owner-plan-parse-cases.js";
import { registerOwnerPlanDraftCasesA } from "./helpers/owner-plan-draft-cases-a.js";
import { registerOwnerPlanDraftCasesB } from "./helpers/owner-plan-draft-cases-b.js";
import { registerOwnerPlanDraftCasesC } from "./helpers/owner-plan-draft-cases-c.js";
import { registerOwnerPlanRecordValidationLedgerCases } from "./helpers/owner-plan-record-validation-ledger-cases.js";
import { registerOwnerPlanRecordQaGateCases } from "./helpers/owner-plan-record-qa-gate-cases.js";
import { registerOwnerPlanRecordMaterializeCasesA } from "./helpers/owner-plan-record-materialize-cases-a.js";
import { registerOwnerPlanRecordMaterializeCasesB } from "./helpers/owner-plan-record-materialize-cases-b.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// [T7 격리] recordLatest 가 PLAN-QA manifest 를 StorageService 에 기록하므로 기본 인스턴스
// storage(~/.paperclip) 대신 suite 전용 임시 디렉터리로 돌린다(T12 전역 주입 전 임시 차단).
let planQaStorageRoot: string | null = null;
beforeAll(async () => {
  planQaStorageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-mopd-storage-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", planQaStorageRoot);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (planQaStorageRoot) await rm(planQaStorageRoot, { recursive: true, force: true });
});

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

function planQaScorecardPassComment() {
  return `## Plan QA Verdict - test

### Scorecard

| Area | Score (0-2) | Evidence | Required fix if below 2 |
|---|---:|---|---|
| Goal coverage | 2 | Covered by concrete units. | - |
| Step split / sequencing | 2 | Dependencies are explicit. | - |
| Agent fit | 2 | Assignees match roles. | - |
| Instruction quality | 2 | Instructions are actionable. | - |
| Skill fit | 2 | Skills match the work. | - |
| Tool / permission fit | 2 | Required tools are available. | - |
| Work-product contract | 2 | Outputs are explicit. | - |
| QA / recovery design | 2 | QA and recovery are separated. | - |

### Summary

The plan is complete and well-structured. All checklist items pass.`;
}


describe("parseMissionOwnerPlanDecision", () => {
  registerOwnerPlanParseCases(validDecision);
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
    await db.delete(assets);
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

  it("returns the owner-agent decision recorded on the canonical planning issue", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "owner-unit" }] };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorAgentId: ownerAgentId, decisionHash: "owner-hash", decision, status: "submitted" });

    const result = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result).toMatchObject({
      ok: true,
      decision,
      planningIssueId,
      decisionIssueId: planningIssueId,
      decisionIssueOriginKind: "mission_main_executor_plan",
      commentId: null,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [],
    });
    expect(result.ok && result.submissionId).toEqual(expect.any(String));
  });

  it("accepts a board/user decision recorded on the planning issue as full-control operator context", async () => {
    const { companyId, missionId, planningIssueId } = await seedMissionFixture();
    const boardUserId = "board-user-1";
    const decision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "board-unit" }] };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorUserId: boardUserId, decisionHash: "board-hash", decision, status: "submitted" });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId })).resolves.toMatchObject({
      ok: true,
      decision,
      planningIssueId,
      author: { kind: "user", id: boardUserId },
    });
  });

  it("ignores an unauthorized-author submission and returns the latest authorized one", async () => {
    const { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const ownerDecision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "owner-old" }] };
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorAgentId: ownerAgentId, decisionHash: "owner-hash", decision: ownerDecision, status: "submitted" });
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorAgentId: otherAgentId, decisionHash: "other-hash", decision: { ...validDecision, missionId, selectedExecutionUnits: [{ id: "other-new" }] }, status: "submitted" });

    const result = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
    expect(result).toMatchObject({
      ok: true,
      decision: ownerDecision,
      planningIssueId,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [{ code: "unauthorized_author" }],
    });
  });

  it("ignores a decision submission bound to a stale/other planning issue and fails closed", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const stalePlanningIssueId = randomUUID();
    // older planning issue; the current (latest) planning issue stays planningIssueId
    await db.insert(issues).values({ id: stalePlanningIssueId, companyId, missionId, title: "Old planning", originKind: "mission_main_executor_plan", status: "done", createdAt: new Date("2020-01-01T00:00:00.000Z") });
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId: stalePlanningIssueId, authorAgentId: ownerAgentId, decisionHash: "stale-planning-hash", decision: { ...validDecision, missionId, selectedExecutionUnits: [{ id: "stale-unit" }] }, status: "submitted" });

    await expect(findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId })).resolves.toMatchObject({
      ok: false,
      reason: "no_authorized_decision",
      planningIssueId,
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

  it("skips a rejected submission and falls back to an older accepted one", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId } = await seedMissionFixture();
    const olderDecision = { ...validDecision, missionId, selectedExecutionUnits: [{ id: "older-valid" }] };

    // older accepted (owner) submission
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorAgentId: ownerAgentId, decisionHash: "valid-hash", decision: olderDecision, status: "submitted" });
    // newer rejected submission is ignored by the reader
    await upsertMissionPlanDecisionSubmission({ db, companyId, missionId, planningIssueId, authorAgentId: ownerAgentId, decisionHash: "rejected-hash", decision: { ...validDecision, missionId, selectedExecutionUnits: [{ id: "newer-rejected" }] }, status: "rejected", rejectionReason: "invalid_decision_shape" });

    const result = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });

    expect(result).toMatchObject({
      ok: true,
      decision: olderDecision,
      planningIssueId,
      author: { kind: "agent", id: ownerAgentId },
      diagnostics: [{ code: "rejected_submission" }],
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

  registerOwnerPlanDraftCasesA(baseDecision, baseArgs);
  registerOwnerPlanDraftCasesB(baseDecision, baseArgs);
  registerOwnerPlanDraftCasesC(baseDecision, baseArgs, validAssessment);
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
    setWorkflowToolStepExecutor(null);
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
    await db.delete(plugins);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(assets);
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

  async function seedReadyResearchWorkbenchPlugin() {
    await db.insert(plugins).values({
      id: randomUUID(),
      pluginKey: "insightflo.research-workbench",
      packageName: "@insightflo/paperclip-research-workbench",
      version: "0.1.0",
      manifestJson: {
        id: "insightflo.research-workbench",
        displayName: "Research Workbench",
        version: "0.1.0",
        apiVersion: 1,
        description: "Research Workbench",
        author: "InsightFlo",
        categories: ["automation"],
        capabilities: ["agent.tools.register"],
        entrypoints: { worker: "./dist/worker.js" },
        tools: [
          {
            name: "research-search",
            displayName: "Research Search",
            description: "Search the web and return structured evidence bundles.",
            parametersSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                maxResults: { type: "number" },
              },
              required: ["query"],
            },
          },
        ],
      },
      status: "ready",
    });
  }

  registerOwnerPlanRecordMaterializeCasesA({
    getDb: () => db,
    seedFullMissionFixture,
    seedReadyResearchWorkbenchPlugin,
    recordThroughQaPass,
    validAssessment,
  });

  registerOwnerPlanRecordMaterializeCasesB({
    getDb: () => db,
    seedFullMissionFixture,
    recordThroughQaPass,
  });

  registerOwnerPlanRecordValidationLedgerCases({
    getDb: () => db,
    seedFullMissionFixture,
    recordThroughQaPass,
    validAssessment,
    decisionComment,
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
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plan QA mission",
      description: "Select an executable plan for the original business request.",
      status: "active",
    });
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Mission owner planning", originKind: "mission_main_executor_plan", status: "todo" });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    return { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId };
  }

  async function postDecisionComment(opts: { companyId: string; issueId: string; authorAgentId: string; missionId: string; sourceWorkflowId: string; unitId?: string; selectedPlanTemplateIds?: string[] }) {
    const decision = {
      ...validDecision,
      missionId: opts.missionId,
      ...(opts.selectedPlanTemplateIds ? { selectedPlanTemplateIds: opts.selectedPlanTemplateIds } : {}),
      selectedExecutionUnits: [{
        id: opts.unitId ?? "unit-1",
        kind: "workflow_definition_step",
        title: "Run smoke",
        reason: "source evidence",
        selectionState: "selected",
        sourceRef: { type: "workflow_definition_step", id: opts.sourceWorkflowId, stepId: "scout" },
      }],
    };
    // Ledger-only seed (no materialization): the explicit recordLatest call in
    // each test is the actor. Natural-language comments are never plan-decision authority.
    await upsertMissionPlanDecisionSubmission({
      db,
      companyId: opts.companyId,
      missionId: opts.missionId,
      planningIssueId: opts.issueId,
      decision,
      decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      authorAgentId: opts.authorAgentId,
      status: "submitted",
    });
  }

  async function postPlanQaVerdict(opts: { companyId: string; missionId: string; verdict: "pass" | "request_changes"; authorAgentId: string; detail?: string }) {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: opts.companyId, missionId: opts.missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
    const issueId = planQa?.issueId;
    if (!issueId) throw new Error("no active PLAN-QA issue to verdict");
    // Structured authority only: PLAN-QA verdicts must be submitted through the
    // dedicated structured table/API, never parsed from natural-language comments.
    await recordMissionPlanQaVerdict({
      db,
      companyId: opts.companyId,
      missionId: opts.missionId,
      planQaIssueId: issueId,
      decisionHash: planQa?.decisionHash ?? "",
      verdict: opts.verdict,
      diagnostics: opts.verdict === "request_changes" ? [{ code: "request_changes", message: opts.detail ?? "needs work" }] : [],
      reviewedBy: { actorType: "agent", actorId: opts.authorAgentId },
    });
  }

  // Negative-regression helper: a plain human-style comment (PASS / scorecard)
  // that must NEVER be read as an authoritative PLAN-QA verdict (display only).
  async function postPlanQaPlainComment(opts: { companyId: string; missionId: string; authorAgentId: string; verdict: "pass" | "request_changes"; detail?: string }) {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: opts.companyId, missionId: opts.missionId });
    const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string } | undefined;
    const issueId = planQa?.issueId;
    if (!issueId) throw new Error("no active PLAN-QA issue to comment");
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
      const planQa = (plan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; decisionHash?: string } | undefined;
      if (planQa?.issueId && planQa.decisionHash) {
        await recordMissionPlanQaVerdict({ db, companyId: opts.companyId, missionId: opts.missionId, planQaIssueId: planQa.issueId, decisionHash: planQa.decisionHash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "board-user-test" } });
      }
      result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: opts.companyId, missionId: opts.missionId });
    }
    return result;
  }

  registerOwnerPlanRecordQaGateCases({
    getDb: () => db,
    seedFullMissionFixture,
    seedReadyResearchWorkbenchPlugin,
    seedQaFixture,
    postDecisionComment,
    postPlanQaVerdict,
    countWorkflowDefinitions,
    recordThroughQaPass,
    validDecision,
    planQaScorecardPassComment,
  });
});
