import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issues, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { findValidationGateNeedingFreshPass } from "../services/missions/validation-gate-assessment.js";

// No QA keywords/type: only the explicit qaType may establish this gate's role.
describeQualityDb("validation assessment preserves explicit qaType", () => {
  let fixture: QualityTestDb;
  beforeAll(async () => { fixture = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  async function seed(verdict: "pass" | "request_changes" | null, at = "2026-09-01T10:30:00Z", reason = "workflow_api") {
    const db = fixture.db;
    const companyId = randomUUID(), agentId = randomUUID(), definitionId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Assessment", issuePrefix: companyId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker" });
    await db.insert(workflowDefinitions).values({ id: definitionId, companyId, name: "Neutral workflow", stepsJson: [
      { id: "a", dependencies: [], type: "action" },
      { id: "b", dependencies: ["a"], qaType: "semantic", name: "Neutral check" },
      { id: "c", dependencies: ["b"], type: "action" },
    ] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: definitionId, triggeredBy: "test", status: "running" });
    const issueIds = [randomUUID(), randomUUID(), randomUUID()];
    const stepRunIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(issueIds.map((id, i) => ({ id, companyId, title: `Neutral ${i}`,
      originKind: "workflow_execution", status: "done", assigneeAgentId: agentId,
      startedAt: new Date("2026-09-01T09:00:00Z"),
      completedAt: i === 0 ? new Date("2026-09-01T10:00:00Z") : null })));
    await db.insert(workflowStepRuns).values(issueIds.map((issueId, i) => ({
      id: stepRunIds[i]!, workflowRunId: runId, stepId: ["a", "b", "c"][i]!, issueId, status: "completed",
    })));
    if (verdict) {
      const heartbeatRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId: issueIds[1], status: "succeeded" });
      await db.insert(workflowTransitionEvents).values({ companyId, workflowRunId: runId,
        workflowStepRunId: stepRunIds[1], issueId: issueIds[1], heartbeatRunId,
        eventType: "workflow_validation_verdict", layer: "workflow", reason, verdict, createdAt: new Date(at),
      });
    }
    const missionIssues = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const stepRows = await db.select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
      .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
      .where(eq(workflowRuns.id, runId));
    return { db, companyId, missionIssues, stepRows, sourceStepRows: stepRows.filter(row => row.stepRun.stepId === "c") };
  }

  it("requeues the qaType-only gate when authoritative evidence is missing", async () => {
    expect(await findValidationGateNeedingFreshPass(await seed(null))).toMatchObject({
      action: "requeue_validation", verdict: null,
    });
  });
  it("requeues a stale pass older than its producer output", async () => {
    expect(await findValidationGateNeedingFreshPass(await seed("pass", "2026-09-01T09:30:00Z"))).toMatchObject({
      action: "requeue_validation", verdict: { verdict: "pass" }, reason: expect.stringContaining("older than"),
    });
  });
  it("blocks source retry on a fresh authoritative request_changes", async () => {
    expect(await findValidationGateNeedingFreshPass(await seed("request_changes"))).toMatchObject({
      action: "block_source_retry", verdict: { verdict: "request_changes" },
    });
  });
  it("allows the source after a fresh authoritative pass", async () => {
    expect(await findValidationGateNeedingFreshPass(await seed("pass"))).toBeNull();
  });
  it("does not treat a comment-derived pass as authority", async () => {
    expect(await findValidationGateNeedingFreshPass(await seed("pass", "2026-09-01T10:30:00Z", "comment"))).toMatchObject({
      action: "requeue_validation", verdict: null,
    });
  });
});
