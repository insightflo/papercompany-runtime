import { workflowRuns, type Db } from "@paperclipai/db";
import {
  captureExecutionDefinition,
  EXECUTION_DEFINITION_CREATION_MARKER_VERSION,
} from "./execution-definition.js";
import type { CreateWorkflowRunInput } from "./types.js";

/**
 * [파일 목적] Task5a1 원자적 workflow run 생성. run INSERT 와 실행정의 스냅샷 캡처를
 *   하나의 트랜잭션으로 묶는다. 캡처 실패 시 두 row 모두 롤백된다 — snapshot 없는 새 run 은
 *   존재할 수 없다. 기존 store.createWorkflowRun 의 insert 필드/기본값을 그대로 복사한다.
 * [수정시 주의] metadata.executionDefinitionVersion 은 예약 마커다. caller metadata 를
 *   spread 한 뒤 마지막에 설정하므로 caller 가 덮어쓸 수 없다.
 */

export async function createWorkflowRunWithDefinition(
  db: Db,
  input: CreateWorkflowRunInput,
): Promise<typeof workflowRuns.$inferSelect> {
  const id = crypto.randomUUID();
  const now = new Date();
  return await db.transaction(async (tx) => {
    const [row] = await tx.insert(workflowRuns).values({
      id,
      workflowId: input.workflowId,
      companyId: input.companyId,
      missionId: input.missionId ?? null,
      status: "pending",
      triggeredBy: input.triggeredBy,
      triggerSource: input.triggerSource ?? null,
      runDate: input.runDate ?? null,
      runNumber: input.runNumber ?? null,
      runLabel: input.runLabel ?? null,
      parentIssueId: input.parentIssueId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentStepRunId: input.parentStepRunId ?? null,
      rootRunId: input.rootRunId ?? null,
      scheduledSlotId: input.scheduledSlotId ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        executionDefinitionVersion: EXECUTION_DEFINITION_CREATION_MARKER_VERSION,
      },
      createdAt: now,
    }).returning();
    if (!row) throw new Error("Workflow run insert returned no row");
    await captureExecutionDefinition(tx, row.id);
    return row;
  });
}
