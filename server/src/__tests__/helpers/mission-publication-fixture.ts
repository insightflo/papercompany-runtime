import type { ArtifactContract } from "@paperclipai/shared";

export function publicationContract(role: ArtifactContract["role"], receipt = "receiptInput"): ArtifactContract {
  return {
    role, resultFileName: "result.json", resultSchemaVersion: "workflow.publication-result.v1",
    resultAdapter: "generic", inputParams: {}, deploymentFiles: ["runner.mjs"], inputEnvelopeVersion: "v1",
    ...(role === "publication-verify" ? { consumerParams: { receipt } } : {}),
    ...(role === "publication" ? { publication: {
      identity: { param: "id" }, publishedAt: { resultPointer: "/publishedAt", dateParam: "date", suffix: "T00:00:00Z" },
      bindings: [{ resultPointer: "/date", parameter: "date" }],
    } } : {}),
  };
}
export const publicationTools = [
  { name: "alpha", adapterConfig: { artifactContract: publicationContract("publication") } },
  { name: "beta", adapterConfig: { artifactContract: publicationContract("publication-verify") } },
];
export const publicationUnits = () => [
  { id: "p", type: "action", toolNames: ["alpha"], dependsOn: [], toolArgs: {} },
  { id: "v", type: "qa", toolNames: ["beta"], dependsOn: ["p"], toolArgs: {} },
];
