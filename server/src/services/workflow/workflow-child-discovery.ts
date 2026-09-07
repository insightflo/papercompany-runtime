// server/src/services/workflow/workflow-child-discovery.ts
//
// [purpose] [cycle B F4] workflow→workflow 자식 시작 판별자(discriminator) 전용 모듈.
//   linked 전용 발견(findChildStartIdentityForRun)은 "신원 없음 = plain run"으로 동치시켜
//   자식 표지를 가진 레거시/비정합 run 이 plain 으로 실행되는 결함을 만들었다. 이 모듈은
//   plain / linked / legacy / invalid-child / missing 을 구분한다.
//   - 자식 표지(child-marker): triggeredBy='workflow-step' OR 부모 포인터(parentRunId/
//     parentStepRunId) 하나라도 non-null OR 이 run 을 child_run_id 로 가리키는 invocation 존재.
//   - 표지가 하나도 없으면 plain. 표지가 있으면 BASE_ID 연결(회사/부모/스텝/세대/자식)을
//     전부 검증한다 — 모호(복수 invocation)/회사 불일치/부모·스텝 부재/invocation 부재는
//     invalid-child 다. 실패한 발견은 plain 실행 권한이 "절대" 아니다(fail-closed).
//   - 발견은 읽기 전용이다. 수리는 별도(repairLegacyChildLink)이며 잠금 하에서만 일어난다.
// [authority] 내구 레코드만이 권위(규칙 7/8). 텍스트/추론 권위 없음.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import type { ChildStartIdentity } from "./workflow-child-start-state.js";
import { repairLegacyChildLink } from "./workflow-child-legacy-link.js";

export type WorkflowChildStartDiscovery =
  | { kind: "plain" }
  | { kind: "missing" }
  | { kind: "invalid-child" }
  | {
    kind: "linked" | "legacy";
    identity: ChildStartIdentity;
    childStatus: string;
    materializedAt: Date | null;
  };

export type WorkflowChildStartWriteEntry =
  | { kind: "proceed"; identity: ChildStartIdentity }
  | { kind: "yield" }
  | { kind: "plain" };

/** 발견 결과에서 ChildStartIdentity 를 구성한다(호출자 없음 — 내부 전용). */
function identityOf(
  child: typeof workflowRuns.$inferSelect,
  invocation: typeof workflowStepInvocations.$inferSelect,
): ChildStartIdentity {
  return {
    companyId: child.companyId,
    parentRunId: child.parentRunId!,
    parentStepRunId: child.parentStepRunId!,
    invocationId: invocation.id,
    generation: invocation.generation,
    childRunId: child.id,
  };
}

/**
 * run 의 자식 시작 상태를 판별한다(무잠금 1차 발견 — 변경 전 잠금 하 재검증 필수).
 * linked/legacy 는 유효 신원을 실어 반환하고, invalid-child 는 절대 plain fallback 이 아니다.
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
  if (invocations.length !== 1) return { kind: "invalid-child" }; // 없음(표지 불일치) 또는 모호(복수).
  const invocation = invocations[0]!;
  if (!child.parentRunId || !child.parentStepRunId) return { kind: "invalid-child" };
  if (invocation.childRunId !== child.id) return { kind: "invalid-child" };
  if (invocation.companyId !== child.companyId) return { kind: "invalid-child" };
  if (invocation.parentStepRunId !== child.parentStepRunId) return { kind: "invalid-child" };
  if (!Number.isInteger(invocation.generation) || invocation.generation < 1) {
    return { kind: "invalid-child" };
  }
  const [parent] = await db
    .select({ id: workflowRuns.id, companyId: workflowRuns.companyId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, child.parentRunId))
    .limit(1);
  if (!parent || parent.companyId !== child.companyId) return { kind: "invalid-child" };
  const [parentStep] = await db
    .select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, child.parentStepRunId))
    .limit(1);
  if (!parentStep || parentStep.workflowRunId !== parent.id) return { kind: "invalid-child" };
  if (invocation.state !== "linked" && invocation.state !== "claimed") {
    return { kind: "invalid-child" };
  }
  if (invocation.state === "claimed") {
    return {
      kind: "legacy",
      identity: identityOf(child, invocation),
      childStatus: child.status,
      materializedAt: child.childStartMaterializedAt,
    };
  }
  return {
    kind: "linked",
    identity: identityOf(child, invocation),
    childStatus: child.status,
    materializedAt: child.childStartMaterializedAt,
  };
}

/**
 * 쓰기 진입 공용 프리플라이트 — 발견 → legacy 판별자 수리 → 신선한 linked 재발견.
 *   plain/missing 은 호출자의 기존 plain 경로 유지를 위해 "plain"으로 반환하고, linked(수리 후
 *   포함)는 "proceed"+신원, invalid-child/수리 실패(busy/ineligible)/재발견 실패는 "yield"다.
 *   수리는 이 헬퍼 내부의 별도 트랜잭션(repairLegacyChildLink)에서 일어난다 — 호출자 트랜잭션
 *   안에서 ancestor 잠금을 잡지 않도록 "트랜잭션 진입 전"에 호출해야 한다.
 */
export async function repairWorkflowChildStartDiscovery(
  db: Db,
  runId: string,
): Promise<WorkflowChildStartWriteEntry> {
  const discovery = await discoverWorkflowChildStart(db, runId);
  if (discovery.kind === "plain" || discovery.kind === "missing") return { kind: "plain" };
  if (discovery.kind === "invalid-child") return { kind: "yield" };
  if (discovery.kind === "linked") return { kind: "proceed", identity: discovery.identity };
  // legacy — coherent claimed+nonnull. 공용 수리(잠금 하 CAS) 후 신선한 linked 신원으로 진행.
  const repaired = await repairLegacyChildLink(db, discovery.identity);
  if (repaired === "busy" || repaired === "ineligible") return { kind: "yield" };
  const rediscovered = await discoverWorkflowChildStart(db, runId);
  if (rediscovered.kind !== "linked") return { kind: "yield" };
  return { kind: "proceed", identity: rediscovered.identity };
}
