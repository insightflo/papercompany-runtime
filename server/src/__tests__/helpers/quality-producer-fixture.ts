import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { seedQualityFixture } from "./quality-fixture.js";
import { ensureCanonicalQualityExecution } from "../../services/quality/native-records.js";
import { buildQualityWakeAcceptancePatch } from "../../services/quality/heartbeat-admission.js";
import { scheduleWorkflowStepRetry } from "../../services/workflow/step-retry-scheduler.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "../../services/workflow/retry-launch-dispatch.js";
import { workProductService } from "../../services/work-products.js";
import { selectOfficialWorkProduct } from "../../services/workflow/workproduct-selector.js";
import { admittedProducer } from "./admitted-producer.js";

export async function qualityProducerFixture(db: Db, dir: string) {
  const seed = await seedQualityFixture(db);
  const binding = await ensureCanonicalQualityExecution(db, { companyId: seed.companyId, actionId: seed.actionId });
  const { companyId, authorAgentId: agentId } = seed;
  const { workflowRunId, stepRunId, issueId } = binding;
  // Generation is deliberately not the retry number: other resets also advance it.
  await db.update(workflowStepRuns).set({ executionGeneration: 7 }).where(eq(workflowStepRuns.id, stepRunId));
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, workflowRunId));
  const readStep = async () => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!;
  const schedule = async () => {
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowStepRuns.id, stepRunId));
    const row = await readStep();
    return scheduleWorkflowStepRetry(db, { companyId, workflowRunId, stepRunId,
      retryNumber: row.retryCount + 1, maxRetries: 3, delaySeconds: 0,
      observedStatus: row.status, observedRetryCount: row.retryCount, observedCompletedAt: row.completedAt,
      observedLastDispatchRequestId: row.lastDispatchRequestId,
      observedMetadataSnapshot: row.metadata!, observedExecutionGeneration: row.executionGeneration, errorSummary: "test failure" });
  };
  const admit = async () => {
    const step = await readStep(), heartbeatId = randomUUID(), wakeId = randomUUID();
    await wakeIssueBackedRetryAndMarkDispatching({ db, companyId, workflowRunId,
      definition: {}, run: {}, step: {}, stepRunId, stepRunMetadata: step.metadata, issueId,
      observedRetryCount: step.retryCount, resumeExistingIssue: false,
      // Consumer fixture uses the real admission/claim boundaries, not a provider or scheduler loop.
      wakeExistingWorkflowStepIssue: async input => {
        const now = new Date();
        const patch = await buildQualityWakeAcceptancePatch(db, { companyId, agentId, issueId,
          workflowRunId, idempotencyKey: input.idempotencyKey!, runId: heartbeatId, acceptedAt: now });
        await admittedProducer(db, { companyId, agentId, issueId, stepRunId, heartbeatId, wakeId,
          idempotencyKey: input.idempotencyKey, qualityAcceptance: patch?.qualityAcceptance as Record<string, unknown> });
        await db.update(workflowStepRuns).set({ status: "completed", startedAt: now }).where(eq(workflowStepRuns.id, stepRunId));
        return true;
      } });
    return { heartbeatId, wakeId };
  };
  const outputDir = path.join(dir, issueId); await mkdir(outputDir);
  const file = path.join(outputDir, "content.json"); await writeFile(file, "{}");
  const register = (heartbeatId: string) => workProductService(db).createForIssue(issueId, companyId,
    { provider: "local_file", type: "document", title: "content.json", status: "active",
      createdByRunId: heartbeatId, metadata: { path: file } });
  const select = () => selectOfficialWorkProduct(db, { companyId, workflowRunId,
    stepId: "quality-execute", selector: { type: "document", title: "content.json" } });
  return { ...seed, ...binding, schedule, admit, register, select, readStep };
}
