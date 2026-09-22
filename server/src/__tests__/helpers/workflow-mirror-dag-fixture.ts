import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterEach, expect } from "vitest";
import {
  agents,
  companies,
  heartbeatRunEvents,
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  heartbeatRuns,
  issues,
  issueWorkProducts,
  toolDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  syncWorkflowRunForIssue,
  type WorkflowToolStepExecutionRequest,
} from "../../services/workflow/dag-engine.js";
import { issueService } from "../../services/issues.js";
import { workflowService } from "../../services/workflow/engine.js";
import { registerWorkflowArtifact } from "../../services/workflow/agent-api.js";
import { useControlNodeFixture } from "./workflow-control-node-fixture.js";

export const mirrorFixture = useControlNodeFixture();

afterEach(async () => {
  setWorkflowToolStepExecutor(null);
  await mirrorFixture.db.delete(toolDefinitions);
});

// Registered after the shared fixture hook on purpose: vitest runs afterEach hooks in
// reverse order, so this clears the heartbeat fixture rows used by official verdict
// submissions before the control-node boundary asserts no heartbeat writers remain.
afterEach(async () => {
  const db = mirrorFixture.db;
  await db.delete(heartbeatRunFinalizationSteps);
  await db.delete(heartbeatRunFinalizations);
  await db.delete(heartbeatRunEvents);
  await db.delete(heartbeatRuns);
});

export type MirrorOutcome = "true" | "false" | "invalid";
export type MirrorSeed = Awaited<ReturnType<typeof seedMirrorWorkflow>>;

export async function seedMirrorWorkflow(decision: MirrorOutcome) {
  const db = mirrorFixture.db;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Mirror DAG Company",
    issuePrefix: `MD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Operator",
    role: "researcher",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(toolDefinitions).values({
    companyId, name: "mirror-mechanical-qa", description: "Test-only QA boundary",
    adapterType: "http", adapterConfig: { url: "https://example.invalid/qa", method: "POST" },
    enabled: true,
  });
  const definition = await workflowService.createDefinition(db, {
    companyId,
    name: `Mirror conditional ${decision}`,
    steps: [
      { id: "producer", name: "Producer", agentId, dependencies: [], graphWorkProductRequired: true },
      {
        id: "decision",
        name: "Source decision",
        type: "if",
        dependencies: ["producer"],
        conditionGroup: {
          combinator: "all",
          conditions: [{
            source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          }],
        },
      },
      {
        id: "validator",
        name: "Validator",
        agentId,
        dependencies: [],
        conditionalDependencies: [{ stepId: "decision", when: "condition_false" }],
      },
      {
        id: "mirror",
        name: "Mirror decision",
        type: "if",
        dependencies: ["validator"],
        conditionGroup: {
          combinator: "all",
          conditions: [{
            source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          }],
        },
      },
      {
        id: "mechanical-qa",
        name: "Mechanical QA",
        type: "tool",
        toolNames: ["mirror-mechanical-qa"],
        dependencies: [],
        onFailure: "retry",
        maxRetries: 1,
        graphRetryDelaySeconds: 0,
        conditionalDependencies: [
          { stepId: "decision", when: "condition_true" },
          { stepId: "mirror", when: "condition_false" },
          { stepId: "mirror", when: "condition_true" },
        ],
      },
      { id: "publish", name: "Publish", agentId, dependencies: ["mechanical-qa"] },
    ] as never,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    workflowId: definition.id,
    companyId,
    triggeredBy: "board",
    status: "pending",
    runDate: "2026-07-20",
  });
  await executeWorkflowRun(db, runId);
  const producer = await getStepRun(runId, "producer");
  await issueService(db).update(producer.issueId!, { status: "in_progress" });
  await syncWorkflowRunForIssue(db, producer.issueId!);
  const artifactPath = await registerDecision(companyId, producer.issueId!, decision);
  await issueService(db).update(producer.issueId!, { status: "done" });
  await syncWorkflowRunForIssue(db, producer.issueId!);
  const result = await executeWorkflowRun(db, runId);
  return { companyId, agentId, runId, result, artifactPath };
}

export async function getStepRun(runId: string, stepId: string) {
  const [row] = await mirrorFixture.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId),
    eq(workflowStepRuns.stepId, stepId),
  ));
  expect(row).toBeTruthy();
  return row!;
}

export async function getStepRuns(runId: string) {
  return await mirrorFixture.db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
}

export function installMechanicalQaExecutor() {
  const requests: WorkflowToolStepExecutionRequest[] = [];
  setWorkflowToolStepExecutor(async (request) => {
    requests.push(request);
    return { accepted: true };
  });
  return requests;
}

export async function processOneMechanicalQa(
  seed: MirrorSeed,
  requests: WorkflowToolStepExecutionRequest[],
  input: { success?: boolean; error?: string } = {},
) {
  const dispatch = await processQueuedWorkflowToolStepRuns(mirrorFixture.db);
  const afterQa = await getStepRun(seed.runId, "mechanical-qa");
  expect(dispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0, skippedCount: 0 });
  expect(requests.length, "executor must receive a request for this queue tick").toBeGreaterThan(0);
  const request = requests[requests.length - 1]!;
  expect(request).toMatchObject({
    companyId: seed.companyId,
    workflowRunId: seed.runId,
    stepRunId: afterQa.id,
    stepId: "mechanical-qa",
    toolName: "mirror-mechanical-qa",
  });
  // The completion callback must answer the exact live dispatch request identity.
  expect(request.requestId).toBe(afterQa.lastDispatchRequestId);
  expect(afterQa.metadata).toMatchObject({ toolInvocation: { toolName: "mirror-mechanical-qa" } });
  const success = input.success ?? true;
  const result = await completeWorkflowToolStepFromResult(mirrorFixture.db, {
    companyId: seed.companyId,
    stepRunId: afterQa.id,
    requestId: request.requestId,
    success,
    ...(success ? { data: { ok: true } } : { error: input.error ?? "simulated qa failure" }),
  });
  expect(result, "tool completion callback must be accepted for the live dispatch request").not.toBeNull();
  return result!;
}

let registeredDecisionSequence = 0;
async function registerDecision(companyId: string, issueId: string, decision: MirrorOutcome) {
  registeredDecisionSequence += 1;
  const externalId = `${mirrorFixture.artifactRoot}/jev-mirror-${registeredDecisionSequence}.json`;
  const content = decision === "invalid"
    ? "{not-json"
    : JSON.stringify({ status: decision === "true" ? "selected" : "empty" });
  await writeFile(externalId, content, "utf8");
  await mirrorFixture.db.insert(issueWorkProducts).values({
    companyId,
    issueId,
    type: "file",
    provider: "local",
    externalId,
    title: "decision.json",
    status: "active",
    isPrimary: true,
    metadata: { path: externalId },
  });
  return externalId;
}

export async function updateDecision(seed: MirrorSeed, status: "selected" | "empty") {
  registeredDecisionSequence += 1;
  const revisionDirectory = `${mirrorFixture.artifactRoot}/jev-mirror-${registeredDecisionSequence}`;
  const nextPath = `${revisionDirectory}/decision.json`;
  await mkdir(revisionDirectory, { recursive: true });
  await writeFile(nextPath, JSON.stringify({ status }), "utf8");
  const producer = await getStepRun(seed.runId, "producer");
  const [producerIssue] = await mirrorFixture.db.select().from(issues)
    .where(eq(issues.id, producer.issueId!));
  expect(producerIssue).toBeTruthy();
  // Replace the fixture direct updatedAt mutation with the official workflow artifact
  // registration path consumed by stale-IF resume authority.
  const registered = await registerWorkflowArtifact({
    db: mirrorFixture.db,
    issue: producerIssue!,
    actor: { actorType: "user", actorId: `mirror-fixture:${seed.runId}`, agentId: null, runId: null },
    data: { path: nextPath, type: "document", title: "decision.json", isPrimary: true },
  });
  expect(registered.title).toBe("decision.json");
  const [storedArtifact] = await mirrorFixture.db.select().from(issueWorkProducts)
    .where(eq(issueWorkProducts.id, registered.id));
  expect(storedArtifact).toMatchObject({
    externalId: nextPath,
    title: "decision.json",
    status: "active",
  });
}
