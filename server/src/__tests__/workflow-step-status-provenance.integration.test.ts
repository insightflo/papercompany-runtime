import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";
import { issueService } from "../services/issues.js";
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import { recordWorkflowStepStatusTransition } from "../services/workflow/workflow-sync-source.js";
import type { WorkflowSyncSource } from "../services/workflow/workflow-sync-source.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip workflow step status provenance integration tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step-status provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workflow-step-status-provenance-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workflow Provenance Co", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function seedIssueBackedStep(input: {
    issueStatus?: "todo" | "in_progress" | "done";
    stepStatus?: "pending" | "running";
  } = {}) {
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();
    const stepId = `step-${stepRunId.slice(0, 8)}`;
    const now = new Date();

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: `Provenance ${stepId}`,
      stepsJson: [{ id: stepId, name: "Provenance step", agentId: randomUUID(), dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      companyId,
      workflowId,
      status: "running",
      triggeredBy: "test",
      startedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${stepId}`,
      status: input.issueStatus ?? "done",
      originKind: "workflow_execution",
      originRunId: runId,
      completedAt: now,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId,
      issueId,
      status: input.stepStatus ?? "running",
      startedAt: now,
    });

    return { issueId, runId, stepRunId };
  }

  it("keeps the initiating issue caller when later observers synchronize", async () => {
    const cases: readonly WorkflowSyncSource[] = [
      "issues_route",
      "plugin_host",
      "heartbeat_promotion",
    ];
    const seeded = await Promise.all(cases.map(() => seedIssueBackedStep({ issueStatus: "todo" })));

    for (const [index, source] of cases.entries()) {
      await issueService(db).update(seeded[index]!.issueId, {
        status: "done",
        workflowSyncSource: source,
      });
      await workflowService.syncRunStatusForIssue(db, seeded[index]!.issueId, "workflow_sync");
    }

    const events = await db
      .select({
        stepRunId: workflowTransitionEvents.workflowStepRunId,
        reasonCode: workflowTransitionEvents.reasonCode,
      })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"));

    for (const [index, source] of cases.entries()) {
      expect(events.filter((event) => event.stepRunId === seeded[index]!.stepRunId)).toEqual([
        { stepRunId: seeded[index]!.stepRunId, reasonCode: source },
      ]);
    }
  });

  it("deduplicates concurrent observers and distinguishes later physical flips", async () => {
    const seeded = await seedIssueBackedStep();
    await Promise.all([
      workflowService.syncRunStatusForIssue(db, seeded.issueId, "plugin_host"),
      workflowService.syncRunStatusForIssue(db, seeded.issueId, "heartbeat_promotion"),
    ]);

    await db.update(workflowStepRuns)
      .set({ status: "running", completedAt: null })
      .where(eq(workflowStepRuns.id, seeded.stepRunId));
    await workflowService.syncRunStatusForIssue(db, seeded.issueId, "issues_route");

    const events = await db
      .select({
        idempotencyKey: workflowTransitionEvents.idempotencyKey,
        reasonCode: workflowTransitionEvents.reasonCode,
      })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.workflowStepRunId, seeded.stepRunId),
        eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
      ));

    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(2);
    expect(events.map((event) => event.reasonCode)).toContain("issues_route");
  });

  it("emits nothing for unchanged or non-terminal status observations", async () => {
    const seeded = await seedIssueBackedStep({ issueStatus: "in_progress", stepStatus: "running" });
    await workflowService.syncRunStatusForIssue(db, seeded.issueId, "issues_route");
    await workflowService.syncRunStatusForIssue(db, seeded.issueId, "plugin_host");
    await recordWorkflowStepStatusTransition(db, {
      companyId,
      workflowRunId: seeded.runId,
      workflowStepRunId: seeded.stepRunId,
      fromStatus: "pending",
      toStatus: "running",
      transitionVersion: 1,
    });

    const events = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, seeded.stepRunId));
    expect(events).toHaveLength(0);
  });

  it("keeps heartbeat completion provenance when a later observer synchronizes", async () => {
    const seeded = await seedIssueBackedStep({ issueStatus: "in_progress" });
    const heartbeatRunId = randomUUID();
    const completedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(issues)
        .set({ status: "done", completedAt })
        .where(eq(issues.id, seeded.issueId));
      await completeLinkedWorkflowStepRunsForIssue({
        db: tx,
        issueId: seeded.issueId,
        completedAt,
        source: "heartbeat_promotion",
        heartbeatRunId,
      });
    });

    await workflowService.syncRunStatusForIssue(db, seeded.issueId, "plugin_host");

    const events = await db
      .select({
        reasonCode: workflowTransitionEvents.reasonCode,
        heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.workflowStepRunId, seeded.stepRunId),
        eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
      ));

    expect(events).toEqual([{ reasonCode: "heartbeat_promotion", heartbeatRunId }]);
  });
  it("contains provenance insert failures within a savepoint", async () => {
    const seeded = await seedIssueBackedStep();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION workflow_step_provenance_test_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'workflow_step_status_transition' THEN
          RAISE EXCEPTION 'provenance test failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER workflow_step_provenance_test_failure
      BEFORE INSERT ON workflow_transition_events
      FOR EACH ROW EXECUTE FUNCTION workflow_step_provenance_test_failure();
    `));

    try {
      await db.transaction(async (tx) => {
        await completeLinkedWorkflowStepRunsForIssue({
          db: tx,
          issueId: seeded.issueId,
          completedAt: new Date(),
          source: "issues_route",
        });
      });
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS workflow_step_provenance_test_failure ON workflow_transition_events;
        DROP FUNCTION IF EXISTS workflow_step_provenance_test_failure();
      `));
    }

    const [stepRun] = await db
      .select({ status: workflowStepRuns.status })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seeded.stepRunId));
    expect(stepRun?.status).toBe("completed");
  });
});
