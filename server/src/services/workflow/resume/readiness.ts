import type { Db } from "@paperclipai/db";
import { validateStructuralGateReadinessForSteps } from "../control-flow/structural-gate-readiness.js";
import { getStructuralTopologyErrors } from "../control-flow/structural-topology.js";

/**
 * [파일 목적] Task6b — dag-engine executeWorkflowRun 의 readiness 블록을 그대로 추출한다.
 *   tool 준비 콜백 + structural gate readiness/topology 검증을 resume 디스패처가 startedAt
 *   리셋 없이 재사용할 수 있게 dag-engine 밖으로 옮긴다.
 * [수정시 주의]
 *   - 이 파일은 dag-engine 을 import 하지 않는다(순환 방지). step 타입은 구조적 미러
 *     (ResumeReadinessStep)로 dag-engine WorkflowStep 과 상호 호환된다.
 *   - 검증 순서와 에러 문구는 기존 executeWorkflowRun 블록과 정확히 동일해야 한다:
 *     assertToolsReady 먼저, 그 다음 structural gate readiness + topology, 위반 시
 *     "Structural gate validation failed: ..." 단일 Error.
 *   - 여기서 run activation/startedAt 갱신을 하지 않는다. executeWorkflowRun 만이 시작
 *     트랜잭션을 유지하고, 새 resume 디스패처는 동일 readiness 를 재사용만 한다.
 *   - executeWorkflowRun 편의 래퍼(재실행 convenience)를 여기서 수출하지 않는다.
 */

/** dag-engine WorkflowStep 의 구조적 미러(필수 4필드 + readiness 검증이 읽는 선택 필드). */
export interface ResumeReadinessStep {
  id: string;
  name: string;
  agentId: string;
  dependencies: string[];
  title?: string;
  assigneeAgentId?: string;
  type?: string;
  qaType?: string;
  toolNames?: string[];
}

/** dag-engine assertWorkflowToolStepsReady 와 동일한 입력 시그니처의 tool 준비 콜백. */
export type AssertResumeToolsReady = (input: {
  companyId: string;
  steps: ResumeReadinessStep[];
}) => Promise<void>;

/**
 * [목적] resume/execute 공통 실행 readiness 단언. 전달된 assertToolsReady 를 먼저 호출하고,
 *   기존 structural gate readiness + topology 검증을 동일 순서로 수행한다.
 * [주의] 위반은 기존과 동일한 메시지의 Error. DB 쓰기 없음, startedAt 관여 없음.
 *   tool 콜백은 caller(dag-engine 은 기존 checker, resume 디스패처는 자체 checker)가 주입한다.
 */
export async function assertResumeExecutionReadiness(input: {
  db: Db;
  companyId: string;
  steps: ResumeReadinessStep[];
  assertToolsReady: AssertResumeToolsReady;
}): Promise<void> {
  await input.assertToolsReady({ companyId: input.companyId, steps: input.steps });
  // [Hybrid QA] Persisted runtime execution: a structural gate must fail closed
  //   here too (tool registered + enabled + structural_validation_v1 capability
  //   + assignee grant), even if the definition was inserted bypassing the engine
  //   create/update path. Ordinary tool/agent steps are unaffected.
  const structuralErrors = await validateStructuralGateReadinessForSteps({
    db: input.db,
    companyId: input.companyId,
    steps: input.steps,
  });
  const structuralTopologyErrors = getStructuralTopologyErrors(input.steps);
  const allStructuralErrors = [...structuralErrors, ...structuralTopologyErrors];
  if (allStructuralErrors.length > 0) {
    throw new Error(`Structural gate validation failed: ${allStructuralErrors.join("; ")}`);
  }
}
