import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { companies, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { reconcileStuckWorkflowRuns } from "../../services/workflow/reconciler.js";

export function registerStuckWorkflowCase(getDb: () => ReturnType<typeof createDb>) {
  it("reconciles stuck running workflow runs using a Date cutoff", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stuck Workflow Company",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "stuck-workflow",
      stepsJson: [{ id: "step-1", name: "Step 1", agentId: "", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toHaveLength(1);
    expect(result[0]?.action).toBe("recovered");
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(stored?.status).toBe("failed");
    expect(stored?.completedAt).toBeInstanceOf(Date);
  });

}
