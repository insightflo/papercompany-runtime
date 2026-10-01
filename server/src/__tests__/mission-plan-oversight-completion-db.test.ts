import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { buildMissionPlanningDescription } from "../services/missions/mission-planning-description.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

describeQualityDb("template escalation oversight does not block normal completion", () => {
  let fixture: QualityTestDb;
  beforeAll(async () => { fixture = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("settles completed normal steps without creating an oversight issue or wakeup", async () => {
    const db = fixture.db;
    const companyId = randomUUID(), ownerAgentId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Template completion", issuePrefix: companyId });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    const prompt = buildMissionPlanningDescription({ missionId: "mission", title: "Plan", description: null, runnableRosterLines: [] });
    const units = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
      .filter(unit => typeof unit.id === "string" && String(unit.id).startsWith("unit-"))
      .map(unit => ({ ...unit, assigneeAgentId: ownerAgentId }));
    const steps = buildPaqoWorkflowSteps({ missionGoal: "Deliver", successCriteria: [], steps: [], refs: { selectedExecutionUnits: units } } as never,
      { id: randomUUID(), ownerAgentId, title: "Deliver" } as never);
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Plan workflow", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, status: "running", triggeredBy: "test" });
    // Exercise real terminal convergence of a completed normal branch, not agent execution.
    await db.insert(workflowStepRuns).values(steps.map(step => ({ workflowRunId: runId, stepId: step.id,
      status: step.type === "oversight" ? "pending" : "completed", startedAt: new Date(),
      completedAt: step.type === "oversight" ? null : new Date(),
    })));
    const result = await syncWorkflowRunState(db, runId);
    expect(result.status).toBe("completed");
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.status === "completed")).toBe(true);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
  });
});
