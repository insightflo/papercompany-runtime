import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { conflict, notFound } from "../../../errors.js";

/**
 * [파일 목적] Task6b resume 수락 가드. run.metadata.resumeRequestId 가 있으면 이력 resume 이
 *   실제로 수락되었는지(accepted request + 대응 execution + 일치하는 generation 기록)를
 *   SELECT 로 검증하고, 없으면 legacy no-op 로 통과시킨다.
 * [수정시 주의]
 *   - resumeRequestId 키가 존재하는데 malformed(null/blank/non-uuid)면 conflict
 *     resume_not_accepted — legacy fallback 으로 절대 우회하지 않는다.
 *   - execution state 중 queued/running/completed 만 통과. completed 는 "초기 전달 완료"를
 *     의미하며 이후의 ordinary sync 를 막지 않는다. blocked/cancelled 는 거부.
 *   - 이 가드는 SELECT 만 수행한다. accepted row 가 execution/reset 을 만들지 않는다.
 *     race 방어는 caller 가 mutation 경계에서 serialization 잠금과 함께 사용해야 하며,
 *     이 함수 자체는 lock manager 가 아니고 적격성(eligibility)을 증명하지도 않는다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RESUME_EXECUTION_OPEN_STATES: ReadonlySet<string> = new Set(["queued", "running", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyGenerationRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.length > 0 && isSafeNonNegative(value[key]));
}

function generationRecordsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && b[key] === a[key]);
}

/**
 * [목적] run 이 resume 승인 계약을 만족하는지 SELECT 로 단언한다. 통과 시 아무것도 쓰지 않는다.
 * [입력] caller tx(select 가능), runId, caller 가 기대하는 authorityVersion.
 * [주의] 위반은 모두 conflict resume_not_accepted(409). run 부재만 notFound(404).
 */
export async function assertResumeAccepted(
  tx: Pick<Db, "select">,
  runId: string,
  expectedAuthorityVersion: number,
): Promise<void> {
  const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!run) throw notFound(`Workflow run not found: ${runId}`);
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  if (!Object.prototype.hasOwnProperty.call(metadata, "resumeRequestId")) return;
  const reject = (reason: string) => conflict("resume_not_accepted", {
    workflowRunId: run.id,
    reason,
  });
  const resumeRequestId = metadata.resumeRequestId;
  if (typeof resumeRequestId !== "string" || !UUID_PATTERN.test(resumeRequestId)) {
    throw reject("malformed_resume_request_id");
  }
  if (!isSafeNonNegative(expectedAuthorityVersion)) throw reject("invalid_expected_authority_version");
  const resumeAuthorityVersion = metadata.resumeAuthorityVersion;
  if (!isSafeNonNegative(resumeAuthorityVersion)
    || !isSafeNonNegative(run.dispatchAuthorityVersion)
    || resumeAuthorityVersion !== run.dispatchAuthorityVersion) {
    throw reject("resume_authority_version_mismatch");
  }
  if (typeof run.missionId !== "string") throw reject("run_without_mission_scope");
  const [request] = await tx.select().from(workflowResumeRequests).where(and(
    eq(workflowResumeRequests.id, resumeRequestId),
    eq(workflowResumeRequests.companyId, run.companyId),
    eq(workflowResumeRequests.missionId, run.missionId),
    eq(workflowResumeRequests.workflowRunId, run.id),
  ));
  if (!request) throw reject("resume_request_not_found");
  if (request.state !== "accepted" || request.acceptedAt === null) {
    throw reject(`resume_request_state_${request.state}`);
  }
  const [execution] = await tx.select().from(workflowResumeExecutions).where(and(
    eq(workflowResumeExecutions.requestId, request.id),
    eq(workflowResumeExecutions.companyId, run.companyId),
    eq(workflowResumeExecutions.missionId, run.missionId),
    eq(workflowResumeExecutions.workflowRunId, run.id),
  ));
  if (!execution) throw reject("resume_execution_not_found");
  if (!RESUME_EXECUTION_OPEN_STATES.has(execution.state)) {
    throw reject(`resume_execution_state_${execution.state}`);
  }
  if (execution.authorityVersion !== expectedAuthorityVersion
    || execution.authorityVersion !== run.dispatchAuthorityVersion) {
    throw reject("execution_authority_version_mismatch");
  }
  const appliedGenerations = request.appliedGenerations;
  const executionGenerations = execution.generations;
  if (!isNonEmptyGenerationRecord(appliedGenerations)
    || !isNonEmptyGenerationRecord(executionGenerations)
    || !generationRecordsEqual(appliedGenerations, executionGenerations)) {
    throw reject("resume_generation_records_mismatch");
  }
  const stepRows = await tx.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, run.id));
  const stepsByStepId = new Map(stepRows.map((step) => [step.stepId, step]));
  for (const [stepId, generation] of Object.entries(appliedGenerations)) {
    const step = stepsByStepId.get(stepId);
    if (!step) throw reject("resume_generation_step_not_found");
    if (step.executionGeneration !== generation) throw reject("resume_generation_step_mismatch");
    const stepMetadata = isRecord(step.metadata) ? step.metadata : {};
    if (stepMetadata.resumeRequestId !== resumeRequestId) {
      throw reject("resume_generation_step_owner_mismatch");
    }
  }
}
