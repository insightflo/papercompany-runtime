import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { artifactDagFixture } from "./artifact-dag-fixture.js";
import { captureExecutionDefinition } from "../../services/workflow/execution-definition.js";
import { classifyQaRebindCandidate, persistQaRebindCandidate } from "../../services/workflow/qa-rebind-candidate.js";

export async function qaRebindFixture() {
  const f = await artifactDagFixture(true), { db } = f;
  await db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 } })
    .where(eq(workflowRuns.id, f.runId));
  await db.transaction(tx => captureExecutionDefinition(tx, f.runId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const qaResult = await f.invoke(); expect(qaResult.status).toBe(200);
  await f.complete("qa", qaResult);
  const receipt = qaResult.toolArtifactReceipt!;
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  const parameters = await f.resolve("publisher");
  await db.update(workflowStepRuns).set({ status: "failed", metadata: {
    ...(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId)))[0].metadata,
    toolInvocation: { requestId: "publisher", args: parameters, dispatchError: "workproduct_selector_stale_producer" },
  } }).where(eq(workflowStepRuns.id, f.publishId));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.runId));
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, f.missionId));
  const scope = { companyId: f.companyId, workflowRunId: f.runId, consumerStepRunId: f.publishId };
  const classify = () => classifyQaRebindCandidate(db, scope);
  const persist = () => persistQaRebindCandidate(db, scope);
  const patchQa = (metadata: Record<string, unknown>) => db.update(workflowStepRuns).set({ metadata })
    .where(eq(workflowStepRuns.id, f.qaId));
  return { ...f, receipt, qa, parameters, scope, classify, persist, patchQa };
}
