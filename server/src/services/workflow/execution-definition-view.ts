import type { workflowDefinitions } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import type { loadExecutionDefinition } from "./execution-definition.js";

/**
 * [파일 목적] Task5a2a 순수 projection adapter. 캡처된 실행정의(loader 결과)를
 *   기존 DB workflowDefinitions 행 모양으로 투영한다. 검증기/정규화기/스냅샷 수리 없음 —
 *   로더가 이미 검증+정규화(1회)한 값을 그대로 투영할 뿐이다. 런타임 import 는 errors 뿐이다.
 * [계약] 입력을 절대 변형하지 않는다. legacy_current 는 원본 definition 행을 그대로 돌려주고
 *   (기존 current-name/mode 동작 유지), snapshot 은 복사본에 캡처 name/steps/mode 를 덮어쓴다.
 *   명시적 mode 가 모든 live heuristic 을 누른다. provenance 는 로더 타입상 nullable 이므로
 *   snapshot 분기에서 null guard 가 필요하다(로더에서 불가능하지만 공개 타입上是 유효 입력).
 */

export type LoadedExecutionDefinition = Awaited<ReturnType<typeof loadExecutionDefinition>>;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;

export function projectExecutionDefinition(
  definition: WorkflowDefinitionRow,
  execution: LoadedExecutionDefinition,
): WorkflowDefinitionRow {
  if (execution.source === "legacy_current") {
    return definition;
  }
  const provenance = execution.provenance;
  if (!provenance) {
    throw unprocessable("historical_definition_unproven", { reason: "missing_provenance" });
  }
  return {
    ...definition,
    name: provenance.workflowName,
    stepsJson: execution.steps,
    executionMode: execution.executionMode,
    dynamicPlanBootstrapOnly: execution.executionMode === "dynamic_owner_plan",
  };
}
