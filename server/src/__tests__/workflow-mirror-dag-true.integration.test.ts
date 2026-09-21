import { beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { assertAgentAssignments } from "./helpers/workflow-control-node-boundary.js";
import { getStepRuns, installMechanicalQaExecutor, mirrorFixture, processOneMechanicalQa, seedMirrorWorkflow } from "./helpers/workflow-mirror-dag-fixture.js";
import { completeWorkflowStepIssue } from "./helpers/workflow-mirror-dag-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mirror DAG condition_true", () => {
  beforeAll(() => { mirrorFixture.db; });

  it("skips validator and mirror with admitted readiness, runs QA once, then publishes and completes", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const before = await getStepRuns(seed.runId);
    const byId = new Map(before.map((row) => [row.stepId, row]));
    expect(byId.get("decision")?.metadata).toMatchObject({
      controlNodeResult: { nodeType: "if", outcome: "condition_true" },
    });
    expect(byId.get("decision")?.dispatchReadyAt).not.toBeNull();
    expect(byId.get("validator")).toMatchObject({ status: "skipped", issueId: null });
    expect(before.map(({ stepId, status, issueId, dispatchReadyAt }) => ({
      stepId, status, hasIssue: issueId !== null, dispatchReady: dispatchReadyAt !== null,
    })), "persisted fast-path activation evidence: skipped predecessors must be dispatch-admitted").toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "validator", status: "skipped", hasIssue: false, dispatchReady: true }),
      expect.objectContaining({ stepId: "mirror", status: "skipped", hasIssue: false, dispatchReady: true }),
      expect.objectContaining({ stepId: "mechanical-qa", status: "running", hasIssue: false }),
    ]));
    expect(byId.get("mechanical-qa")).toMatchObject({ status: "running", issueId: null });
    expect(byId.get("publish")).toMatchObject({ status: "pending" });
    expect(byId.get("publish")?.issueId).toBeNull();

    const afterQa = await processOneMechanicalQa(seed, requests);
    expect(afterQa.status).toBe("running");
    const completed = await getStepRuns(seed.runId);
    const completedById = new Map(completed.map((row) => [row.stepId, row]));
    expect(completedById.get("mechanical-qa")).toMatchObject({ status: "completed" });
    expect(completedById.get("mechanical-qa")?.dispatchReadyAt).not.toBeNull();
    expect(completedById.get("publish")?.status).toBe("pending");
    expect(completedById.get("publish")?.issueId).toBeTruthy();

    const publishResult = await completeWorkflowStepIssue(seed, "publish");
    expect(publishResult?.status).toBe("completed");
    const finalRuns = await getStepRuns(seed.runId);
    const finalById = new Map(finalRuns.map((row) => [row.stepId, row]));
    expect(finalById.get("mechanical-qa")?.status).toBe("completed");
    expect(finalById.get("publish")?.status).toBe("completed");
    expect(finalById.get("validator")?.status).toBe("skipped");
    expect(finalById.get("mirror")?.status).toBe("skipped");
    await assertAgentAssignments(mirrorFixture.db, {
      companyId: seed.companyId,
      agentId: seed.agentId,
      runId: seed.runId,
      steps: [
        { stepId: "producer", issueId: finalById.get("producer")!.issueId },
        { stepId: "publish", issueId: finalById.get("publish")!.issueId },
      ],
    });
  });
});
