import { eq } from "drizzle-orm";
import {
  missions,
  workflowDefinitions,
  workflowRunDefinitions,
  workflowRuns,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import {
  buildWorkflowExecutionSteps,
  isDynamicOwnerPlanWorkflowDefinition,
} from "./execution-steps.js";
import {
  buildExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
  validateExecutionDefinitionPayload,
} from "./execution-definition-codec.js";
import type { ExecutionDefinitionPayload, ExecutionDefinitionProvenance } from "./execution-definition-codec.js";
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";

/**
 * [파일 목적] Task5a1 실행정의 스냅샷의 캡처(생성 시 1회)와 읽기(SELECT-only)를 담당한다.
 *   캡처는 새 run 생성 트랜잭션 안에서만 호출된다(importer/backfill 경로 없음).
 *   읽기는 절대 쓰지 않으며, snapshot 이 없는 unmarked legacy run 만 current-definition
 *   fallback 을 유지한다. corrupt/미인증 snapshot 은 항상 fail-closed(422)이다.
 * [수정시 주의] frozen read 는 Task5a0 normalized 함수를 steps 에 재적용하지 않는다.
 *   legacy fallback 만 buildWorkflowExecutionSteps(current builder)를 사용한다.
 */

export type TransactionDb = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | TransactionDb;
/** [task5a2b] loadExecutionDefinition 은 SELECT-only 이므로 read 입력은 select 표면만 요구한다.
 *  actual Db 와 TransactionDb(PgTransaction) 는 모두 이 표면을 구조적으로 만족한다(쓰기 요구 없음). */
export type ExecutionDefinitionReadDb = Pick<Db, "select">;

/** run.metadata 의 예약 생성 마커. caller 가 덮어쓸 수 없다. */
export const EXECUTION_DEFINITION_CREATION_MARKER_VERSION = 1 as const;

export type ExecutionDefinitionSource = "snapshot" | "legacy_current";

export interface LoadedExecutionDefinition {
  schemaVersion: 1;
  normalizerVersion: 1;
  steps: WorkflowStep[];
  definitionHash: string;
  executionMode: WorkflowExecutionMode;
  source: ExecutionDefinitionSource;
  provenance: ExecutionDefinitionProvenance | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function historicalUnproven(reason: string, extra: Record<string, unknown> = {}) {
  return unprocessable("historical_definition_unproven", { reason, ...extra });
}

function inferExecutionMode(definition: {
  name: string;
  executionMode: string | null;
  dynamicPlanBootstrapOnly: boolean;
}, steps: WorkflowStep[]): WorkflowExecutionMode {
  return isDynamicOwnerPlanWorkflowDefinition({
    name: definition.name,
    executionMode: definition.executionMode,
    dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
    steps,
  })
    ? "dynamic_owner_plan"
    : "static_dag";
}

/**
 * run 생성 트랜잭션 안에서 실행정의를 1회 캡처한다. 외부 호출/상태 변경 없이
 * snapshot INSERT 만 수행하고, 실패 시 트랜잭션 전체가 롤백된다.
 */
export async function captureExecutionDefinition(tx: TransactionDb, runId: string): Promise<void> {
  const [run] = await tx.select().from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .for("update");
  if (!run) throw notFound(`Workflow run not found: ${runId}`);
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  if (run.status !== "pending" || run.startedAt !== null || run.completedAt !== null) {
    throw unprocessable("execution_definition_capture_rejected", {
      reason: "run_not_pending",
      workflowRunId: run.id,
    });
  }
  if (metadata.executionDefinitionVersion !== EXECUTION_DEFINITION_CREATION_MARKER_VERSION) {
    throw unprocessable("execution_definition_capture_rejected", {
      reason: "missing_creation_marker",
      workflowRunId: run.id,
    });
  }
  const [existing] = await tx.select({ workflowRunId: workflowRunDefinitions.workflowRunId })
    .from(workflowRunDefinitions)
    .where(eq(workflowRunDefinitions.workflowRunId, runId))
    .limit(1);
  if (existing) {
    throw conflict(`Execution definition already captured for run: ${runId}`);
  }

  const [definition] = await tx.select().from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, run.workflowId))
    .for("share");
  if (!definition) throw notFound(`Workflow definition not found: ${run.workflowId}`);
  if (definition.companyId !== run.companyId) {
    throw unprocessable("scope_mismatch", {
      reason: "workflow_company_mismatch",
      workflowRunId: run.id,
    });
  }
  if (run.missionId !== null) {
    const [mission] = await tx.select().from(missions)
      .where(eq(missions.id, run.missionId))
      .limit(1);
    if (!mission) throw notFound(`Mission not found: ${run.missionId}`);
    if (mission.companyId !== run.companyId) {
      throw unprocessable("scope_mismatch", {
        reason: "mission_company_mismatch",
        workflowRunId: run.id,
      });
    }
  }

  const steps = buildWorkflowExecutionSteps({
    name: definition.name,
    stepsJson: definition.stepsJson,
    executionMode: definition.executionMode,
    dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
  });
  const executionMode = inferExecutionMode(definition, steps);
  const provenance: ExecutionDefinitionProvenance = {
    schemaVersion: 1,
    origin: "run_creation",
    workflowId: definition.id,
    missionId: run.missionId ?? null,
    workflowName: definition.name,
    source: definition.source ?? null,
    sourceKind: definition.sourceKind ?? null,
    definitionUpdatedAt: definition.updatedAt.toISOString(),
  };
  // JSONB 직렬화와 동일하게 undefined 필드를 제거한 뒤 검증/해시한다(1회 roundtrip).
  const roundtrippedSteps = JSON.parse(JSON.stringify(steps)) as unknown[];
  const payload = buildExecutionDefinitionPayload({
    companyId: run.companyId,
    workflowRunId: run.id,
    executionMode,
    steps: roundtrippedSteps,
    provenance,
  });
  validateExecutionDefinitionPayload(payload);
  const definitionHash = hashExecutionDefinitionPayload(payload);

  await tx.insert(workflowRunDefinitions).values({
    workflowRunId: run.id,
    companyId: run.companyId,
    schemaVersion: 1,
    definitionHash,
    executionMode,
    steps: payload.steps,
    normalizerVersion: 1,
    provenance,
    capturedAt: new Date(),
  });
}

/**
 * 실행정의를 SELECT-only 로 읽는다. snapshot 이 있으면 검증+해시 대조 후 그대로 반환하고,
 * snapshot 이 없는 unmarked legacy run 만 current-definition fallback 을 돌려준다.
 * 결과 반환을 위해 DB 를 절대 갱신하지 않는다.
 */
export async function loadExecutionDefinition(
  dbOrTx: ExecutionDefinitionReadDb,
  runId: string,
  options: { requireHistorical: boolean },
): Promise<LoadedExecutionDefinition> {
  const [run] = await dbOrTx.select().from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!run) throw notFound(`Workflow run not found: ${runId}`);

  const [definition] = await dbOrTx.select().from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, run.workflowId))
    .limit(1);
  if (!definition) throw notFound(`Workflow definition not found: ${run.workflowId}`);
  if (definition.companyId !== run.companyId) {
    throw unprocessable("scope_mismatch", {
      reason: "workflow_company_mismatch",
      workflowRunId: run.id,
    });
  }
  if (run.missionId !== null) {
    const [mission] = await dbOrTx.select().from(missions)
      .where(eq(missions.id, run.missionId))
      .limit(1);
    if (!mission) throw notFound(`Mission not found: ${run.missionId}`);
    if (mission.companyId !== run.companyId) {
      throw unprocessable("scope_mismatch", {
        reason: "mission_company_mismatch",
        workflowRunId: run.id,
      });
    }
  }

  const [snapshot] = await dbOrTx.select().from(workflowRunDefinitions)
    .where(eq(workflowRunDefinitions.workflowRunId, runId))
    .limit(1);

  if (snapshot) {
    const payloadValue = {
      schemaVersion: snapshot.schemaVersion,
      normalizerVersion: snapshot.normalizerVersion,
      companyId: snapshot.companyId,
      workflowRunId: snapshot.workflowRunId,
      executionMode: snapshot.executionMode,
      steps: snapshot.steps,
      provenance: snapshot.provenance,
    };
    let payload: ExecutionDefinitionPayload;
    try {
      payload = validateExecutionDefinitionPayload(payloadValue);
    } catch (error) {
      throw historicalUnproven("malformed_definition", {
        workflowRunId: run.id,
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
    const computedHash = hashExecutionDefinitionPayload(payload);
    if (computedHash !== snapshot.definitionHash) {
      throw historicalUnproven("hash_mismatch", { workflowRunId: run.id });
    }
    if (
      payload.companyId !== run.companyId
      || payload.workflowRunId !== run.id
      || payload.provenance.workflowId !== run.workflowId
      || payload.provenance.missionId !== run.missionId
    ) {
      throw unprocessable("scope_mismatch", {
        reason: "snapshot_identity_mismatch",
        workflowRunId: run.id,
      });
    }
    return {
      schemaVersion: 1,
      normalizerVersion: 1,
      steps: payload.steps as WorkflowStep[],
      definitionHash: snapshot.definitionHash,
      executionMode: payload.executionMode,
      source: "snapshot",
      provenance: payload.provenance,
    };
  }

  if (options.requireHistorical) {
    throw historicalUnproven("missing_snapshot", { workflowRunId: run.id });
  }
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  if (
    Object.prototype.hasOwnProperty.call(metadata, "executionDefinitionVersion")
    || Object.prototype.hasOwnProperty.call(metadata, "resumeRequestId")
  ) {
    throw historicalUnproven("marked_run_without_snapshot", { workflowRunId: run.id });
  }

  const steps = buildWorkflowExecutionSteps({
    name: definition.name,
    stepsJson: definition.stepsJson,
    executionMode: definition.executionMode,
    dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
  });
  const executionMode = inferExecutionMode(definition, steps);
  // [계약] legacy fallback 의 transient hash — historical 증거로는 절대 수리되지 않는다.
  const transientHash = hashStructuredValue({
    schemaVersion: 1,
    normalizerVersion: 1,
    companyId: run.companyId,
    workflowRunId: run.id,
    executionMode,
    steps,
    origin: "legacy_current",
  });
  return {
    schemaVersion: 1,
    normalizerVersion: 1,
    steps,
    definitionHash: transientHash,
    executionMode,
    source: "legacy_current",
    provenance: null,
  };
}
