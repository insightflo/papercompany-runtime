import { isDeepStrictEqual as same } from "node:util";
import { PgTransaction } from "drizzle-orm/pg-core";
import { readFrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { eq, is } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { artifactAttemptMetadata, freezeCompanyArtifactAttempt } from './artifact-attempt-start.js';
import { findCachedToolStepRun, getRunningConcurrencyCount } from "./dag-tool-step-lookups.js";
import { getSingleToolStepName } from "./dag-tool-step-name.js";
import { normalizeRecord, getMetadataRecord } from "./dag-metadata-helpers.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { persistFailedToolDispatch } from "./tool-dispatch-failure.js";
import { settleToolQueueMetadata } from "./tool-queue-settle.js";
import { resolveWorkflowToolStepArgs } from "./tool-step-args.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { STEP_MACHINE_CHECKS_TOOL } from "./step-machine-checks.js";
import { captureStructuralGateProducerToken } from "./control-flow/structural-semantic-readiness.js";
import { type PersistedWorkflowStep } from "./execution-steps.js";
import { buildWorkflowStepRunMetadata } from "./workflow-step-run-maintenance.js";
import { readWorkflowToolCorrection, hasWorkflowToolCorrectionInvocation, withWorkflowToolCorrection } from "./workflow-tool-correction.js";
import type { WorkflowStep } from "./dag-engine.js";
import { workflowToolStepExecutor } from "./workflow-tool-executor-registry.js";

async function blockToolStepRunForConcurrency(input: {
  db: Db;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
  concurrencyLimit: number;
  runningCount: number;
  now: Date;
}): Promise<void> {
  // [step-status fencing v1] 스냅샷 status CAS — 갱신 사이 다른 실행자가 상태를 옮겼으면 폐기.
  await setWorkflowStepRunStatus(input.db, {
    stepRunId: input.stepRun.id,
    status: "pending",
    patch: {
      metadata: {
        ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
        concurrencyBlocked: {
          concurrencyKey: input.concurrencyKey,
          concurrencyLimit: input.concurrencyLimit,
          runningCount: input.runningCount,
          checkedAt: input.now.toISOString(),
        },
      },
    },
    expectedStatuses: [input.stepRun.status],
  });
}

async function completeToolStepRunFromCache(input: {
  db: Db;
  stepRun: typeof workflowStepRuns.$inferSelect;
  sourceStepRun: typeof workflowStepRuns.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<void> {
  const sourceMetadata = normalizeRecord(input.sourceStepRun.metadata);
  const sourceToolResult = normalizeRecord(sourceMetadata.toolResult);
  const metadata = settleToolQueueMetadata({
    ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
    toolInvocation: {
      toolName: input.toolName,
      args: input.args,
      cacheCheckedAt: input.now.toISOString(),
    },
    toolResult: sourceToolResult,
    cacheHit: {
      sourceStepRunId: input.sourceStepRun.id,
      toolName: input.toolName,
      completedAt: input.now.toISOString(),
    },
  }, input.now.toISOString());
  delete metadata.concurrencyBlocked;

  // [step-status fencing v1] 스냅샷 status CAS — 갱신 사이 다른 실행자가 상태를 옮겼으면 폐기.
  await setWorkflowStepRunStatus(input.db, {
    stepRunId: input.stepRun.id,
    status: "completed",
    patch: {
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: input.now,
      metadata,
    },
    expectedStatuses: [input.stepRun.status],
  });
}

export async function failToolStepRunWithDispatchError(input: Parameters<typeof persistFailedToolDispatch>[0]): Promise<void> {
  await persistFailedToolDispatch(input, buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata));
}

export async function startIssueLessToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  /** [Task5a2a] 캡처된 실행 steps(loader 결과) — raw definition.stepsJson 재정규화 금지. */
  steps: WorkflowStep[];
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
}): Promise<boolean> {
  const { db, run, definition, step, stepRun, now } = input;

  const correction = stepRun.issueId ? await readWorkflowToolCorrection(db, run, stepRun, step) : null;
  if (stepRun.issueId && (!correction || is(db, PgTransaction))) return true;
  if (correction && hasWorkflowToolCorrectionInvocation(stepRun, correction)) return true;
  const toolName = getSingleToolStepName(step);
  const storedRequest = getMetadataRecord(stepRun.metadata, "toolArtifactRequest");
  const reuseRequest = correction && same(storedRequest.qaCorrectionFollowup, correction.ref)
    && typeof storedRequest.requestId === "string" && storedRequest.requestId === stepRun.lastDispatchRequestId;
  const requestId = reuseRequest ? storedRequest.requestId as string
    : correction?.ref.requestId ?? `${run.id}:${step.id}:${Date.now()}`;
  const workflowSteps = input.steps;
  let args: unknown;
  let artifactExecution: Awaited<ReturnType<typeof freezeCompanyArtifactAttempt>>;
  const failStart = async (error: unknown, failedArgs: unknown): Promise<boolean> => {
    const write = async (writer: Db) => {
      await failToolStepRunWithDispatchError({ db: writer, step,
        stepRun: correction ? { ...stepRun, metadata: { ...stepRun.metadata,
          qaCorrectionToolFollowup: correction.ref } } : stepRun,
        now, requestId, toolName, args: failedArgs, error });
      return false;
    };
    return correction ? (await withWorkflowToolCorrection({ db, run, stepRun, step, correction }, write)) ?? true
      : write(db);
  };
  try {
    // Reuse request identity and contract, not prepared arguments: QA preparation needs original paths.
    artifactExecution = reuseRequest
      ? readFrozenArtifactAttempt(stepRun.metadata.artifactExecution,
        { executionGeneration: stepRun.executionGeneration, requestId })
      : await freezeCompanyArtifactAttempt({ db, companyId: run.companyId, toolName, step,
        executionGeneration: stepRun.executionGeneration, requestId });
    args = await resolveWorkflowToolStepArgs({
      db, run, step: step as PersistedWorkflowStep, workflowSteps, consumerStepRunId: stepRun.id,
      consumerArtifactContract: artifactExecution?.contract,
    });
    if (reuseRequest && !same(storedRequest.artifactExecution, artifactExecution)) {
      throw new Error("artifact_contract_snapshot_stale");
    }
  } catch (error) {
    return failStart(error, step.toolArgs ?? {});
  }
  const concurrencyKey = step.executionControls?.concurrencyKey;
  const concurrencyLimit = step.executionControls?.concurrencyLimit;
  if (concurrencyKey && typeof concurrencyLimit === "number" && concurrencyLimit > 0) {
    const runningCount = await getRunningConcurrencyCount({
      db,
      run,
      stepRun,
      concurrencyKey,
    });
    if (runningCount >= concurrencyLimit) {
      const block = (writer: Db) => blockToolStepRunForConcurrency({
        db: writer,
        step,
        stepRun,
        concurrencyKey,
        concurrencyLimit,
        runningCount,
        now,
      });
      if (correction) await withWorkflowToolCorrection({ db, run, stepRun, step, correction }, block);
      else await block(db);
      return true;
    }
  }
  // QA/artifact attempts need current request-bound evidence, never generic cached results.
  if (!correction && !isStructuralGateStep(step) && !artifactExecution && !(step as PersistedWorkflowStep).toolArtifactContract) {
    const cachedStepRun = await findCachedToolStepRun({
      db,
      run,
      definition,
      step,
      toolName,
      args,
      now,
    });
    if (cachedStepRun) {
      await completeToolStepRunFromCache({
        db,
        stepRun,
        sourceStepRun: cachedStepRun,
        step,
        toolName,
        args,
        now,
      });
      return true;
    }
  }

  if (toolName !== "delegate_to_company" && toolName !== STEP_MACHINE_CHECKS_TOOL && !workflowToolStepExecutor) {
    return failStart("Workflow tool step executor is not configured.", args);
  }

  const structuralGateProducerToken = isStructuralGateStep(step)
    ? await captureStructuralGateProducerToken({ db, workflowRunId: run.id, gate: step, steps: workflowSteps })
    : null;
  if (isStructuralGateStep(step) && !structuralGateProducerToken) {
    return failStart("Structural gate producer generation is unavailable.", args);
  }

  const metadata: Record<string, unknown> = {
    ...artifactAttemptMetadata(buildWorkflowStepRunMetadata(step, stepRun.metadata), artifactExecution),
    ...(correction ? { qaCorrectionToolFollowup: correction.ref } : {}),
    toolInvocation: {
      requestId,
      toolName,
      args,
      queuedAt: now.toISOString(),
    },
    toolQueue: {
      status: "queued",
      queuedAt: now.toISOString(),
    },
    ...(structuralGateProducerToken ? { structuralGateProducerToken } : {}),
  };
  delete metadata.concurrencyBlocked;

  // [step-status fencing v1] 스냅샷 status CAS — 이미 다른 실행자가 전이시킨 행으로의
  //   늦은 running 덮어쓰기(running 재기입 + requestId 교체)를 폐기한다.
  const enqueue = (writer: Db) => setWorkflowStepRunStatus(writer, {
    stepRunId: stepRun.id,
    status: "running",
    patch: {
      startedAt: stepRun.startedAt ?? now,
      completedAt: null,
      lastDispatchAttemptAt: now,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
      lastDispatchRequestId: requestId,
      metadata,
    },
    expectedStatuses: [stepRun.status],
    extraConditions: correction ? [eq(workflowStepRuns.metadata, stepRun.metadata),
      eq(workflowStepRuns.executionGeneration, stepRun.executionGeneration),
      eq(workflowStepRuns.retryCount, stepRun.retryCount), eq(workflowStepRuns.iterationIndex, stepRun.iterationIndex)] : [],
  });
  if (correction) await withWorkflowToolCorrection({ db, run, stepRun, step, correction }, enqueue);
  else await enqueue(db);

  return true;
}
