import { ensureWorkflowStepRunRecords, type MaterializationOutcome } from "./workflow-step-materialization.js";
import { type ChildStartFence } from "./workflow-child-start-state.js";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { normalizeRecord } from "./dag-metadata-helpers.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { isWorkflowChildStep } from "./workflow-child-execution.js";
import { reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import type { WorkflowStep } from "./dag-engine.js";

/** workflow-type 스텝 id 집합 — 리셋/재오픈 금지(D2) 필터에 쓴다. */
export function workflowChildStepIds(steps: WorkflowStep[]): Set<string> {
  return new Set(steps.filter(isWorkflowChildStep).map((step) => step.id));
}

export async function ensureStepRunRecords(
  db: Db,
  runId: string,
  steps: WorkflowStep[],
  childStartFence?: ChildStartFence,
  requireRunning?: boolean,
): Promise<MaterializationOutcome> {
  // [fix4 §2.3 / cycle A §7] materialization 은 전용 모듈로 이관했다 — run 행 직렬화, (run,step)
  //   유일 인덱스 충돌 안전 insert, 자식 시작 fence 원자 소비. 소유 결과(ready/not-owner/busy)를
  //   타입으로 그대로 보존한다(null 로 버리지 않는다).
  return await ensureWorkflowStepRunRecords(db, {
    runId,
    steps,
    ...(childStartFence ? { childStartFence } : {}),
    ...(requireRunning ? { requireRunning } : {}),
    buildMetadata: (step) => buildWorkflowStepRunMetadata(step as unknown as WorkflowStep),
    syncControls: (syncDb, rows, syncSteps) => syncStepRunExecutionControlMetadata(syncDb, rows, syncSteps as unknown as WorkflowStep[]),
  });
}

export function buildWorkflowStepRunMetadata(
  step: WorkflowStep,
  existingMetadata: unknown = {},
): Record<string, unknown> {
  const metadata = { ...normalizeRecord(existingMetadata) };
  if (step.executionControls && Object.keys(step.executionControls).length > 0) {
    metadata.executionControls = step.executionControls;
  } else {
    delete metadata.executionControls;
  }
  // heartbeat missing-workProduct gate가 이 step의 산출물 여부를
  // title/contract 휴리스틱 없이 권위적으로 판정하도록 stamp. syncStepRunExecutionControlMetadata 가
  // 로드 시마다 재동기화하므로 기존 step-run에도 채워진다.
  metadata.graphWorkProductRequired = step.graphWorkProductRequired === true;
  return metadata;
}

function metadataJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function syncStepRunExecutionControlMetadata(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  if (stepRuns.length === 0) return stepRuns;

  const stepById = new Map(steps.map((step) => [step.id, step]));
  let changed = false;
  for (const stepRun of stepRuns) {
    const step = stepById.get(stepRun.stepId);
    if (!step) continue;
    const nextMetadata = buildWorkflowStepRunMetadata(step, stepRun.metadata);
    if (metadataJson(stepRun.metadata) === metadataJson(nextMetadata)) continue;
    changed = true;
    await db
      .update(workflowStepRuns)
      .set({ metadata: nextMetadata })
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  if (!changed) return stepRuns;
  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}

export async function resetUnlaunchedTerminalStepRuns(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  excludeWorkflowStepIds?: ReadonlySet<string>,
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  // [descope D2] workflow-type S 는 리셋 대상에서 "명시적으로" 제외된다 — 자식 실패로 정산된
  //  (또는 pre-admission 거부된) 부모 스텝은 resume/retry 경로에서 재오픈되지 않는다.
  // controlFlowSkipped/failureCascadeSkipped sentinel: IF false-branch 로 skip 된 step 과 60min reconciler 가 kill 한 step(failureCascadeSkipped, 가즈아 저녁3 4f8cfacb 플랩)
  // 은 리셋에서 제외한다. 그렇지 않으면 매 sync 마다 skipped→pending→(skip pass)→skipped 로
  // flap 하며 finalize 가 allStepsTerminal 에 수렴하지 못해 런 상태 진동을 유발한다.
  const unlaunchedTerminal = stepRuns.filter((stepRun) =>
    (stepRun.status === "skipped" || stepRun.status === "failed")
    && stepRun.issueId == null
    && stepRun.startedAt == null
    && stepRun.lastDispatchAttemptAt == null
    && !(excludeWorkflowStepIds?.has(stepRun.stepId) ?? false)
    && normalizeRecord(stepRun.metadata).controlFlowSkipped !== true
    && normalizeRecord(stepRun.metadata).failureCascadeSkipped !== true
  );
  if (unlaunchedTerminal.length === 0) return stepRuns;

  // [step-status fencing v1] skipped/failed → pending 리셋을 행별 status CAS 로 — 리셋 도중
  //   다른 실행자가 이미 상태를 옮긴 행을 pending 으로 되돌리는 좀비쓰기를 막는다.
  //   폐기된 행은 이후 reload 가 실제 상태로 수렴시킨다.
  for (const stepRun of unlaunchedTerminal) {
    await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "pending",
      patch: { startedAt: null, completedAt: null },
      expectedStatuses: ["skipped", "failed"],
    });
  }

  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}
