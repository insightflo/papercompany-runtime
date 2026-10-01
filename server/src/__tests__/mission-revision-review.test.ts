import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, issues, workflowDefinitions, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { buildMissionRevisionContext } from "../services/missions/mission-revision-context.js";
import { checkMissionRevisionSteps } from "../services/missions/mission-revision-guard.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-review-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-review-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it("allows removing a failed approach and adding a corrective unit without source mapping", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await db.update(heartbeatRuns).set({ status: "failed", errorCode: "timeout" }).where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  const steps = [{ ...f.steps[0], id: "corrective", timeoutSeconds: 120 }];
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps, units: [{ id: "corrective" }] })).resolves.toBeUndefined();
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, f.definition.id));
  expect((await createAdmittedWorkflowRun(db, { ...f.input, seedFromRun: undefined }, board)).id).toBeTruthy();
});

it("ignores stale same-generation retry failures, including missing codes, in guard and dossier", async () => {
  const f = await seedWorld(db, root);
  await db.update(heartbeatRuns).set({ status: "failed", errorCode: null }).where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  await db.update(workflowStepRuns).set({ status: "running", retryCount: 1, iterationIndex: 2 }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.sourceStep.issueId,
    stepRunId: f.sourceStep.id, heartbeatId, status: "failed" });
  await db.update(heartbeatRuns).set({ errorCode: "current_timeout" }).where(eq(heartbeatRuns.id, heartbeatId));
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  const context = await buildMissionRevisionContext(db, { companyId: f.companyId, missionId: f.revision.id });
  expect(context?.steps[0].attempts).toEqual([expect.objectContaining({ heartbeatRunId: heartbeatId, errorCode: "current_timeout" })]);
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: [{ ...f.steps[0], sourceStepId: "write", timeoutSeconds: 120 }] })).resolves.toBeUndefined();
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: f.steps })).rejects.toMatchObject({ details: expect.objectContaining({ errorCode: "current_timeout" }) });
});

it("does not turn successful QA heartbeat with official request_changes into missing execution evidence", async () => {
  const f = await seedWorld(db, root);
  const [issue] = await db.update(issues).set({ originKind: "workflow_execution" }).where(eq(issues.id, f.sourceStep.issueId!)).returning();
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  await recordWorkflowValidationVerdict({ db, issue, verdict: "request_changes", source: "workflow_api", heartbeatRunId: heartbeat.id });
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: f.steps })).resolves.toBeUndefined();
});

it("does not permit comments or an unproven heartbeat to impersonate QA rejection", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: f.steps })).rejects.toThrow("mission_revision_failure_evidence_missing");
});

it("recognizes issue-less current-request tool failure rather than requiring a heartbeat", async () => {
  const f = await seedWorld(db, root, () => [{ id: "gate", name: "Gate", type: "tool", qaType: "structural",
    agentId: "", dependencies: [], toolNames: ["validate"] }]);
  await db.update(workflowStepRuns).set({ status: "failed", issueId: null, lastDispatchRequestId: "request-1",
    metadata: { toolResult: { requestId: "request-1", success: false, exitCode: 1 } } }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: [{ id: "new-gate", name: "Gate", type: "tool", qaType: "structural", agentId: "", dependencies: [], toolNames: ["validate"], toolArgs: { fixed: true } }] })).resolves.toBeUndefined();
  await db.update(workflowStepRuns).set({ metadata: { toolResult: { requestId: "stale", success: false } } }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: [] }))
    .rejects.toThrow("mission_revision_failure_evidence_missing");
});

it("recognizes issue-less current-request tool dispatch failure rather than requiring a heartbeat", async () => {
  const f = await seedWorld(db, root, () => [{ id: "gate", name: "Gate", type: "tool", qaType: "structural",
    agentId: "", dependencies: [], toolNames: ["validate"] }]);
  await db.update(workflowStepRuns).set({ status: "failed", issueId: null, lastDispatchRequestId: "request-1",
    metadata: { toolInvocation: { requestId: "request-1", dispatchError: "workproduct_selector_stale_producer" } } })
    .where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id,
    steps: [{ id: "new-gate", name: "Gate", type: "tool", qaType: "structural", agentId: "", dependencies: [], toolNames: ["validate"], toolArgs: { fixed: true } }] })).resolves.toBeUndefined();
  for (const toolInvocation of [
    { requestId: "stale", dispatchError: "workproduct_selector_stale_producer" },
    { requestId: "request-1" },
    { requestId: "request-1", dispatchError: "" },
  ]) {
    await db.update(workflowStepRuns).set({ metadata: { toolInvocation } }).where(eq(workflowStepRuns.id, f.sourceStep.id));
    await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: [] }))
      .rejects.toThrow("mission_revision_failure_evidence_missing");
  }
});

it("uses atomic structural request_changes ledger without any heartbeat", async () => {
  const f = await seedWorld(db, root, () => [{ id: "gate", name: "Gate", type: "tool", qaType: "structural",
    agentId: "", dependencies: [], toolNames: ["validate"] }]);
  await db.update(workflowStepRuns).set({ status: "running", issueId: null, completedAt: null, lastDispatchRequestId: "gate-request" })
    .where(eq(workflowStepRuns.id, f.sourceStep.id));
  const gate = { id: "gate", name: "Gate", type: "tool", qaType: "structural", agentId: "", dependencies: [], toolNames: ["validate"] };
  await atomicStructuralCompletion({ db, step: gate, success: true, data: { verdict: "request_changes" },
    companyId: f.companyId, workflowRunId: f.sourceRun.id, workflowStepRunId: f.sourceStep.id, missionId: f.sourceMission.id,
    requestId: "gate-request", observedStatus: "running", observedIterationIndex: 0, observedRequestId: "gate-request",
    observedCompletedAt: null, observedExecutionGeneration: 1,
    producerToken: { producerStepId: "producer", iterationIndex: 0, completedAt: new Date().toISOString() },
    patch: { startedAt: new Date(), completedAt: new Date(), metadata: {}, fallbackFailureSummary: null } });
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: [gate] })).resolves.toBeUndefined();
});

it("rejects unlinked equivalent dependent steps even when every generated id and title changes", async () => {
  const f = await seedWorld(db, root);
  const [issue] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.sourceMission.id, title: "Use" }).returning();
  const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: f.sourceRun.id, stepId: "use", issueId: issue.id, status: "running" }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: issue.id, stepRunId: step.id, heartbeatId, status: "failed" });
  await db.update(heartbeatRuns).set({ errorCode: "timeout" }).where(eq(heartbeatRuns.id, heartbeatId));
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, step.id));
  const steps = [{ ...f.steps[0], id: "new-write", name: "New producer" }, { ...f.steps[1], id: "new-use", name: "New consumer", graphWorkProductRequired: false,
    dependencies: ["new-write"], workProductSelectors: { "new-write": { type: "document", title: "content.json" } },
    toolArgs: { content: "{$steps.new-write.workProductPath}" } }];
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps }))
    .rejects.toThrow("mission_revision_repeat_failure");
});

it.each(["final QA", "machine check"])("compares generated %s execution without needing a sourceStepId", async kind => {
  const draft = { missionGoal: "report", successCriteria: [], steps: [{ unitId: "u", dependencies: [] }],
    refs: { selectedExecutionUnits: [{ id: "u", title: "Write", graphWorkProductRequired: true,
      ...(kind === "machine check" ? { machineChecks: [{ kind: "file_exists", path: "content.json" }] } : {}) }] } };
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(draft as never, mission));
  const source = buildPaqoWorkflowSteps(draft as never, f.sourceMission);
  const [issue] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.sourceMission.id, title: "QA" }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: f.sourceRun.id, stepId: source[kind === "machine check" ? 1 : source.length - 1].id, issueId: issue.id, status: "running" }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: issue.id, stepRunId: qa.id, heartbeatId, status: "failed" });
  await db.update(heartbeatRuns).set({ errorCode: "timeout" }).where(eq(heartbeatRuns.id, heartbeatId));
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, qa.id));
  const steps = buildPaqoWorkflowSteps(draft as never, f.revision);
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps }))
    .rejects.toThrow("mission_revision_repeat_failure");
  steps[kind === "machine check" ? 1 : steps.length - 1].timeoutSeconds = 120;
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps })).resolves.toBeUndefined();
});
