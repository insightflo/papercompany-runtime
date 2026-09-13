// server/src/services/quality/native-definition.ts
//
// [purpose] T3 고정 native 실행 정의. 조치의 고정 target/effect/정책에서 결정론적으로 step 를
//   만들고, PAQO 와 같은 동결 해시 알고리즘(computePaqoDefinitionHash)으로 definitionHash 를
//   계산해 (companyId, sourceKind='quality', missionId, definitionHash) 불변 정의 행을
//   찾거나 만든다. 기존 행은 절대 갱신하지 않는다. 실행 직전에는 저장된 stepsJson 를 다시
//   정규화해 해시가 저장 definitionHash 와 일치하는지 재검증한다(stepsJson 변조 감지).
// [authority] step 배열이 실행 의미 전부다. 표시용 이름·시각은 해시에 들어가지 않는다.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { qualityActions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import type { QualityPolicy, QualityTarget } from "@paperclipai/shared";
import { conflict, HttpError } from "../../errors.js";
import { computePaqoDefinitionHash } from "../workflow/paqo-definition-identity.js";
import { normalizeWorkflowStepsForExecution, type WorkflowStep } from "../workflow/dag-engine.js";

export const QUALITY_DEFINITION_SOURCE_KIND = "quality";
export const QUALITY_EXECUTE_STEP_ID = "quality-execute";
export const QUALITY_VERIFY_STEP_ID = "quality-verify";

export type QualityWorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
type DefinitionDb = Pick<Db, "select" | "insert">;

/** 조치의 고정 target/정책에서 결정론적 step 배열. 첫 버전은 단일 실행 step 이다. */
export function buildQualityExecutionSteps(input: {
  actionIntentKey: string;
  ownerAgentId: string;
  target: QualityTarget;
  policy: QualityPolicy;
}): WorkflowStep[] {
  void input.policy;
  return [
    {
      id: QUALITY_EXECUTE_STEP_ID,
      name: `Quality execution (${input.target.kind})`,
      description: `Fixed quality execution for action intent ${input.actionIntentKey}.`,
      agentId: input.ownerAgentId,
      dependencies: [],
    },
  ];
}

/** [T6] 독립 검증 B 단계 — 후보가 고정된 뒤 같은 mission 에 만들어지는 별도 실행 정의. */
export function buildQualityVerificationSteps(input: {
  actionIntentKey: string;
  verifierAgentId: string;
}): WorkflowStep[] {
  return [
    {
      id: QUALITY_VERIFY_STEP_ID,
      name: `Quality verification (${input.actionIntentKey})`,
      description: `Independent verifier evaluation of the fixed candidate for action intent ${input.actionIntentKey}.`,
      agentId: input.verifierAgentId,
      dependencies: [],
    },
  ];
}

/** 저장 행의 stepsJson 을 다시 정규화해 계산한 해시가 저장 definitionHash 와 일치해야 한다. */
export function assertStoredDefinitionIntact(row: Pick<QualityWorkflowDefinitionRow, "stepsJson" | "definitionHash" | "sourceKind">): void {
  if (row.sourceKind !== QUALITY_DEFINITION_SOURCE_KIND) throw conflict("quality_definition_hash_mismatch");
  const steps = normalizeWorkflowStepsForExecution(row.stepsJson);
  if (computePaqoDefinitionHash(steps) !== row.definitionHash) {
    throw conflict("quality_definition_hash_mismatch");
  }
}

function findQualityDefinition(
  dbOrTx: DefinitionDb,
  input: { companyId: string; missionId: string; definitionHash: string },
) {
  return dbOrTx
    .select()
    .from(workflowDefinitions)
    .where(and(
      eq(workflowDefinitions.companyId, input.companyId),
      eq(workflowDefinitions.sourceKind, QUALITY_DEFINITION_SOURCE_KIND),
      eq(workflowDefinitions.missionId, input.missionId),
      eq(workflowDefinitions.definitionHash, input.definitionHash),
    ))
    .limit(1);
}

/**
 * 불변 quality 정의 찾기 또는 생성. 호출 트랜잭션이 조치 행 잠금으로 직렬화되므로
 * 동시 삽입 경합은 없다(없으면 만들고, 있면 무결성 재검증 후 재사용). 갱신은 절대 하지 않는다.
 */
export async function findOrCreateImmutableQualityWorkflowDefinition(
  dbOrTx: DefinitionDb,
  input: { companyId: string; missionId: string; steps: WorkflowStep[] },
): Promise<QualityWorkflowDefinitionRow> {
  // 저장/해시 모두 정규화된 step 기준 — PAQO 와 같은 규약(읽기 재정규화 결과와 동일).
  const steps = normalizeWorkflowStepsForExecution(input.steps);
  const definitionHash = computePaqoDefinitionHash(steps);
  const [existing] = await findQualityDefinition(dbOrTx, { ...input, definitionHash });
  if (existing) {
    assertStoredDefinitionIntact(existing);
    return existing;
  }
  const id = crypto.randomUUID();
  const now = new Date();
  await dbOrTx.insert(workflowDefinitions).values({
    id,
    companyId: input.companyId,
    name: `quality-execution-${id.slice(0, 8)}`,
    description: null,
    status: "active",
    stepsJson: steps,
    missionId: input.missionId,
    definitionHash,
    source: "native",
    sourceKind: QUALITY_DEFINITION_SOURCE_KIND,
    createdAt: now,
    updatedAt: now,
  });
  const [created] = await findQualityDefinition(dbOrTx, { ...input, definitionHash });
  if (!created) throw conflict("quality_definition_create_failed");
  return created;
}

/** 바인딩된 실행의 정의 행을 회사 스코프로 읽어 저장 무결성(해시 재검증)을 확인한다. */
export async function reverifyQualityDefinitionForRun(
  dbOrTx: Pick<Db, "select">,
  input: { companyId: string; workflowRunId: string },
): Promise<void> {
  const [row] = await dbOrTx
    .select({ stepsJson: workflowDefinitions.stepsJson, definitionHash: workflowDefinitions.definitionHash, sourceKind: workflowDefinitions.sourceKind })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, and(eq(workflowDefinitions.id, workflowRuns.workflowId), eq(workflowDefinitions.companyId, workflowRuns.companyId)))
    .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
    .limit(1);
  if (!row) throw conflict("quality_definition_hash_mismatch");
  assertStoredDefinitionIntact(row);
}

/**
 * [T3] Quality 고정 정의 불변 가드(generic update/delete 금지). 라벨만 보지 않고 실제 run
 * 연결과 quality action binding 연결을 조회해 증거로 삼는다(연결이 없어도 생성 계약
 * 자체가 불변이므로 거절한다). workflow/engine.ts 의 update/delete 진입점이 호출한다.
 */
export async function assertDefinitionNotQualityOwned(db: Db, id: string): Promise<void> {
  const [definition] = await db.select({ id: workflowDefinitions.id, sourceKind: workflowDefinitions.sourceKind })
    .from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).limit(1);
  if (!definition || definition.sourceKind !== QUALITY_DEFINITION_SOURCE_KIND) return;
  const [runLink] = await db.select({ n: sql<number>`count(*)::int` }).from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id));
  const [actionLink] = await db.select({ n: sql<number>`count(*)::int` }).from(qualityActions)
    .where(sql`exists (select 1 from ${workflowRuns} where ${workflowRuns.workflowId} = ${id} and (${qualityActions.canonicalBinding}->>'workflowRunId')::uuid = ${workflowRuns.id})`);
  throw new HttpError(409, "quality_definition_immutable", { runs: runLink?.n ?? 0, boundActions: actionLink?.n ?? 0 });
}
