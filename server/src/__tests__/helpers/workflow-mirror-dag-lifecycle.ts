import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import {
  completeWorkflowIssue,
  submitWorkflowVerdict,
  type WorkflowApiActor,
} from "../../services/workflow/agent-api.js";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { issueService } from "../../services/issues.js";
import { getStepRun, mirrorFixture, type MirrorSeed } from "./workflow-mirror-dag-fixture.js";

async function getIssueRow(issueId: string) {
  const [row] = await mirrorFixture.db.select().from(issues).where(eq(issues.id, issueId));
  expect(row).toBeTruthy();
  return row!;
}

function workflowApiActor(seed: MirrorSeed, runId: string | null): WorkflowApiActor {
  return { actorType: "agent", actorId: seed.agentId, agentId: seed.agentId, runId };
}

export async function getValidationVerdictEvents(issueId: string) {
  return mirrorFixture.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.issueId, issueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
  ));
}

// Official agent closeout: heartbeat-scoped verdict submission (when the step is a QA gate)
// followed by the dedicated workflow issue completion API. No direct step or ledger writes.
export async function completeWorkflowStepIssue(
  seed: MirrorSeed,
  stepId: string,
  options: { requireVerdictPass?: boolean } = {},
) {
  const db = mirrorFixture.db;
  const row = await getStepRun(seed.runId, stepId);
  expect(row.issueId, `step ${stepId} must own an issue`).toBeTruthy();
  const issueId = row.issueId!;
  await issueService(db).update(issueId, { status: "in_progress" });
  let heartbeatRunId: string | null = null;
  if (options.requireVerdictPass === true) {
    heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId,
      status: "running",
      startedAt: new Date(),
    });
    await db.update(issues).set({ checkoutRunId: heartbeatRunId }).where(eq(issues.id, issueId));
    const verdict = await submitWorkflowVerdict({
      db,
      issue: await getIssueRow(issueId),
      actor: workflowApiActor(seed, heartbeatRunId),
      data: { verdict: "pass", reason: "Mechanical validation evidence verified" },
    });
    expect(verdict).toMatchObject({ satisfied: true, verdict: "pass" });
  }
  const completed = await completeWorkflowIssue({
    db,
    issue: await getIssueRow(issueId),
    actor: workflowApiActor(seed, heartbeatRunId),
    data: {},
  });
  expect(completed.status).toBe("done");
  return await syncWorkflowRunForIssue(db, issueId);
}

// Actual lifecycle failure path: the scoped runner heartbeat failed, then the issue moves to
// blocked through the same official issue update write path the heartbeat finalizer uses.
export async function failWorkflowStepIssueThroughLifecycle(seed: MirrorSeed, stepId: string) {
  const db = mirrorFixture.db;
  const row = await getStepRun(seed.runId, stepId);
  expect(row.issueId, `step ${stepId} must own an issue`).toBeTruthy();
  const issueId = row.issueId!;
  const svc = issueService(db);
  await svc.update(issueId, { status: "in_progress" });
  await db.insert(heartbeatRuns).values({
    id: randomUUID(),
    companyId: seed.companyId,
    agentId: seed.agentId,
    issueId,
    status: "failed",
    startedAt: new Date(),
    finishedAt: new Date(),
    error: "simulated validator heartbeat failure",
  });
  await svc.update(issueId, { status: "blocked", workflowSyncSource: "issues_route" });
  return await getIssueRow(issueId);
}
