import { publicationContract } from "./mission-publication-fixture.js";
import type { PlanningArtifactTool } from "../../services/missions/mission-plan-publication-contract.js";
import type { buildPaqoWorkflowSteps } from "../../services/mission-owner-plan-decisions.js";

export const artifactTools: PlanningArtifactTool[] = [
  { name: "neutral-review", adapterConfig: { artifactContract: publicationContract("qa") } },
  { name: "neutral-release", adapterConfig: { artifactContract: publicationContract("publication") } },
  { name: "neutral-readback", adapterConfig: { artifactContract: publicationContract("publication-verify") } },
];
export const paqoMission = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  ownerAgentId: "33333333-3333-4333-8333-333333333333",
  title: "Artifact pipeline",
} as Parameters<typeof buildPaqoWorkflowSteps>[1];

export function artifactUnits(): Record<string, unknown>[] {
  return [
    { id: "build", title: "Build", sourceStepId: "source-build", type: "action" },
    { id: "review", title: "Review", sourceStepId: "source-review", toolNames: ["neutral-review"],
      toolArgs: { content: "{$steps.source-build.workProductPath}" } },
    { id: "release", title: "Release", sourceStepId: "source-release", toolNames: ["neutral-release"],
      toolArgs: { qaResultPath: "{$steps.review.workProductPath}", content: "{$steps.build.workProductPath}" } },
    { id: "readback", title: "Read back", sourceStepId: "source-readback", toolNames: ["neutral-readback"],
      toolArgs: { receiptInput: "{$steps.release.workProductPath}" } },
  ];
}

export function paqoDraft(units: Record<string, unknown>[]) {
  return {
    missionGoal: "Verified artifact publication", successCriteria: [],
    refs: { selectedExecutionUnits: units },
    steps: units.map((unit, i) => ({ unitId: unit.id, dependencies: i ? [units[i - 1]!.id] : [] })),
  } as Parameters<typeof buildPaqoWorkflowSteps>[0];
}
