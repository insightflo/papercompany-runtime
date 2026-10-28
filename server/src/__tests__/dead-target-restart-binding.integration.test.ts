import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureDeadTargetHumanEscalation } from "../services/missions/mission-owner-dead-target-loop.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

describe("dead-target card structured restart binding", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("dead-target-binding-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
  });

  it("offers restart bound to the failed run and omits prose-derived retry paths", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), workflowRunId = randomUUID();
    const sourceIssueId = randomUUID(), anchorIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dead target binding", issuePrefix: "DTB" });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "Recover dead source", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId,
      name: "Recovery workflow", stepsJson: [{ id: "collect", name: "Collect", dependencies: [] }] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId,
      status: "failed", triggeredBy: "test", completedAt: new Date() });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Dead source", status: "done",
        originKind: "workflow_execution", assigneeAgentId: ownerAgentId },
      { id: anchorIssueId, companyId, missionId, title: "Recovery oversight", status: "blocked",
        originKind: "mission_main_executor_oversight", assigneeAgentId: ownerAgentId },
    ]);
    await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "collect", status: "failed",
      issueId: sourceIssueId });

    const result = await ensureDeadTargetHumanEscalation(db, {
      companyId, missionId, ownerAgentId, loopKey: "retry_source_issue",
      anchors: [{ id: anchorIssueId, status: "blocked", title: "Recovery oversight", identifier: null }],
      ownerActionIssueId: anchorIssueId, sourceIssueId,
      reason: "dead target", evidence: "source_terminal",
    });
    expect(result).toEqual({ ensured: true, reason: "card-created" });
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, companyId));
    expect(card.sourceContext.workflowRunId).toBe(workflowRunId);
    expect(card.definition.options.map((option) => option.id)).toEqual([
      WORKFLOW_RESTART_FROM_START_OPTION_ID,
    ]);
    expect(card.definition.approvedScope).toContain("workflow_run.restart_from_start");
    expect(card.definition.options.some((option) => option.id === "retry-a-different-live-source"))
      .toBe(false);

    const resolved = await operatorDecisionWriteService(db).resolve(card.id, {
      actionId: "submit",
      selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID],
      comment: "restart with the bound failed run",
    }, "board-user");
    expect(resolved.applied).toBe(true);
    expect(resolved.continuation).toBeNull();
    const replacements = await db.select().from(workflowRuns).where(and(
      eq(workflowRuns.missionId, missionId),
      ne(workflowRuns.id, workflowRunId),
    ));
    expect(replacements).toHaveLength(1);
    expect(replacements[0]!.metadata).toMatchObject({ operatorDecisionRestart: {
      operatorDecisionId: card.id, sourceWorkflowRunId: workflowRunId,
    } });
  });
});
