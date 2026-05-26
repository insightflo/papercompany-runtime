import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues, missions } from "@paperclipai/db";
import {
  findLatestAuthorizedMissionOwnerPlanDecision,
  parseMissionOwnerPlanDecision,
} from "../services/mission-owner-plan-decisions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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
        runtimeConfig: {},
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
        runtimeConfig: {},
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
