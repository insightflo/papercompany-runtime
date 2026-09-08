import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  issues,
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  captureNativeScopedRecords,
  seedAcceptedResumedRun,
  seedMalformedResumedRun,
  seedNativeEntryGraph,
  seedPendingResumedRun,
  startNativeEntryFixture,
  type NativeEntryFixture,
} from "./helpers/workflow-resume-native-entry-fixture.js";

// External-effect mocks only (agent wakeups + tool dispatch). Acceptance storage,
// engine writes and the sync entry itself run against the real embedded Postgres.
const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import {
  executeWorkflowRun,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { assertResumeExecutionReadiness } from "../services/workflow/resume/readiness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping native entry tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("workflow resume native entry (sync acceptance guard + shared readiness)", () => {
  let fixture: Extract<NativeEntryFixture, { supported: true }>;
  let db: Db;
  let dispatchToolStep: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const started = await startNativeEntryFixture("resume-native-entry-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(() => {
    heartbeatWakeup.mockReset();
    dispatchToolStep = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatchToolStep);
  });
  afterEach(() => setWorkflowToolStepExecutor(null));

  /** refusal: 409 + 외부효과 0 + run 스코프 레코드 무변이를 한 번에 단언한다. */
  const expectResumeRefusal = async (runId: string, reason: string) => {
    const before = await captureNativeScopedRecords(fixture.sql, runId);
    const error = await captureHttpError(syncWorkflowRunState(db, runId, "workflow_sync"));
    expect(error.status).toBe(409);
    expect(error.message).toBe("resume_not_accepted");
    expect((error.details as { reason?: string }).reason).toBe(reason);
    expect(dispatchToolStep).not.toHaveBeenCalled();
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const after = await captureNativeScopedRecords(fixture.sql, runId);
    expect(after).toEqual(before);
    return after;
  };

  it("refuses pending durable request with no execution BEFORE missing step records can be ensured", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEP" });
    await seedPendingResumedRun(db, graph);
    const after = await expectResumeRefusal(graph.runId, "resume_request_state_pending_delivery");
    // definition declares one step, yet zero step-run rows were created by the refused sync.
    expect(after.steps).toHaveLength(0);
    expect(after.linkedIssues).toHaveLength(0);
    expect(after.transitions).toHaveLength(0);
  });

  it("refuses a malformed own resumeRequestId without legacy fallback", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEM" });
    await seedMalformedResumedRun(db, graph);
    const after = await expectResumeRefusal(graph.runId, "malformed_resume_request_id");
    expect(after.steps).toHaveLength(0);
  });

  it("refuses an accepted request without any resume execution", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEA0" });
    await seedAcceptedResumedRun(db, graph, { withExecution: false });
    await expectResumeRefusal(graph.runId, "resume_execution_not_found");
  });

  it("refuses when execution authorityVersion mismatches the run dispatch authority", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEV" });
    await seedAcceptedResumedRun(db, graph, { executionAuthorityVersion: 4 });
    await expectResumeRefusal(graph.runId, "execution_authority_version_mismatch");
  });

  it("still reaches normal sync for an ordinary legacy run without a resume key", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEL" });
    heartbeatWakeup.mockResolvedValue({ id: "legacy-wake" });
    const result = await syncWorkflowRunState(db, graph.runId, "workflow_sync");
    expect(result.status).toBe("running");
    const steps = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, graph.runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.issueId).not.toBeNull();
    const [createdIssue] = await db.select().from(issues).where(eq(issues.id, steps[0]!.issueId!));
    expect(createdIssue).toBeDefined();
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, graph.runId));
    expect(run.dispatchAuthorityVersion).toBe(0);
    // legacy ordinary run: no own resume key → guard no-op, sync untouched.
    expect(Object.prototype.hasOwnProperty.call(run.metadata, "resumeRequestId")).toBe(false);
  });

  it("accepted exact queued resume execution allows real sync and preserves generation ownership", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NEQ" });
    const requestId = await seedAcceptedResumedRun(db, graph, {});
    const before = await captureNativeScopedRecords(fixture.sql, graph.runId);
    heartbeatWakeup.mockResolvedValue({ id: "resume-wake" });

    const result = await syncWorkflowRunState(db, graph.runId, "workflow_sync");

    // actual control result, not just no-throw.
    expect(result.status).toBe("running");
    expect(result.stepRuns).toHaveLength(1);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, graph.runId));
    expect(stepRun!.issueId).not.toBeNull();
    expect(stepRun!.executionGeneration).toBe(3);
    expect((stepRun!.metadata as Record<string, unknown>).resumeRequestId).toBe(requestId);
    const [createdIssue] = await db.select().from(issues).where(eq(issues.id, stepRun!.issueId!));
    expect(createdIssue).toBeDefined();
    // acceptance storage is read-only for the guard: request/execution rows untouched.
    const [request] = await db.select().from(workflowResumeRequests)
      .where(eq(workflowResumeRequests.id, requestId));
    const [execution] = await db.select().from(workflowResumeExecutions)
      .where(eq(workflowResumeExecutions.requestId, requestId));
    expect(request!.state).toBe("accepted");
    expect(execution!.state).toBe("queued");
    // sync must not mutate run authority or resume ownership metadata.
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, graph.runId));
    expect(run.dispatchAuthorityVersion).toBe(3);
    expect(run.metadata).toEqual({ resumeRequestId: requestId, resumeAuthorityVersion: 3 });
    const acceptanceRows = await captureNativeScopedRecords(fixture.sql, graph.runId);
    expect(acceptanceRows.run).toEqual(before.run);
  });

  it("shared readiness rejects the same structural invalid contract and still calls the tool check", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NER" });
    const steps = [
      { id: "produce-a", name: "A", agentId: graph.agentId, dependencies: [] },
      { id: "produce-b", name: "B", agentId: graph.agentId, dependencies: [] },
      {
        id: "gate", name: "Gate", type: "tool", agentId: "", qaType: "structural",
        toolNames: ["no-such-tool"], dependencies: ["produce-a", "produce-b"],
      },
    ];
    const toolCheck = vi.fn().mockResolvedValue(undefined);
    const error = await captureHttpError(assertResumeExecutionReadiness({
      db,
      companyId: graph.companyId,
      steps,
      assertToolsReady: toolCheck,
    }));
    expect(toolCheck).toHaveBeenCalledTimes(1);
    expect(toolCheck).toHaveBeenCalledWith({ companyId: graph.companyId, steps });
    expect(error.message).toContain("Structural gate validation failed");
    expect(error.message).toContain("exactly one non-gate producer dependency");
  });

  it("readiness alone never resets startedAt; executeWorkflowRun keeps original start behavior", async () => {
    const graph = await seedNativeEntryGraph(fixture.sql, db, { prefix: "NES" });
    heartbeatWakeup.mockResolvedValue({ id: "start-wake" });
    await assertResumeExecutionReadiness({
      db,
      companyId: graph.companyId,
      steps: [{ id: graph.stepId, name: "Resume step", agentId: graph.agentId, dependencies: [] }],
      assertToolsReady: async () => {},
    });
    const [unchanged] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, graph.runId));
    expect(unchanged.startedAt?.toISOString()).toBe("2026-09-08T01:00:00.000Z");
    expect(unchanged.status).toBe("running");

    await executeWorkflowRun(db, graph.runId);
    const [started] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, graph.runId));
    expect(started.status).toBe("running");
    expect(started.startedAt).not.toBeNull();
    expect(started.startedAt!.getTime()).toBeGreaterThan(new Date("2026-09-08T01:00:00.000Z").getTime());
  });
});
