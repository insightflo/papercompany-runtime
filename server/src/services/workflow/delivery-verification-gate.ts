// Delivery Verification Gate: 최종 공개/소비 목적지 실제 반영을 검증하는 게이트 step 주입.
// publish/deploy 완료만으로 PASS 금지. workProduct/delivery manifest 가 선언한 최종 경로를 readback 한다.

import type { WorkflowStep } from "./dag-engine.js";
import { buildVerificationBeforeCompletionCriteria } from "../missions/mission-quality-contract.js";

// delivery readback 이 필요한 공개 목적지 단서만 매치(generic publish/deploy 는 제외 — regression 방지).
const DELIVERY_KEYWORDS = /manual-onboarding|onboarding[- ]?hub|onboarding[- ]?publisher|r2|cloudflare|pages\.dev|public[- ]?hub|public[- ]?destination|final[- ]?public|website|site[- ]?html|회사게시|온보딩허브/iu;
// QA-like marker + public-destination marker 조합으로만 delivery-readback step 인식(둘 다 있어야).
const QA_LIKE_RE = /qa|verify|검증|확인|smoke|readback/iu;
const PUBLIC_MARKER_RE = /r2|cloudflare|hub|publish|onboarding|public|회사게시|온보딩|200|http/iu;
const READBACK_KEYWORDS = /delivery|readback|verify-publish|공개검증|public-destination|delivery-verification/iu;
const DELIVERY_CRITERIA_MARKER = "Delivery Verification:";

// step 이 delivery/publish 성격인지(publish 전 콘텐츠 QA 는 제외).
export function isDeliveryRelevantStep(step: { id: string; name: string; description?: string }): boolean {
  return DELIVERY_KEYWORDS.test(`${step.id} ${step.name} ${step.description ?? ""}`);
}

export function isDeliveryReadbackStep(step: { id: string; name: string; description?: string }): boolean {
  const text = `${step.id} ${step.name} ${step.description ?? ""}`;
  return READBACK_KEYWORDS.test(text) || (QA_LIKE_RE.test(text) && PUBLIC_MARKER_RE.test(text));
}

// 이미 delivery/readback 검증 step 있는지(duplicate 판정).
// QA-like(QA/verify/검증/확인/smoke/readback) + public-destination marker(R2/hub/Cloudflare/publish/onboarding/public)
// 둘 다 있어야 delivery-readback step 으로 인식. 단독 QA 나 단독 publish 는 제외.
export function hasExistingDeliveryReadbackStep(steps: Array<{ id: string; name: string; description?: string }>): boolean {
  return steps.some(isDeliveryReadbackStep);
}

export function appendDeliveryVerificationCriteria(description?: string): string {
  const criteria = buildDeliveryVerificationCriteria();
  const normalizedDescription = description?.trim() ?? "";
  if (!normalizedDescription) return criteria;
  if (normalizedDescription.includes(DELIVERY_CRITERIA_MARKER)) return normalizedDescription;
  return [normalizedDescription, "", criteria].join("\n");
}

export function strengthenDeliveryReadbackSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((step) => {
    if (!isDeliveryReadbackStep(step)) return step;
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
}): WorkflowStep {
  return {
    id: "delivery-verification-gate",
    name: "[Delivery Verification] Public destination readback",
    agentId: input.agentId,
    dependencies: input.dependencyStepIds,
    graphWorkProductRequired: false,
    description: [
      "Delivery Verification Gate. Verify the deliverable actually reached the final destination declared by the workflow output contract.",
      "Do NOT pass merely because the publish/deploy step completed, a workProduct was registered, or a local file exists.",
      "",
      buildVerificationBeforeCompletionCriteria(),
      "",
      buildDeliveryVerificationCriteria(),
      "",
      "Finish your run output with exactly one standalone final line: `PASS` or `REQUEST_CHANGES: <specific gaps>`.",
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
