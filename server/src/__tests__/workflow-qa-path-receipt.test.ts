import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { captureArtifactRoot, digest } from "../services/workflow/artifact-files.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { verifyQaArtifact } from "../services/workflow/qa-artifact-receipt.js";

// A valid plugin result cannot bypass runtime-owned path inspection of captured input bytes.
it.each(["attempt", "captured", "none"])("receipt verification checks runtime roots even with valid plugin digests (leak=%s)", async leak => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-path-receipt-")));
  try {
    await mkdir(path.join(dir, "input"));
    const capturedRoot = `/synthetic-output-${randomUUID()}`;
    const text = leak === "attempt" ? path.join(dir, "private.txt") : leak === "captured" ? `${capturedRoot}/private.txt`
      : "Install ~/.x/y or /Users/username/.local/bin/uv";
    const source = Buffer.from(JSON.stringify({ text }));
    await writeFile(path.join(dir, "input", "content.json"), source);
    const contract = { role: "qa" as const, resultAdapter: "generic" as const, resultSchemaVersion: "workflow.qa-result.v1",
      resultFileName: "inspection.json", inputParams: {}, deploymentFiles: ["inspect.mjs"], inputEnvelopeVersion: "input.v1" };
    await writeFile(path.join(dir, contract.resultFileName), JSON.stringify({ schemaVersion: contract.resultSchemaVersion,
      ok: true, checks: [{ id: "plugin", ok: true }], inputDigest: { sha256: digest(source) }, assetManifest: [] }));
    const companyId = randomUUID(), missionId = randomUUID(), workflowRunId = randomUUID(), stepRunId = randomUUID();
    const snapshot = { root: await captureArtifactRoot(dir), outputRoot: dir, outputRootHash: "a".repeat(64),
      ...(leak !== "attempt" ? { internalPathRoots: [capturedRoot] } : {}),
      companyId, missionId, workflowRunId, stepRunId, stepId: "inspect", executionGeneration: 0, retryCount: 0, iterationIndex: 0,
      requestId: "request", artifactExecution: freezeArtifactAttempt({ adapterConfig: { artifactContract: contract },
        step: {}, executionGeneration: 0, requestId: "request" }),
      input: { workProductId: randomUUID(), path: path.join(dir, "content.json"), sha256: digest(source), byteSize: source.length,
        assetsRoot: "", assetManifest: [], producer: { schemaVersion: "workflow.work-product-producer.v1" as const,
          companyId, missionId, workflowRunId, stepRunId, stepId: "write", executionGeneration: 0, retryCount: 0,
          iterationIndex: 0, heartbeatRunId: randomUUID() } } };
    const verify = verifyQaArtifact({ snapshot }, { id: randomUUID(), name: "inspect" },
      [{ fileName: "inspect.mjs", sha256: "b".repeat(64), byteSize: 1 }]);
    if (leak !== "none") await expect(verify).rejects.toThrow("qa_artifact_runtime_checks_failed:no-sensitive-data");
    else {
      const { receipt } = await verify;
      expect(receipt.runtimeChecks).toContainEqual({ id: "no-sensitive-data", ok: true, severity: "error" });
      expect(receipt).not.toHaveProperty("internalPathRoots");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
