import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getMissionRecoveryAdvice } from "../services/missions/mission-recovery-advice.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("mission-recovery-advice-loader-");
}, 60_000);

afterAll(async () => {
  await tempDb?.cleanup();
});

describeEP("getMissionRecoveryAdvice PLAN-QA active generation scope", () => {
  let db!: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(tempDb!.connectionString);
  });

  afterEach(async () => {
    await db.delete(missionPlanQaVerdicts);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("ignores older plan-QA issue/hash RC; active refs.planQa generation controls", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const oldPlanQaIssueId = randomUUID();
    const activePlanQaIssueId = randomUUID();
    const activeHash = "decision-hash-active";
    const oldHash = "decision-hash-old";

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery advice loader company",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Active plan QA scope mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: producerIssueId,
        companyId,
        missionId,
        title: "Producer unit",
        status: "done",
        originKind: "workflow_execution",
        assigneeAgentId: null,
      },
      {
        id: oldPlanQaIssueId,
        companyId,
        missionId,
        title: "Old plan QA",
        status: "done",
        originKind: "mission_plan_qa",
        originId: producerIssueId,
        assigneeAgentId: null,
      },
      {
        id: activePlanQaIssueId,
        companyId,
        missionId,
        title: "Active plan QA",
        status: "done",
        originKind: "mission_plan_qa",
        originId: producerIssueId,
        assigneeAgentId: null,
      },
    ]);
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 2,
      status: "active",
      ownerAgentId,
      missionGoal: "Ship with active plan QA generation",
      refs: {
        planQa: {
          issueId: activePlanQaIssueId,
          decisionHash: activeHash,
          status: "pending",
        },
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    await db.insert(missionPlanQaVerdicts).values([
      {
        companyId,
        missionId,
        planQaIssueId: oldPlanQaIssueId,
        decisionHash: oldHash,
        verdict: "request_changes",
        diagnostics: [{ message: "OLD_ISSUE_RC_must_not_drive" }],
        sourceCommentId: null,
        updatedAt: new Date("2026-07-23T02:00:00.000Z"),
        createdAt: new Date("2026-07-23T02:00:00.000Z"),
      },
      {
        companyId,
        missionId,
        planQaIssueId: activePlanQaIssueId,
        decisionHash: oldHash,
        verdict: "request_changes",
        diagnostics: [{ message: "OLD_HASH_RC_must_not_drive" }],
        sourceCommentId: null,
        updatedAt: new Date("2026-07-23T02:00:00.000Z"),
        createdAt: new Date("2026-07-23T02:00:00.000Z"),
      },
      {
        companyId,
        missionId,
        planQaIssueId: activePlanQaIssueId,
        decisionHash: activeHash,
        verdict: "request_changes",
        diagnostics: [{ message: "ACTIVE_GENERATION_RC_controls" }],
        sourceCommentId: null,
        updatedAt: new Date("2026-07-23T01:00:00.000Z"),
        createdAt: new Date("2026-07-23T01:00:00.000Z"),
      },
    ]);

    const advice = await getMissionRecoveryAdvice(db, { companyId, missionId });
    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.id).toBe(producerIssueId);
    expect(advice.leafCause).toContain("ACTIVE_GENERATION_RC_controls");
    expect(advice.leafCause).not.toContain("OLD_ISSUE_RC_must_not_drive");
    expect(advice.leafCause).not.toContain("OLD_HASH_RC_must_not_drive");
  });

  it("fails closed when active planQa binding is missing or malformed", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const planQaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery advice missing binding company",
      issuePrefix: `RM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Missing planQa binding mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: producerIssueId,
        companyId,
        missionId,
        title: "Producer unit",
        status: "done",
        originKind: "workflow_execution",
        assigneeAgentId: null,
      },
      {
        id: planQaIssueId,
        companyId,
        missionId,
        title: "Plan QA",
        status: "done",
        originKind: "mission_plan_qa",
        originId: producerIssueId,
        assigneeAgentId: null,
      },
    ]);
    // Active plan exists but planQa binding is incomplete (issueId only).
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "No complete planQa binding",
      refs: { planQa: { issueId: planQaIssueId, status: "pending" } },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    await db.insert(missionPlanQaVerdicts).values({
      companyId,
      missionId,
      planQaIssueId,
      decisionHash: "hash-orphaned",
      verdict: "request_changes",
      diagnostics: [{ message: "ORPHAN_RC_must_not_drive_without_active_binding" }],
      sourceCommentId: null,
    });

    const advice = await getMissionRecoveryAdvice(db, { companyId, missionId });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
    expect(advice.leafCause ?? "").not.toContain("ORPHAN_RC_must_not_drive_without_active_binding");
  });

  it("ignores PLAN-QA RC for a different plan issue than active refs.planQa.issueId", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const activePlanQaIssueId = randomUUID();
    const otherPlanQaIssueId = randomUUID();
    const activeHash = "decision-hash-active";

    await db.insert(companies).values({
      id: companyId,
      name: "Recovery advice wrong issue company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Wrong planQa issue mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: producerIssueId,
        companyId,
        missionId,
        title: "Producer unit",
        status: "done",
        originKind: "workflow_execution",
        assigneeAgentId: null,
      },
      {
        id: activePlanQaIssueId,
        companyId,
        missionId,
        title: "Active plan QA",
        status: "todo",
        originKind: "mission_plan_qa",
        originId: producerIssueId,
        assigneeAgentId: null,
      },
      {
        id: otherPlanQaIssueId,
        companyId,
        missionId,
        title: "Other plan QA",
        status: "done",
        originKind: "mission_plan_qa",
        originId: producerIssueId,
        assigneeAgentId: null,
      },
    ]);
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Active binding points at empty generation",
      refs: {
        planQa: {
          issueId: activePlanQaIssueId,
          decisionHash: activeHash,
          status: "pending",
        },
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
    });
    // RC only on a different plan-QA issue (same hash shape) must not drive advice.
    await db.insert(missionPlanQaVerdicts).values({
      companyId,
      missionId,
      planQaIssueId: otherPlanQaIssueId,
      decisionHash: activeHash,
      verdict: "request_changes",
      diagnostics: [{ message: "OTHER_ISSUE_RC_must_not_drive" }],
      sourceCommentId: null,
    });

    const advice = await getMissionRecoveryAdvice(db, { companyId, missionId });
    expect(advice.decision).not.toBe("producer_rework");
    expect(advice.decision).not.toBe("qa_recheck");
    expect(advice.leafCause ?? "").not.toContain("OTHER_ISSUE_RC_must_not_drive");
  });
});
