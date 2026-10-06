import { and, eq } from "drizzle-orm";
import { workflowDefinitions, type Db } from "@paperclipai/db";
import { assertWorkflowToolStepsReady, type WorkflowStep } from "./dag-engine.js";
import { normalizeWorkflowStepsForExecution } from "./execution-steps.js";
import { assertWorkflowToolReferencesSelectable } from "./tool-catalog.js";
import { validateStructuralGateReadinessForSteps } from "./control-flow/structural-gate-readiness.js";
import { getStructuralTopologyErrors } from "./control-flow/structural-topology.js";

/**
 * [Q7 구현 단일화] engine.ts 의 private assertWorkflowToolReadiness 본체를 그대로 옮긴 것 —
 *   같은 순서(assertWorkflowToolStepsReady → assertWorkflowToolReferencesSelectable →
 *   구조 게이트 준비성 → 위상)·같은 오류 형식으로 create/update/trigger/resume 검사와
 *   시작 승인(생성) 시점 재검사가 하나의 구현을 공유한다.
 * agent-run-create 는 engine 을 역방향 import 할 수 없으므로(import 순환) 검사 본체가 이
 *   파일에 있고, 이 파일은 dag-engine/tool-catalog/control-flow 에만 의존한다(engine 미경유).
 */
export async function assertWorkflowToolReadinessForSteps(
  db: Db,
  input: { companyId: string; steps: WorkflowStep[] },
): Promise<void> {
  await assertWorkflowToolStepsReady({ companyId: input.companyId, steps: input.steps });
  await assertWorkflowToolReferencesSelectable(db, input);
  // [Hybrid QA] Structural gates fail closed at create/update/trigger/resume
  //   unless their single named tool is registered, enabled, declares the
  //   structural_validation_v1 capability, and the assignee has a grant.
  //   A plugin-only or unregistered name cannot bypass this. Ordinary tool/agent
  //   steps are unaffected (isStructuralGateStep skips them).
  const structuralErrors = await validateStructuralGateReadinessForSteps({ db, companyId: input.companyId, steps: input.steps });
  const topologyErrors = getStructuralTopologyErrors(input.steps);
  const allErrors = [...structuralErrors, ...topologyErrors];
  if (allErrors.length > 0) {
    throw new Error(`Structural gate validation failed: ${allErrors.join("; ")}`);
  }
}

/**
 * [Q7 생성 시점 재검사] 입장(admission) 트랜잭션 안에서 현재 정의 기준으로 도구 준비성을 다시 검사한다.
 *   승인 당시 통과했더라도 생성 순간에 도구 삭제·비활성화·담당 grant 철회·구조 게이트 위반이 있으면
 *   기존 engine 검사와 같은 오류로 거절한다. 정의 행이 없으면 여기서 새 오류를 만들지 않고 기존
 *   not-found 실패(captureExecutionDefinition 의 "Workflow definition not found")에 맡긴다.
 */
export async function assertWorkflowToolReadinessForDefinition(
  db: Db,
  input: { companyId: string; workflowId: string },
): Promise<void> {
  const [definition] = await db
    .select({ stepsJson: workflowDefinitions.stepsJson })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, input.workflowId), eq(workflowDefinitions.companyId, input.companyId)))
    .limit(1);
  if (!definition) return;
  await assertWorkflowToolReadinessForSteps(db, {
    companyId: input.companyId,
    steps: normalizeWorkflowStepsForExecution(definition.stepsJson),
  });
}
