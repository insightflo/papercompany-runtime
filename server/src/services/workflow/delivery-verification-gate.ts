// Delivery Verification Gate: 최종 공개/소비 목적지 실제 반영을 검증하는 게이트 step 주입.
// publish/deploy 완료만으로 PASS 금지. workProduct/delivery manifest 가 선언한 최종 경로를 readback 한다.

import type { WorkflowStep } from "./dag-engine.js";
import { buildVerificationBeforeCompletionCriteria } from "../missions/mission-quality-contract.js";
import { artifactContractSchema } from '@paperclipai/shared';

const DELIVERY_CRITERIA_MARKER = "Delivery Verification:";
export interface DeliveryPolicyStep {
  id: string; name?: string; description?: string; type?: string; qaType?: string;
  deliveryVerification?: unknown; capAcceptance?: unknown;
  /** Server-derived role in a frozen execution definition; independent of QA capability. */
  deliveryRole?: 'publication-verify';
  toolNames?: string[]; tools?: string[]; toolName?: string; toolArtifactContract?: unknown;
  dependencies?: string[];
}
export interface DeliveryPolicyTool { name: string; adapterConfig: Record<string, unknown> }

/** Tools must already be resolved inside the owning company; names select, never classify. */
export function hasSelectedArtifactRole(step: DeliveryPolicyStep, tools: readonly DeliveryPolicyTool[], role: 'publication' | 'publication-verify'): boolean {
  const names = step.toolNames ?? step.tools ?? (step.toolName ? [step.toolName] : []);
  return tools.some(tool => {
    if (!names.includes(tool.name)) return false;
    const parsed = artifactContractSchema.safeParse(tool.adapterConfig.artifactContract);
    return parsed.success && parsed.data.role === role;
  });
}
export function isDeliveryRelevantStep(step: DeliveryPolicyStep, tools: readonly DeliveryPolicyTool[] = []): boolean {
  return step.deliveryVerification === 'required' || hasSelectedArtifactRole(step, tools, 'publication');
}
export function isDeliveryReadbackStep(step: DeliveryPolicyStep, tools: readonly DeliveryPolicyTool[] = []): boolean {
  return step.qaType === 'delivery' || step.deliveryRole === 'publication-verify'
    || hasSelectedArtifactRole(step, tools, 'publication-verify');
}

// A downstream explicit readback prevents duplicate gate injection.
export function hasExistingDeliveryReadbackStep(
  steps: DeliveryPolicyStep[], tools: readonly DeliveryPolicyTool[] = [],
): boolean {
  const deliveryStepIds = new Set(steps.filter(step => isDeliveryRelevantStep(step, tools)).map((step) => step.id));
  return steps.some((step) => isDeliveryReadbackStep(step, tools) && isDownstreamOfDelivery(step, steps, deliveryStepIds));
}

function isDownstreamOfDelivery(
  step: { id: string; dependencies?: string[] },
  steps: Array<{ id: string; dependencies?: string[] }>,
  deliveryStepIds: ReadonlySet<string>,
): boolean {
  const stepsById = new Map(steps.map((candidate) => [candidate.id, candidate]));
  const pending = [...(step.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const dependencyId = pending.pop();
    if (!dependencyId || visited.has(dependencyId)) continue;
    if (deliveryStepIds.has(dependencyId)) return true;
    visited.add(dependencyId);
    pending.push(...(stepsById.get(dependencyId)?.dependencies ?? []));
  }
  return false;
}

export function appendDeliveryVerificationCriteria(description?: string): string {
  const criteria = buildDeliveryVerificationCriteria();
  const normalizedDescription = description?.trim() ?? "";
  if (!normalizedDescription) return criteria;
  if (normalizedDescription.includes(DELIVERY_CRITERIA_MARKER)) return normalizedDescription;
  return [normalizedDescription, "", criteria].join("\n");
}

export function strengthenDeliveryReadbackSteps(steps: WorkflowStep[], tools: readonly DeliveryPolicyTool[] = []): WorkflowStep[] {
  const deliveryStepIds = new Set(steps.filter(step => isDeliveryRelevantStep(step, tools)).map((step) => step.id));
  return steps.map((step) => {
    if (!isDeliveryReadbackStep(step, tools) || !isDownstreamOfDelivery(step, steps, deliveryStepIds)) return step;
    return {
      ...step,
      description: appendDeliveryVerificationCriteria(step.description),
    };
  });
}

// Delivery Verification Gate step 생성(dependencies = delivery/public destination step ids).
export function synthesizeDeliveryVerificationGateStep(input: {
  dependencyStepIds: string[];
  agentId: string;
  definitionName?: string;
}): WorkflowStep & { readonly qaType: "delivery" } {
  return {
    id: "delivery-verification-gate",
    name: "[Delivery Verification] Public destination readback",
    agentId: input.agentId,
    qaType: "delivery",
    dependencies: input.dependencyStepIds,
    graphWorkProductRequired: false,
    description: [
      "QA type: delivery",
      "Delivery Verification Gate. Verify the deliverable actually reached the final destination declared by the workflow output contract.",
      "Do NOT pass merely because the publish/deploy step completed, a workProduct was registered, or a local file exists.",
      "",
      buildVerificationBeforeCompletionCriteria(),
      "",
      buildDeliveryVerificationCriteria(),
      "",
      "Submit the official verdict via the Workflow API: `PASS` or `REQUEST_CHANGES` with `findings` — one entry (`id`, `summary`, `layer`) per blocking defect. A prose final line is not a submission.",
    ].join("\n"),
  };
}

// PAQO qaStep description 주입용 readback criteria.
export function buildDeliveryVerificationCriteria(): string {
  return [
    "Delivery Verification: the deliverable must be reachable at the final destination declared by the workProduct, delivery manifest, workflow step output contract, or mission success criteria.",
    "- Do not PASS merely because the publish/deploy step completed, a local file exists, a storage object exists, or a catalog row/index entry exists.",
    "- First identify the final consumer path: public URL, API endpoint, database record, object key, generated file path, repository location, or another explicit destination contract.",
    "- If the final destination contract is missing or ambiguous, REQUEST_CHANGES instead of guessing a provider such as Oracle, A1, R2, AWS, Cloudflare, or local filesystem.",
    "- For public HTTP artifacts: verify the final URL returns HTTP 200 or an expected canonical redirect, contains the expected title/topic/content marker, and is not stale.",
    "- For hub/index/catalog flows: verify the index entry and then follow it to the final detail/resource path. The index row alone is supporting evidence, not completion proof.",
    "- For storage-backed delivery: verify object/file existence, key/path, freshness/hash/size, and consumer accessibility when the consumer path is different from storage.",
    "- 404, missing link, stale page, empty content, wrong artifact, missing object, or adjacent-surface-only evidence => REQUEST_CHANGES.",
  ].join("\n");
}
