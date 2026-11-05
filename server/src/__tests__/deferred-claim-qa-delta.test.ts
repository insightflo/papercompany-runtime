import { describe, expect, it } from "vitest";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { digest } from "../services/workflow/artifact-files.js";
import { admitClaimMetadataWithQaArtifactRequest } from "../services/workflow/deferred-claim-qa-delta.js";
import { legacyHtmlManualContract } from "./helpers/legacy-html-manual.js";

// Pure guard tests for the admissible deferred-release metadata delta: the only
// legitimate post-claim change is a NEW exact same-request toolArtifactRequest
// written by prepareQaArtifactRequest. Everything else must hold the claim.
// Producer, asset digests, and the correction followup ref are validated with
// the real exported schemas (workProductProducerSchema, assetDigestSchema,
// qaCorrectionFollowupRefSchema), so empty objects or null entries never pass.

const scope = {
  companyId: "1a0e5f0c-0000-4000-8000-000000000001",
  missionId: "1a0e5f0c-0000-4000-8000-000000000002",
  workflowRunId: "1a0e5f0c-0000-4000-8000-000000000003",
  stepId: "qa",
  stepRunId: "1a0e5f0c-0000-4000-8000-000000000004",
  executionGeneration: 2, retryCount: 0, iterationIndex: 0,
  requestId: "1a0e5f0c-0000-4000-8000-000000000003:qa:1",
};

const validProducer = {
  schemaVersion: "workflow.work-product-producer.v1",
  companyId: scope.companyId, missionId: scope.missionId,
  workflowRunId: scope.workflowRunId,
  stepRunId: "1a0e5f0c-0000-4000-8000-000000000005",
  stepId: "write", executionGeneration: 1, retryCount: 0, iterationIndex: 0,
  heartbeatRunId: "1a0e5f0c-0000-4000-8000-000000000006",
};

const validCorrectionRef = {
  companyId: scope.companyId, workflowRunId: scope.workflowRunId,
  appliedEventId: "1a0e5f0c-0000-4000-8000-000000000008",
  requestId: "1a0e5f0c-0000-4000-8000-000000000009",
};

function frozenAttempt() {
  const frozen = freezeArtifactAttempt({
    adapterConfig: {
      command: "node qa.mjs qa", workingDirectory: "/tmp/qa",
      artifactContract: legacyHtmlManualContract("qa.mjs"),
    },
    step: {
      id: "qa", name: "QA", type: "tool", agentId: "", dependencies: ["write"],
      toolNames: ["local-qa"],
      toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "write" },
    },
    executionGeneration: scope.executionGeneration, requestId: scope.requestId,
  });
  if (!frozen) throw new Error("frozen attempt fixture failed");
  return frozen;
}

function qaSnapshot(overrides: Record<string, unknown> = {}) {
  const root = { path: "/wp/missions/m/run/qa/attempts/2/abc", dev: 11, ino: 22 };
  return {
    artifactExecution: frozenAttempt(),
    companyId: scope.companyId, missionId: scope.missionId, workflowRunId: scope.workflowRunId,
    stepRunId: scope.stepRunId, stepId: scope.stepId,
    executionGeneration: scope.executionGeneration, retryCount: scope.retryCount,
    iterationIndex: scope.iterationIndex, requestId: scope.requestId,
    outputRoot: root.path,
    outputRootHash: digest(JSON.stringify({ path: root.path, dev: root.dev, ino: root.ino })),
    root, internalPathRoots: ["/wp", "/wp/missions", root.path],
    input: {
      workProductId: "1a0e5f0c-0000-4000-8000-000000000007",
      producer: validProducer,
      path: "/wp/missions/m/draft/content.json", sha256: digest("bytes"),
      byteSize: 5, assetsRoot: "/wp/missions/m/draft/assets",
      assetManifest: [{ fileName: "hero.png", sha256: digest("asset"), byteSize: 12 }],
    },
    ...overrides,
  };
}

function claimedMetadata() {
  return {
    artifactExecution: frozenAttempt(),
    toolQueue: { status: "claimed", claimedAt: "2026-10-30T11:38:32.482Z" },
    toolInvocation: {
      requestId: scope.requestId, toolName: "local-qa", args: {},
      dispatchedAt: "2026-10-30T11:38:32.482Z",
    },
  };
}

describe("deferred claim release QA metadata delta admission", () => {
  it("admits the only legitimate delta: a new exact same-request toolArtifactRequest", () => {
    const claimed = claimedMetadata();
    const current = { ...claimed, toolArtifactRequest: qaSnapshot() };
    expect(admitClaimMetadataWithQaArtifactRequest(current, claimed, scope)).toEqual(current);
  });

  it("admits a schema-valid correction followup ref on the snapshot", () => {
    const claimed = claimedMetadata();
    const current = { ...claimed, toolArtifactRequest: qaSnapshot({ qaCorrectionFollowup: validCorrectionRef }) };
    expect(admitClaimMetadataWithQaArtifactRequest(current, claimed, scope)).toEqual(current);
  });

  it("keeps admitting exact metadata equality and byte-identical retained requests", () => {
    const claimed = claimedMetadata();
    expect(admitClaimMetadataWithQaArtifactRequest(claimed, claimed, scope)).toEqual(claimed);
    const retained = { ...claimed, toolArtifactRequest: qaSnapshot() };
    expect(admitClaimMetadataWithQaArtifactRequest(retained, retained, scope)).toEqual(retained);
  });

  it("holds when an existing snapshot is replaced or removed", () => {
    const snapshot = qaSnapshot();
    const claimed = { ...claimedMetadata(), toolArtifactRequest: snapshot };
    const replacedRequest = { ...snapshot, requestId: `${scope.requestId}-other` };
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: replacedRequest }, claimed, scope)).toBeNull();
    const tamperedInput = { ...snapshot, input: { ...snapshot.input, byteSize: snapshot.input.byteSize + 1 } };
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: tamperedInput }, claimed, scope)).toBeNull();
    const { toolArtifactRequest: _removed, ...withoutRequest } = claimed;
    expect(admitClaimMetadataWithQaArtifactRequest(withoutRequest, claimed, scope)).toBeNull();
  });

  it("holds on any unrelated metadata drift", () => {
    const claimed = claimedMetadata();
    const withAddedKey = { ...claimed, toolArtifactRequest: qaSnapshot(), graphWorkProductRequired: true };
    expect(admitClaimMetadataWithQaArtifactRequest(withAddedKey, claimed, scope)).toBeNull();
    const withChangedQueue = {
      ...claimed, toolArtifactRequest: qaSnapshot(),
      toolQueue: { ...claimed.toolQueue, status: "settled" },
    };
    expect(admitClaimMetadataWithQaArtifactRequest(withChangedQueue, claimed, scope)).toBeNull();
    const withChangedArtifactExecution = {
      ...claimed, toolArtifactRequest: qaSnapshot(),
      artifactExecution: { ...claimed.artifactExecution, executionGeneration: 3 },
    };
    expect(admitClaimMetadataWithQaArtifactRequest(withChangedArtifactExecution, claimed, scope)).toBeNull();
  });

  it("holds on malformed or mismatched added snapshots", () => {
    const claimed = claimedMetadata();
    const cases: unknown[] = [
      "not-a-record",
      qaSnapshot({ requestId: `${scope.requestId}-forged` }),
      qaSnapshot({ missionId: "1a0e5f0c-0000-4000-8000-0000000099" }),
      qaSnapshot({ executionGeneration: scope.executionGeneration + 1 }),
      qaSnapshot({ stepRunId: "1a0e5f0c-0000-4000-8000-0000000099" }),
      qaSnapshot({ artifactExecution: { tampered: true } }),
      qaSnapshot({ outputRootHash: digest("wrong") }),
      qaSnapshot({ root: { path: "/other/path", dev: 11, ino: 22 } }),
      qaSnapshot({ root: { path: "/wp/missions/m/run/qa/attempts/2/abc", dev: "eleven", ino: 22 } }),
      qaSnapshot({ internalPathRoots: ["missions-relative"] }),
      qaSnapshot({ input: { ...qaSnapshot().input, sha256: "not-a-hash" } }),
      qaSnapshot({ input: { ...qaSnapshot().input, workProductId: "not-a-uuid" } }),
      qaSnapshot({ input: { ...qaSnapshot().input, producer: { ...validProducer, schemaVersion: "wrong.v0" } } }),
      qaSnapshot({ input: { ...qaSnapshot().input, producer: { ...validProducer, companyId: "1a0e5f0c-0000-4000-8000-0000000099" } } }),
      qaSnapshot({ input: { ...qaSnapshot().input, assetManifest: [{ ...qaSnapshot().input.assetManifest[0], byteSize: -1 }] } }),
      qaSnapshot({ input: { ...qaSnapshot().input, mode: "html" } }),
      { ...qaSnapshot(), unknownExtraKey: true },
    ];
    const { outputRootHash: _hash, root: _root, ...missingFields } = qaSnapshot();
    cases.push(missingFields);
    for (const toolArtifactRequest of cases) {
      expect(admitClaimMetadataWithQaArtifactRequest(
        { ...claimed, toolArtifactRequest }, claimed, scope)).toBeNull();
    }
  });

  it("regression: holds on an empty producer object instead of a real provenance record", () => {
    const claimed = claimedMetadata();
    const snapshot = qaSnapshot({ input: { ...qaSnapshot().input, producer: {} } });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: snapshot }, claimed, scope)).toBeNull();
  });

  it("regression: holds on empty internalPathRoots missing the snapshot root", () => {
    const claimed = claimedMetadata();
    const snapshot = qaSnapshot({ internalPathRoots: [] });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: snapshot }, claimed, scope)).toBeNull();
  });

  it("regression: holds on an empty qaCorrectionFollowup instead of a real ref", () => {
    const claimed = claimedMetadata();
    const snapshot = qaSnapshot({ qaCorrectionFollowup: {} });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: snapshot }, claimed, scope)).toBeNull();
    const wrongCompany = qaSnapshot({ qaCorrectionFollowup: { ...validCorrectionRef,
      companyId: "1a0e5f0c-0000-4000-8000-0000000099" } });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: wrongCompany }, claimed, scope)).toBeNull();
  });

  it("regression: holds on assetManifest entries that are not real asset digests", () => {
    const claimed = claimedMetadata();
    const nullEntry = qaSnapshot({ input: { ...qaSnapshot().input, assetManifest: [null] } });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: nullEntry }, claimed, scope)).toBeNull();
    const badDigest = qaSnapshot({ input: { ...qaSnapshot().input,
      assetManifest: [{ fileName: "hero.png", sha256: "not-a-hash", byteSize: 12 }] } });
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...claimed, toolArtifactRequest: badDigest }, claimed, scope)).toBeNull();
  });

  it("holds when the claim has no usable artifact authority or metadata is not a record", () => {
    const { artifactExecution: _frozen, ...withoutAuthority } = claimedMetadata();
    expect(admitClaimMetadataWithQaArtifactRequest(
      { ...withoutAuthority, toolArtifactRequest: qaSnapshot() }, withoutAuthority, scope)).toBeNull();
    expect(admitClaimMetadataWithQaArtifactRequest(null, claimedMetadata(), scope)).toBeNull();
    expect(admitClaimMetadataWithQaArtifactRequest({ ...claimedMetadata() }, "not-a-record", scope)).toBeNull();
  });
});
