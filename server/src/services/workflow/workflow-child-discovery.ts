// server/src/services/workflow/workflow-child-discovery.ts
//
// [purpose] descope v1 — workflow→workflow 자식 시작 판별자(discriminator)의 "읽기 전용" 발견
//   전용 모듈. plain / linked / missing / invalid-child 네 분류만 존재하고 legacy 수리 래퍼는
//   삭제됐다(D5 — 수리/커밋된 claimed 재사용 없음). invalid-child 는 비정합 표지/링크
//   (claimed+nonnull, 커밋된 claimed, bound 행 누락 등)로, 절대 plain fallback 이 아니다.
//   발견은 어떤 쓰기/실행도 수행하지 않는다 — 변경은 반드시 이후 잠금 하 최종 변이가 검증한다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 텍스트/추론 권위 없음.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import type { ChildStartIdentity } from "./workflow-child-start-state.js";

export type WorkflowChildStartDiscovery =
  | { kind: "plain" }
  | { kind: "missing" }
  | { kind: "invalid-child"; reason: string }
  | {
    kind: "linked";
    identity: ChildStartIdentity;
    childStatus: string;
    materializedAt: Date | null;
  };

/** 발견 결과에서 ChildStartIdentity 를 구성한다(호출자 없음 — 내부 전용). */
function identityOf(
  child: typeof workflowRuns.$inferSelect,
  invocation: typeof workflowStepInvocations.$inferSelect,
  stepId: string,
): ChildStartIdentity {
  return {
    companyId: child.companyId,
    parentRunId: child.parentRunId!,
    parentStepRunId: child.parentStepRunId!,
    stepId,
    invocationId: invocation.id,
    generation: invocation.generation,
    childRunId: child.id,
  };
}

const invalid = (reason: string): WorkflowChildStartDiscovery => ({ kind: "invalid-child", reason });

/**
 * run 의 자식 시작 상태를 판별한다(무잠금 1차 발견 — 변경 전 잠금 하 재검증 필수).
 * linked 만 유효 신원을 실어 반환한다. invalid-child 는 절대 plain 실행 권한이 아니다.
 */
export async function discoverWorkflowChildStart(
  db: Db,
  runId: string,
): Promise<WorkflowChildStartDiscovery> {
  const [child] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!child) return { kind: "missing" };

  // 이 run 을 가리키는 invocation — linked 만이 아니라 "어떤 상태든" 표지다.
  const invocations = await db
    .select()
    .from(workflowStepInvocations)
    .where(eq(workflowStepInvocations.childRunId, child.id))
    .limit(2);

  const hasMarker = child.triggeredBy === "workflow-step"
    || child.parentRunId !== null
    || child.parentStepRunId !== null
    || invocations.length > 0;
  if (!hasMarker) return { kind: "plain" };

  // BASE_ID 연결 검증 — 하나라도 어긋나면 invalid-child(plain fallback 금지).
  if (invocations.length !== 1) return invalid("child marker without a unique invocation link");
  const invocation = invocations[0]!;
  if (!child.parentRunId || !child.parentStepRunId) return invalid("child run missing parent pointers");
  if (invocation.childRunId !== child.id) return invalid("invocation child link mismatch");
  if (invocation.companyId !== child.companyId) return invalid("invocation company mismatch");
  if (invocation.parentStepRunId !== child.parentStepRunId) return invalid("invocation parent step mismatch");
  if (invocation.generation !== 1) return invalid("invocation generation is not 1");
  if (invocation.state === "claimed") return invalid("committed claimed invocation state is not a legal runtime state");
  if (invocation.state !== "linked") return invalid(`unknown invocation state ${invocation.state}`);

  const [parentStep] = await db
    .select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, child.parentStepRunId))
    .limit(1);
  if (!parentStep || parentStep.workflowRunId !== child.parentRunId) {
    return invalid("parent step missing or mismatched");
  }
  const [parent] = await db
    .select({ id: workflowRuns.id, companyId: workflowRuns.companyId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, child.parentRunId))
    .limit(1);
  if (!parent || parent.companyId !== child.companyId) return invalid("parent run missing or company mismatch");

  return {
    kind: "linked",
    identity: identityOf(child, invocation, parentStep.stepId),
    childStatus: child.status,
    materializedAt: child.childStartMaterializedAt,
  };
}
