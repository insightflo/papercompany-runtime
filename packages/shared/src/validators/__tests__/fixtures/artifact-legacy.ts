// Literal historical producer shapes; neutral fixture, no external executable or host.
export const fixtureHash = "a".repeat(64);
export const fixtureId = "00000000-0000-4000-8000-000000000001";
export const legacyQaResult = {
  schemaVersion: "manual-onboarding.qa.v1", command: "qa", mode: "content", section: "sample",
  ok: true, checks: [{ id: "fixture", ok: true, detail: null }], checkedAt: "2026-01-01T00:00:00.000Z",
  artifactPath: "/fixture/qa-result.json", contentSha256: fixtureHash, assetManifest: [],
};
export const legacyReceipt = {
  schemaVersion: "workflow.tool-artifact.v1", role: "qa", companyId: fixtureId, missionId: fixtureId,
  workflowRunId: fixtureId, stepRunId: fixtureId, stepId: "check", executionGeneration: 1, retryCount: 0,
  iterationIndex: 0, requestId: "request", outputRoot: "/fixture", outputRootHash: fixtureHash,
  relativePath: "qa-result.json", resultSchema: "manual-onboarding.qa.v1", sha256: fixtureHash, byteSize: 1,
  toolId: fixtureId, toolName: "fixture", toolDeployment: [{ fileName: "tool.mjs", sha256: fixtureHash, byteSize: 1 }],
  input: { workProductId: fixtureId, producer: {
    schemaVersion: "workflow.work-product-producer.v1", companyId: fixtureId, missionId: fixtureId,
    workflowRunId: fixtureId, stepRunId: fixtureId, stepId: "write", executionGeneration: 1,
    retryCount: 0, iterationIndex: 0, heartbeatRunId: fixtureId,
  }, path: "/fixture/content.json", sha256: fixtureHash, byteSize: 1, assetsRoot: "/fixture/assets", assetManifest: [] },
};
