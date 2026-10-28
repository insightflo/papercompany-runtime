import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, operatorDecisions } from "@paperclipai/db";
import {
  loadApplyRequestRows,
  loadApplyRunRow,
  resetReviewedPolicies,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  TEST_REVIEWED_POLICIES,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-resume-apply-fixture.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { TERMINAL_RESUME_OPTION_ID } from "../services/missions/terminal-resume-from-decision.js";

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

describe("operator decision resume atomic transaction", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("opdec-resume-atomic-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(() => resetReviewedPolicies());

  async function createResumeDecision(prefix: string) {
    const scenario = await seedResumeApplyScenario(db, sql, prefix);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: scenario.companyId,
      missionId: scenario.missionId,
      title: "Resume failed workflow",
      status: "blocked",
      assigneeAgentId: scenario.agentId,
      originKind: "mission_main_executor_unblock",
    });
    const created = await operatorDecisionWriteService(db).create(scenario.companyId, {
      schemaVersion: 1,
      requestKey: `resume:${scenario.runId}`,
      priority: "high",
      interactionType: "single_select",
      title: "Resume?",
      description: "Resume the failed run",
      sourceType: "terminal_mission_report_v1",
      sourceId: scenario.runId,
      sourceContext: {
        missionId: scenario.missionId,
        workflowId: scenario.workflowId,
        workflowRunId: scenario.runId,
        artifactRefs: [],
      },
      definition: {
        options: [{ id: TERMINAL_RESUME_OPTION_ID, label: "Resume", description: "Resume",
          facts: [], evidenceRefs: [] }],
        actions: [{ id: "submit", label: "Submit", outcome: "submit", tone: "primary",
          requiresSelection: true }],
        selection: { min: 1, max: 1 },
        comment: { mode: "optional", label: "Reason", placeholder: null, maxLength: 100 },
        approvedScope: ["operator_decision.resolve"],
        forbiddenScope: [],
        humanReview: {
          schemaVersion: "human-review-v1",
          decisionSubject: "Resume?",
          evidence: [{ label: "Failed run", href: `/runs/${scenario.runId}`, location: scenario.runId }],
          interpretation: "Resume the failed run.",
          impact: { ifApproved: "The failed run resumes.", ifRejected: "It stays failed.",
            ifWrong: "A step may repeat." },
          unresolvedFacts: [], questions: ["Resume?"], recommendedNextStep: "Resume",
          requiredReviewer: "human-operator",
        },
      },
      issueId,
      continuationMode: "issue_current_assignee",
    }, { type: "user", id: "board-user" });
    return { scenario, decisionId: created.decision.id };
  }

  it("commits the decision and resume together without a continuation", async () => {
    const { scenario, decisionId } = await createResumeDecision("commit-");
    const previousKey = process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY;
    process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY = createHash("sha256")
      .update("resume-apply-test-key").digest("hex");
    try {
      const resolved = await operatorDecisionWriteService(db).resolve(decisionId, {
        actionId: "submit", selectedOptionIds: [TERMINAL_RESUME_OPTION_ID], comment: null,
      }, "board-user");
      expect(resolved.applied).toBe(true);
      expect(resolved.continuation).toBeNull();
      expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
      expect(await loadApplyRunRow(sql, scenario.runId)).toMatchObject({ status: "running" });
      const [stored] = await db.select({ status: operatorDecisions.status })
        .from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
      expect(stored.status).toBe("resolved");
    } finally {
      if (previousKey === undefined) delete process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY;
      else process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY = previousKey;
    }
  });

  it("rolls back the decision when resume authority is unavailable", async () => {
    const { scenario, decisionId } = await createResumeDecision("rollback-");
    const previousKey = process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY;
    delete process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY;
    try {
      await expect(operatorDecisionWriteService(db).resolve(decisionId, {
        actionId: "submit", selectedOptionIds: [TERMINAL_RESUME_OPTION_ID], comment: null,
      }, "board-user")).rejects.toMatchObject({ status: 503, message: "resume_unavailable" });
      const [stored] = await db.select({ status: operatorDecisions.status })
        .from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
      expect(stored.status).toBe("pending");
      expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
      expect(await loadApplyRunRow(sql, scenario.runId)).toMatchObject({ status: "failed" });
    } finally {
      if (previousKey === undefined) delete process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY;
      else process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY = previousKey;
    }
  });
});
