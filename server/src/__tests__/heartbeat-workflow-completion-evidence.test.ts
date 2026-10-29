import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  heartbeatRuns,
  issueExecutionCards,
  issueWorkProducts,
  issues,
  workflowStepRuns,
  type IssueExecutionCardJson,
} from "@paperclipai/db";
import { beforeEach, expect, it } from "vitest";
import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { issueService } from "../services/issues.js";
import { completeWorkflowIssue } from "../services/workflow/agent-api.js";
import {
  hasWorkflowValidationCompletionLedger,
  recordWorkflowValidationVerdict,
} from "../services/workflow/validation-verdict-ledger.js";

const succeeded = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  usage: null,
  provider: "test",
  model: "test",
  resultJson: { text: "done" },
  runtimeServices: [],
};

beforeEach(async () => {
  await flag(false);
  adapter.mockReset();
});

async function workflowIssue(verdictRequired = false) {
  const f = await fixture({
    captureDefinition: true,
    stepsJson: [{ id: "write", name: "Write", type: "agent", agentId: undefined, dependencies: [], graphWorkProductRequired: false }],
  });
  const db = database();
  await db.update(workflowStepRuns).set({ metadata: { graphWorkProductRequired: false } })
    .where(eq(workflowStepRuns.id, f.stepRunId));
  const cardJson: IssueExecutionCardJson = {
    version: 1,
    issue: { title: "Write", assigneeAgentId: f.agentId, originKind: "workflow_execution" },
    workflow: { runId: f.workflowRunId, stepRunId: f.stepRunId, stepId: "write", dependencyStepIds: [] },
    requiredOutputs: {
      workProduct: { required: false, artifactMarker: "[ARTIFACT]: <absolute path>" },
      verdict: {
        required: verdictRequired,
        ledger: verdictRequired ? "workflow_validation_verdict" : null,
        allowed: verdictRequired ? (["PASS", "REQUEST_CHANGES"] as const) : ([] as const),
      },
      deliveryReadback: { required: false },
    },
    evidenceRefs: [],
    preservedProseMarkers: [],
    source: { descriptionHash: "test", generatedBy: "focused-test" },
  };
  await db.insert(issueExecutionCards).values({
    companyId: f.companyId,
    issueId: f.issueId,
    workflowRunId: f.workflowRunId,
    workflowStepRunId: f.stepRunId,
    cardVersion: 1,
    contentHash: "test",
    cardJson,
  });
  return f;
}

async function finishRun(f: Awaited<ReturnType<typeof workflowIssue>>, beforeFirstSuccess?: (runId: string) => Promise<void>) {
  const runIds: string[] = [];
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => {
    const callNumber = runIds.push(runId);
    const run = await f.readRun(runId);
    await issueService(database()).checkout(run.issueId!, f.agentId, ["todo", "in_progress"], runId);
    if (callNumber === 1) await beforeFirstSuccess?.(runId);
    return callNumber === 1 ? succeeded : stopped;
  });
  await f.wake({ workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId });
  await drain();
  return runIds;
}

async function assertNotAutomaticallyCompleted(f: Awaited<ReturnType<typeof workflowIssue>>) {
  const db = database();
  const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
  const step = await f.readStep();
  expect(issue!.status).not.toBe("done");
  expect(issue!.completedAt).toBeNull();
  expect(step.status).not.toBe("completed");
  expect(issue!.checkoutRunId).toBeNull();
  expect(issue!.executionRunId).toBeNull();
  expect(issue!.executionLockedAt).toBeNull();
  const actions = await db.select({ action: activityLog.action }).from(activityLog)
    .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId)));
  expect(actions.some(row => row.action === "issue.run_succeeded_auto_completed")).toBe(false);
}

it("does not close a false-output, zero-product issue on successful text or exit and releases the run lock", async () => {
  const f = await workflowIssue();
  const runs = await finishRun(f);
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.length).toBeLessThanOrEqual(2);
  await assertNotAutomaticallyCompleted(f);
  expect(await database().select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toHaveLength(0);
  const missing = await database().select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId),
    eq(activityLog.action, "issue.completion_evidence_missing"),
  ));
  expect(missing.length).toBeGreaterThan(0);
});

it("allows an official current-attempt artifact to complete the workflow issue", async () => {
  const f = await workflowIssue();
  const [runId] = await finishRun(f, async currentRunId => { await f.register(currentRunId); });
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  expect((await f.readRun(runId!)).status).toBe("succeeded");
  expect(issue!.status).toBe("done");
  expect((await f.readStep()).status).toBe("completed");
});

it("preserves a foreign owner when an older successful run has eligible evidence", async () => {
  const f = await workflowIssue();
  let ownerRunId: string | null = null;
  const [runId] = await finishRun(f, async currentRunId => {
    await f.register(currentRunId);
    const [owner] = await database().insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "running",
    }).returning({ id: heartbeatRuns.id });
    ownerRunId = owner!.id;
    await database().update(issues).set({
      checkoutRunId: owner!.id,
      executionRunId: owner!.id,
      executionAgentNameKey: "foreign-owner",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, f.issueId));
  });
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  const products = await database().select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId));
  expect(runId).not.toBe(ownerRunId);
  expect((await f.readRun(runId!)).status).toBe("succeeded");
  expect(products).toHaveLength(1);
  expect(products[0]).toMatchObject({ createdByRunId: runId, status: "active" });
  expect(issue!).toMatchObject({
    status: "in_progress",
    completedAt: null,
    checkoutRunId: ownerRunId,
    executionRunId: ownerRunId,
    executionAgentNameKey: "foreign-owner",
  });
  expect(issue!.executionLockedAt).not.toBeNull();
  expect((await f.readStep()).status).toBe("running");
  const autoCompletions = await database().select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId),
    eq(activityLog.action, "issue.run_succeeded_auto_completed"),
  ));
  expect(autoCompletions).toHaveLength(0);
});

it("allows a current official QA verdict with no QA-owned artifact", async () => {
  const f = await workflowIssue(true);
  await finishRun(f, async runId => {
    const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
    await recordWorkflowValidationVerdict({
      db: database(), issue: issue!, verdict: "pass", source: "workflow_api", actorAgentId: f.agentId, heartbeatRunId: runId,
    });
  });
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.status).toBe("done");
  expect((await f.readStep()).status).toBe("completed");
  expect(await database().select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toHaveLength(0);
});

it("blocks a QA issue when its required official verdict is missing", async () => {
  const f = await workflowIssue(true);
  await finishRun(f);
  await assertNotAutomaticallyCompleted(f);
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.status).toBe("blocked");
});

it("does not treat satisfied=true from a noncandidate QA ledger as completion evidence", async () => {
  const f = await workflowIssue();
  await finishRun(f, async runId => {
    const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
    await recordWorkflowValidationVerdict({
      db: database(), issue: issue!, verdict: "pass", source: "workflow_api", actorAgentId: f.agentId, heartbeatRunId: runId,
    });
  });
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  const ledger = await hasWorkflowValidationCompletionLedger({ db: database(), issue: issue! });
  expect(ledger).toMatchObject({ isCandidate: false, satisfied: true, verdict: null });
  await assertNotAutomaticallyCompleted(f);
});

it.each(["stale-generation", "other-company", "archived"] as const)("rejects %s artifacts", async kind => {
  const f = await workflowIssue();
  await finishRun(f, async runId => {
    if (kind === "stale-generation") {
      await f.register(runId);
      await database().update(workflowStepRuns).set({ executionGeneration: 8 })
        .where(eq(workflowStepRuns.id, f.stepRunId));
    } else if (kind === "archived") {
      const product = await f.register(runId);
      await database().update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, product!.id));
    } else {
      const otherCompanyId = randomUUID();
      await database().insert(companies).values({ id: otherCompanyId, name: "Foreign", issuePrefix: `F${otherCompanyId.slice(0, 7)}` });
      await database().insert(issueWorkProducts).values({
        companyId: otherCompanyId,
        issueId: f.issueId,
        type: "document",
        provider: "local_file",
        title: "foreign.json",
        status: "active",
        createdByRunId: runId,
        sourceExecutionGeneration: 7,
        metadata: { path: f.file },
      });
    }
  });
  await assertNotAutomaticallyCompleted(f);
});

it("preserves explicit nonartifact workflow/complete", async () => {
  const f = await workflowIssue();
  await finishRun(f, async runId => {
    const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
    await completeWorkflowIssue({
      db: database(),
      issue: issue!,
      actor: { actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId },
      data: {},
    });
  });
  const [issue] = await database().select().from(issues).where(eq(issues.id, f.issueId));
  expect(issue!.status).toBe("done");
  expect((await f.readStep()).status).toBe("completed");
  expect(await database().select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toHaveLength(0);
});
