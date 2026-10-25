import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, issues, missions, operatorDecisions,
  workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";

describe("operator decision restart transaction (PostgreSQL)", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("operator-restart-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
  });

  it("commits the approval, fresh run and blocked-issue release together", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), sourceRunId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart", issuePrefix: "RST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
      title: "Restart mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId,
      name: "Restart workflow", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: sourceRunId, workflowId, companyId, missionId,
      status: "failed", triggeredBy: "test", runDate: "2026-10-25", completedAt: new Date() });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "[OVERSIGHT] Restart",
      status: "blocked", assigneeAgentId: agentId, originKind: "mission_main_executor_oversight" });

    const definition = {
      options: [{ id: WORKFLOW_RESTART_FROM_START_OPTION_ID, label: "Restart", description: "Start again",
        facts: [], evidenceRefs: [] }],
      actions: [{ id: "approve", label: "Approve", outcome: "approve" as const,
        tone: "primary" as const, requiresSelection: true }],
      selection: { min: 1, max: 1 },
      comment: { mode: "optional" as const, label: "Reason", placeholder: null, maxLength: 100 },
      approvedScope: ["operator_decision.resolve", "workflow_run.restart_from_start"], forbiddenScope: [],
      humanReview: { schemaVersion: "human-review-v1" as const, decisionSubject: "Restart?",
        evidence: [{ label: "Failed run", href: `/runs/${sourceRunId}`, location: sourceRunId }],
        interpretation: "Start a fresh run from the beginning.",
        impact: { ifApproved: "A fresh run starts.", ifRejected: "The mission remains blocked.",
          ifWrong: "Work can be repeated." }, unresolvedFacts: [], questions: ["Restart?"],
        recommendedNextStep: "Restart", requiredReviewer: "human-operator" },
    };
    const write = operatorDecisionWriteService(db);
    const created = await write.create(companyId, {
      schemaVersion: 1, requestKey: `restart:${sourceRunId}`, priority: "high",
      interactionType: "single_select", title: "Restart?", description: "",
      sourceType: "workflow_restart_request_v1", sourceId: sourceRunId,
      sourceContext: { missionId, workflowId, workflowRunId: sourceRunId, artifactRefs: [] },
      definition, issueId, continuationMode: "none",
    }, { type: "user", id: "board-user" });

    const resolved = await write.resolve(created.decision.id, {
      actionId: "approve", selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID], comment: "approved",
    }, "board-user");

    expect(resolved.applied).toBe(true);
    const [storedDecision] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.id, created.decision.id));
    expect(storedDecision.status).toBe("resolved");
    const replacement = await db.select().from(workflowRuns).where(and(
      eq(workflowRuns.missionId, missionId), ne(workflowRuns.id, sourceRunId)));
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.metadata).toMatchObject({ operatorDecisionRestart: {
      operatorDecisionId: created.decision.id, sourceWorkflowRunId: sourceRunId,
    } });
    const [oversight] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(oversight.status).not.toBe("blocked");
  });
});
