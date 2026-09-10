import { eq } from "drizzle-orm";
import {
  activityLog,
  missions,
  workflowDefinitions,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import {
  validateExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
} from "../execution-definition-codec.js";
import {
  buildHistoricalExecutionSnapshot,
  parseReviewedHistoricalImportInput,
  type ReviewedHistoricalImportInput,
} from "./historical-import-core.js";

/**
 * [파일 목적] Task5d reviewed historical import 의 트랜잭션 오케스트레이션.
 *   운영자 스크립트(신뢰된 로컬 maintenance capability)만 호출한다 — HTTP/agent tool 경로가
 *   아니며, 임의 요청에서 authenticated user 를 단정하지 않는다. 날짜/현재 정의에서 증거를
 *   추론하지 않는다. 승격 대상은 reviewed provenance + recovered steps 뿐이다.
 * [불변식]
 *   - 잠금 순서 mission → run → run steps(step_id,id 정렬) FOR UPDATE. 데드락 방지 단일 순서.
 *   - workflow_definitions 는 identity/company 만 SELECT(FOR SHARE) — 현재 name/steps/timestamp
 *     를 historical payload 로 절대 사용하지 않는다.
 *   - 대상 run 은 실제 legacy terminal(completed|failed|cancelled) 이어야 하고, 기존 snapshot/
 *     creation marker 가 없어야 한다. snapshot 이 존재하면: 재계산 hash 와 정확히 일치하면
 *     쓰기/감사 없이 replay 결과를 돌리고, 아니면 409. 수리/덮어쓰기 없다.
 *   - 정규화된 step id 집합은 실제 run step 행과 정확히 전단사(bijection)여야 한다.
 *   - INSERT 는 workflow_run_definitions(capturedAt=now) + activity_log(같은 tx) 뿐이다.
 *     run/step/status/issue/metadata 는 절대 재기록하지 않고, resume marker 도 만들지 않는다.
 *   - activity insert 실패 시 snapshot insert 까지 전체 롤백된다(같은 트랜잭션).
 */

export type HistoricalImportStatus = "imported" | "replayed";

export interface HistoricalImportResult {
  status: HistoricalImportStatus;
  workflowRunId: string;
  definitionHash: string;
  sourceStepsHash: string;
  stepCount: number;
  capturedAt: string;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** run.metadata 의 예약 키 — 하나라도 있으면 importer 는 손대지 않는다(capture/resume 소관). */
function hasReservedRunMarker(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  return Object.prototype.hasOwnProperty.call(metadata, "executionDefinitionVersion")
    || Object.prototype.hasOwnProperty.call(metadata, "resumeRequestId");
}

/** 정규화된 step id 집합과 실제 run step 행의 step id 집합이 정확히 전단사인지 강제한다. */
function assertStepIdBijection(stepIds: string[], runStepRows: { stepId: string }[]): void {
  const normalized = new Set(stepIds);
  const actual = new Set(runStepRows.map((row) => row.stepId));
  if (normalized.size !== stepIds.length || actual.size !== runStepRows.length) {
    throw unprocessable("historical_step_set_mismatch", { reason: "duplicate_step_ids" });
  }
  if (normalized.size !== actual.size || [...normalized].some((id) => !actual.has(id))) {
    throw unprocessable("historical_step_set_mismatch", {
      reason: "step_id_set_mismatch",
      normalizedCount: normalized.size,
      actualCount: actual.size,
    });
  }
}

function resultOf(
  status: HistoricalImportStatus,
  input: ReviewedHistoricalImportInput,
  snapshot: ReturnType<typeof buildHistoricalExecutionSnapshot>,
  capturedAt: Date,
): HistoricalImportResult {
  return {
    status,
    workflowRunId: input.workflowRunId,
    definitionHash: snapshot.definitionHash,
    sourceStepsHash: input.provenance.review.sourceStepsHash,
    stepCount: snapshot.stepCount,
    capturedAt: capturedAt.toISOString(),
  };
}

/**
 * reviewed historical 정의를 실제 legacy terminal run 위에 1회 캡처한다.
 * 입력은 검증된 운영자 서비스 신뢰 입력이며, 성공 시 snapshot+감사 1회, 동일 재호출은 replay.
 */
export async function importReviewedHistoricalDefinition(
  db: Db,
  input: unknown,
): Promise<HistoricalImportResult> {
  const parsed = parseReviewedHistoricalImportInput(input);
  const snapshot = buildHistoricalExecutionSnapshot(parsed);

  return await db.transaction(async (tx) => {
    // 잠금 순서: mission → run → run steps. 스코프 조인이 company/workflow/mission 과 정확히 일치해야 한다.
    const [mission] = await tx.select({ id: missions.id, companyId: missions.companyId })
      .from(missions)
      .where(eq(missions.id, parsed.missionId))
      .for("update");
    if (!mission) throw notFound(`Mission not found: ${parsed.missionId}`);
    if (mission.companyId !== parsed.companyId) {
      throw unprocessable("scope_mismatch", { reason: "mission_company_mismatch" });
    }

    const [run] = await tx.select().from(workflowRuns)
      .where(eq(workflowRuns.id, parsed.workflowRunId))
      .for("update");
    if (!run) throw notFound(`Workflow run not found: ${parsed.workflowRunId}`);
    if (run.companyId !== parsed.companyId) {
      throw unprocessable("scope_mismatch", { reason: "run_company_mismatch" });
    }
    if (run.workflowId !== parsed.workflowId) {
      throw unprocessable("scope_mismatch", { reason: "run_workflow_mismatch" });
    }
    if (run.missionId !== parsed.missionId) {
      throw unprocessable("scope_mismatch", { reason: "run_mission_mismatch" });
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw unprocessable("historical_import_rejected", {
        reason: "run_not_terminal",
        workflowRunId: run.id,
      });
    }

    // identity/company 만 SELECT — 현재 정의 내용은 절대 소비하지 않는다.
    const [definition] = await tx.select({ id: workflowDefinitions.id, companyId: workflowDefinitions.companyId })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, parsed.workflowId))
      .for("share");
    if (!definition) throw notFound(`Workflow definition not found: ${parsed.workflowId}`);
    if (definition.companyId !== parsed.companyId) {
      throw unprocessable("scope_mismatch", { reason: "workflow_company_mismatch" });
    }

    const [existing] = await tx.select().from(workflowRunDefinitions)
      .where(eq(workflowRunDefinitions.workflowRunId, parsed.workflowRunId))
      .limit(1);
    if (existing) {
      // 정확히 같은 canonical payload 면 replay(무쓰기/무감사), 아니면 409 — 수리/덮어쓰기 없음.
      let existingHash: string;
      try {
        existingHash = hashExecutionDefinitionPayload(validateExecutionDefinitionPayload({
          schemaVersion: existing.schemaVersion,
          normalizerVersion: existing.normalizerVersion,
          companyId: existing.companyId,
          workflowRunId: existing.workflowRunId,
          executionMode: existing.executionMode,
          steps: existing.steps,
          provenance: existing.provenance,
        }));
      } catch {
        throw conflict("historical_import_rejected", {
          reason: "existing_snapshot_corrupt",
          workflowRunId: parsed.workflowRunId,
        });
      }
      if (existingHash !== snapshot.definitionHash) {
        throw conflict("historical_import_rejected", {
          reason: "definition_hash_mismatch",
          workflowRunId: parsed.workflowRunId,
        });
      }
      return resultOf("replayed", parsed, snapshot, existing.capturedAt);
    }
    if (hasReservedRunMarker(run.metadata)) {
      throw conflict("historical_import_rejected", {
        reason: "marked_run_without_snapshot",
        workflowRunId: parsed.workflowRunId,
      });
    }

    const runStepRows = await tx.select({ stepId: workflowStepRuns.stepId })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, parsed.workflowRunId))
      .orderBy(workflowStepRuns.stepId, workflowStepRuns.id)
      .for("update");
    assertStepIdBijection(snapshot.stepIds, runStepRows);

    await tx.insert(workflowRunDefinitions).values({
      workflowRunId: parsed.workflowRunId,
      companyId: parsed.companyId,
      schemaVersion: 1,
      definitionHash: snapshot.definitionHash,
      executionMode: snapshot.payload.executionMode,
      steps: snapshot.payload.steps,
      normalizerVersion: 1,
      provenance: snapshot.payload.provenance,
      capturedAt: parsed.now,
    });

    // 감사는 같은 tx — 실패 시 snapshot insert 까지 롤백된다. 파일 내용은 기록하지 않는다.
    await tx.insert(activityLog).values({
      companyId: parsed.companyId,
      actorType: "board",
      actorId: parsed.provenance.review.reviewedBy,
      action: "workflow.execution_definition_imported",
      entityType: "workflow_run",
      entityId: parsed.workflowRunId,
      agentId: null,
      runId: null,
      details: {
        sourceStepsHash: parsed.provenance.review.sourceStepsHash,
        definitionHash: snapshot.definitionHash,
        stepCount: snapshot.stepCount,
        review: {
          sourceRecord: parsed.provenance.review.sourceRecord,
          reviewedBy: parsed.provenance.review.reviewedBy,
          reviewedAt: parsed.provenance.review.reviewedAt,
        },
      },
    });

    return resultOf("imported", parsed, snapshot, parsed.now);
  });
}
