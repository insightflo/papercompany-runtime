import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, workflowRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { assertAgentAssignments } from "./helpers/workflow-control-node-boundary.js";
import { getStepRun, getStepRuns, installMechanicalQaExecutor, mirrorFixture, processOneMechanicalQa, seedMirrorWorkflow } from "./helpers/workflow-mirror-dag-fixture.js";
import {
  completeWorkflowStepIssue,
  failWorkflowStepIssueThroughLifecycle,
  getValidationVerdictEvents,
} from "./helpers/workflow-mirror-dag-lifecycle.js";
import { issueService } from "../services/issues.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mirror DAG conditional paths", () => {
  it("review path: validator completes only through an official scoped verdict, then QA and publish finalize", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    const initial = await getStepRuns(seed.runId);
    const initialById = new Map(initial.map((row) => [row.stepId, row]));
    expect(initialById.get("decision")?.metadata).toMatchObject({
      controlNodeResult: { outcome: "condition_false" },
    });
    const validator = initialById.get("validator")!;
    expect(validator).toMatchObject({ status: "pending" });
    expect(validator.issueId).toBeTruthy();
    expect(initialById.get("mirror")).toMatchObject({ status: "pending" });
    expect(initialById.get("mechanical-qa")).toMatchObject({ status: "pending" });
    expect(initialById.get("publish")?.issueId).toBeNull();
    expect(requests).toHaveLength(0);

    // The official completion API must refuse a verdict-less QA closeout: no bypass, no ledger.
    await expect(completeWorkflowStepIssue(seed, "validator"))
      .rejects.toThrow(/official workflow_validation_verdict ledger event/);
    const refusedIssue = await getStepRun(seed.runId, "validator");
    expect(await getValidationVerdictEvents(refusedIssue.issueId!)).toHaveLength(0);

    const result = await completeWorkflowStepIssue(seed, "validator", { requireVerdictPass: true });
    const verdictEvents = await getValidationVerdictEvents(refusedIssue.issueId!);
    expect(verdictEvents).toHaveLength(1);
    expect(verdictEvents[0]).toMatchObject({
      companyId: seed.companyId,
      workflowRunId: seed.runId,
      verdict: "pass",
      reason: "workflow_api",
    });
    expect(verdictEvents[0]?.heartbeatRunId).toBeTruthy();
    const afterValidator = await getStepRun(seed.runId, "validator");
    expect(afterValidator).toMatchObject({ status: "completed", issueId: validator.issueId });
    expect(afterValidator.dispatchReadyAt).not.toBeNull();
    expect((await getStepRun(seed.runId, "mirror")).metadata).toMatchObject({
      controlNodeResult: { outcome: "condition_false" },
    });
    expect(result?.status).toBe("running");

    const afterQa = await processOneMechanicalQa(seed, requests);
    expect(afterQa.status).toBe("running");
    const publishResult = await completeWorkflowStepIssue(seed, "publish");
    expect(publishResult?.status).toBe("completed");
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("mechanical-qa")?.status).toBe("completed");
    expect(finalById.get("publish")?.status).toBe("completed");
    expect(requests).toHaveLength(1);
    await assertAgentAssignments(mirrorFixture.db, {
      companyId: seed.companyId,
      agentId: seed.agentId,
      runId: seed.runId,
      steps: [
        { stepId: "producer", issueId: finalById.get("producer")!.issueId },
        { stepId: "validator", issueId: finalById.get("validator")!.issueId, mutations: ["create", "workflow_resume"] },
        { stepId: "publish", issueId: finalById.get("publish")!.issueId },
      ],
    });
  });

  it("validator lifecycle failure holds QA and publish without execution until the recovery channel closes", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    const validator = await getStepRun(seed.runId, "validator");
    expect(requests).toHaveLength(0);

    const failedIssue = await failWorkflowStepIssueThroughLifecycle(seed, "validator");
    expect(failedIssue.status).toBe("blocked");
    const heartbeatRows = await mirrorFixture.db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.issueId, validator.issueId!));
    expect(heartbeatRows).toHaveLength(1);
    expect(heartbeatRows[0]).toMatchObject({ companyId: seed.companyId, agentId: seed.agentId, status: "failed" });
    const afterBlock = await getStepRun(seed.runId, "validator");
    expect(afterBlock).toMatchObject({ status: "failed" });
    expect(afterBlock.lastDispatchErrorSummary).toBeNull();
    // Open recovery channel: downstream waits, nothing executes, the run is not finalized.
    expect((await getStepRun(seed.runId, "mirror")).status).toBe("pending");
    expect((await getStepRun(seed.runId, "mechanical-qa")).status).toBe("pending");
    expect((await getStepRun(seed.runId, "publish")).status).toBe("pending");
    expect((await getStepRun(seed.runId, "publish")).issueId).toBeNull();
    const [runningRun] = await mirrorFixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.runId));
    expect(runningRun?.status).toBe("running");
    expect(requests).toHaveLength(0);

    await issueService(mirrorFixture.db).update(validator.issueId!, {
      status: "cancelled",
      workflowSyncSource: "issues_route",
    });
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("validator")?.status).toBe("failed");
    expect(finalById.get("mirror")?.status).toBe("skipped");
    expect(finalById.get("mechanical-qa")?.status).toBe("skipped");
    expect(finalById.get("publish")?.status).toBe("skipped");
    expect(finalById.get("publish")?.issueId).toBeNull();
    const [failedRun] = await mirrorFixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.runId));
    expect(failedRun?.status).toBe("failed");
    expect(requests).toHaveLength(0);
  });

  it("fails closed when registered producer JSON is invalid", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("invalid");
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("decision")?.status).toBe("failed");
    expect(finalById.get("decision")?.lastDispatchErrorSummary).toContain("not valid JSON");
    expect(finalById.get("validator")?.status).toBe("skipped");
    expect(finalById.get("mirror")?.status).toBe("skipped");
    expect(finalById.get("mechanical-qa")?.status).toBe("skipped");
    expect(finalById.get("publish")?.status).toBe("skipped");
    expect(finalById.get("publish")?.issueId).toBeNull();
    expect(seed.result.status).toBe("failed");
    expect(requests).toHaveLength(0);
  });

  it("official run cancellation stops the run without QA execution or publish assignment", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    const validator = await getStepRun(seed.runId, "validator");
    expect(requests).toHaveLength(0);

    const cancelled = await workflowService.cancelRun(mirrorFixture.db, {
      runId: seed.runId,
      companyId: seed.companyId,
    });
    expect(cancelled).toBe(true);
    const [run] = await mirrorFixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.runId));
    expect(run?.status).toBe("cancelled");
    const [validatorIssue] = await mirrorFixture.db.select().from(issues).where(eq(issues.id, validator.issueId!));
    expect(validatorIssue).toMatchObject({ status: "cancelled", companyId: seed.companyId });
    expect(validatorIssue?.cancelledAt).not.toBeNull();
    expect(validatorIssue?.checkoutRunId).toBeNull();
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("validator")?.status).toBe("failed");
    expect(finalById.get("mechanical-qa")).toMatchObject({
      status: "skipped",
      issueId: null,
      lastDispatchRequestId: null,
    });
    expect(finalById.get("publish")?.issueId).toBeNull();
    expect(validator.issueId).toBeTruthy();
    expect(requests).toHaveLength(0);
  });
});
