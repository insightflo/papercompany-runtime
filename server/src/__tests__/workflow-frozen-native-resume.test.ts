import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  createDb,
  issues,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { testWake } from "./helpers/cap-override-fixtures.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen native resume (captured step/assignee governs the validated wake)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-native-resume-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function seedNativeResumeFixture(input: {
    runStatus: string;
    stepStatus: string;
    liveStepsJson: (agents: { liveAgentId: string }) => unknown[];
  }) {
    const seeded = await seedCompanyWithMission(fixture.sql, "NR" + randomUUID().slice(0, 3));
    const [liveAgent] = await db.insert(agents).values({
      id: randomUUID(), companyId: seeded.companyId, name: "Live Agent", role: "writer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId,
      name: "frozen-native-resume",
      stepsJson: [{ id: "src", name: "Source step", agentId: seeded.agentId, dependencies: [] }],
    });
    const run = await createFrozenRun(db, {
      workflowId,
      companyId: seeded.companyId,
      missionId: seeded.missionId,
    });
    await markRunStatus(db, run.id, input.runStatus);
    const [source] = await db.insert(issues).values({
      companyId: seeded.companyId,
      missionId: seeded.missionId,
      identifier: "NR-" + randomUUID().slice(0, 8),
      title: "Source step",
      status: "blocked",
      originKind: "workflow_execution",
      originRunId: run.id,
    }).returning();
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id,
      stepId: "src",
      issueId: source!.id,
      status: input.stepStatus,
      startedAt: new Date(),
      completedAt: input.stepStatus === "failed" ? new Date() : null,
      iterationIndex: 0,
      metadata: {},
    }).returning();
    await editLiveDefinition(db, workflowId, { stepsJson: input.liveStepsJson({ liveAgentId: liveAgent!.id }) });
    return {
      seeded,
      liveAgentId: liveAgent!.id,
      workflowId,
      runId: run.id,
      issueId: source!.id,
      stepRunId: stepRun!.id,
    };
  }

  const dispatch = (f: Awaited<ReturnType<typeof seedNativeResumeFixture>>) => dispatchSourceIssueNativeResume(db, {
    companyId: f.seeded.companyId,
    issueId: f.issueId,
    allowBlockedIssue: true,
    agentId: f.seeded.agentId,
    wakeFn: testWake(db),
  });

  const nativeWakes = (issueId: string, runId: string, stepRunId: string) =>
    db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.issueId, issueId),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
      eq(agentWakeupRequests.workflowRunId, runId),
      eq(agentWakeupRequests.workflowStepRunId, stepRunId),
    ));

  const liveGraphCases = [
    ["live src reassigned", ({ liveAgentId }: { liveAgentId: string }) =>
      [{ id: "src", name: "Live reassigned", agentId: liveAgentId, dependencies: [] }]],
    ["live graph without src (different id)", ({ liveAgentId }: { liveAgentId: string }) =>
      [{ id: "live-only", name: "Live only", agentId: liveAgentId, dependencies: [] }]],
  ] as const;

  it.each(liveGraphCases)("revives a failed run/step and queues exactly one native wake bound to the captured assignee/step/run when the %s", async (_case, liveStepsJson) => {
    const f = await seedNativeResumeFixture({ runStatus: "failed", stepStatus: "failed", liveStepsJson });

    const outcome = await dispatch(f);

    expect(outcome).toEqual({
      kind: "dispatched",
      workflowRunId: f.runId,
      workflowDefinitionId: f.workflowId,
      stepId: "src",
      workflowStepRunId: f.stepRunId,
    });
    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    expect(runRow).toEqual(expect.objectContaining({ status: "running", completedAt: null }));
    const [stepRow] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
    expect(stepRow).toEqual(expect.objectContaining({ status: "running", completedAt: null }));
    const wakes = await nativeWakes(f.issueId, f.runId, f.stepRunId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(f.seeded.agentId);
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issueRow?.status).toBe("blocked");
  });

  it.each(["missing", "corrupt"] as const)("rejects a %s snapshot with 422 before any run/step/issue mutation or wake", async (state) => {
    const f = await seedNativeResumeFixture({
      runStatus: "failed",
      stepStatus: "failed",
      liveStepsJson: ({ liveAgentId }) => [{ id: "src", name: "Live reassigned", agentId: liveAgentId, dependencies: [] }],
    });
    if (state === "missing") {
      await db.delete(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, f.runId));
    } else {
      await corruptSnapshotSteps(fixture.sql, f.runId);
    }
    const before = {
      run: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0],
      step: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId)))[0],
      issue: (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0],
    };

    const error = await captureHttpError(dispatch(f));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0]).toEqual(before.run);
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId)))[0]).toEqual(before.step);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(before.issue);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, f.issueId))).toHaveLength(0);
  });

  it("keeps duplicate native wakes single: the second dispatch is already_in_flight with no new wake", async () => {
    const f = await seedNativeResumeFixture({
      runStatus: "running",
      stepStatus: "pending",
      liveStepsJson: ({ liveAgentId }) => [{ id: "src", name: "Live renamed", agentId: liveAgentId, dependencies: [] }],
    });

    const first = await dispatch(f);
    expect(first).toEqual(expect.objectContaining({ kind: "dispatched", workflowRunId: f.runId }));

    const second = await dispatch(f);

    expect(second).toMatchObject({ kind: "already_in_flight", liveSignal: "wake" });
    expect(await nativeWakes(f.issueId, f.runId, f.stepRunId)).toHaveLength(1);
  });

  it("keeps the baseline report_only path: a source without a step run wakes nothing", async () => {
    const f = await seedNativeResumeFixture({
      runStatus: "running",
      stepStatus: "pending",
      liveStepsJson: () => [{ id: "src", name: "Source step", agentId: "", dependencies: [] }],
    });
    const [unlinked] = await db.insert(issues).values({
      companyId: f.seeded.companyId,
      missionId: f.seeded.missionId,
      identifier: "NR-UNLINKED",
      title: "unlinked source",
      status: "blocked",
      originKind: "workflow_execution",
    }).returning();

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: f.seeded.companyId,
      issueId: unlinked!.id,
      allowBlockedIssue: true,
      agentId: f.seeded.agentId,
      wakeFn: testWake(db),
    });

    expect(outcome).toEqual({
      kind: "report_only",
      reason: "no_step_run",
      workflowRunId: null,
      workflowStepRunId: null,
      stepId: null,
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, unlinked!.id))).toHaveLength(0);
  });
});
