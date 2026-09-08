import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { badRequest, notFound } from "../../../errors.js";

/**
 * [파일 목적] Task6a resume mutation 의 직렬화 경계. 하나의 db.transaction 안에서
 *   scope 된 mission FOR UPDATE → scope 된 run(id+company+mission) FOR UPDATE →
 *   run 의 모든 step_run(stepId, id 정렬) FOR UPDATE 를 획득한 뒤, 잠금 하에서
 *   caller callback 에 {tx, mission, run, steps} 를 넘긴다.
 * [수정시 주의]
 *   - 이 모듈은 정책/적격성을 판정하지 않는다. caller 가 잠금 하에서 자기 작업을 수행한다.
 *     nested transaction 이나 callback 이 제공한 caller tx 함수 이외의 외부 부수효과는 없다.
 *   - 모든 step 을 잠근다: 밖 row 보존 판정에도 일관된 view 가 필요하기 때문이다.
 *   - 일반 dispatcher 가 이 lock 을 사용한다는 주장은 아직 아니며, apply/dispatcher 마운트는
 *     이후 슬라이스에서 이어진다. 누락/cross-scope 는 notFound, UUID 위반은 사전 badRequest.
 */

export type ResumeMutationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ResumeMissionRow = typeof missions.$inferSelect;
export type ResumeRunRow = typeof workflowRuns.$inferSelect;
export type ResumeStepRunRow = typeof workflowStepRuns.$inferSelect;

export interface ResumeSerializationScope {
  companyId: string;
  missionId: string;
  runId: string;
}

export interface ResumeSerializationContext {
  tx: ResumeMutationTransaction;
  mission: ResumeMissionRow;
  run: ResumeRunRow;
  steps: ResumeStepRunRow[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function assertScopeUuid(name: string, value: unknown): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw badRequest(`Invalid resume serialization scope.${name}: expected a UUID`, { field: name });
  }
}

/**
 * [목적] resume mutation 대상 run 을 잠금 직렬화하고 caller 작업을 트랜잭션 하에서 실행한다.
 * [입력] db, scope(company/mission/run), fn(caller 작업). [출력] fn 의 반환값.
 * [주의] fn 이 던지면 트랜잭션 전체가 롤백된다. fn 내부에서 제공된 tx 만 사용할 것.
 */
export async function withResumeSerialization<T>(
  db: Db,
  scope: ResumeSerializationScope,
  fn: (context: ResumeSerializationContext) => Promise<T>,
): Promise<T> {
  assertScopeUuid("companyId", scope.companyId);
  assertScopeUuid("missionId", scope.missionId);
  assertScopeUuid("runId", scope.runId);
  return db.transaction(async (tx) => {
    const [mission] = await tx.select().from(missions)
      .where(and(
        eq(missions.id, scope.missionId),
        eq(missions.companyId, scope.companyId),
      ))
      .for("update");
    if (!mission) throw notFound(`Mission not found for resume serialization: ${scope.missionId}`);
    const [run] = await tx.select().from(workflowRuns)
      .where(and(
        eq(workflowRuns.id, scope.runId),
        eq(workflowRuns.companyId, scope.companyId),
        eq(workflowRuns.missionId, scope.missionId),
      ))
      .for("update");
    if (!run) throw notFound(`Workflow run not found for resume serialization: ${scope.runId}`);
    const steps = await tx.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, run.id))
      .orderBy(workflowStepRuns.stepId, workflowStepRuns.id)
      .for("update");
    return fn({ tx, mission, run, steps });
  });
}
