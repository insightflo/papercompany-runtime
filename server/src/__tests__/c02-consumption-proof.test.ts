import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { verifyQaArtifact } from "../services/workflow/qa-artifact-receipt.js";
import { qaCorrectionConsumptionSchema, qaCorrectionConsumptionKey } from "../services/workflow/control-flow/qa-correction-contract.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { readQaCorrectionFollowupConsumption } from "../services/workflow/control-flow/qa-correction-followup.js";
import { storeC02ConsumptionInput } from "./helpers/c02-fixture.js";
import { database, databaseConnectionString, fixture } from "./helpers/qa-receipt-fixture.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, currentConsumptionStep, issueC02,
  prepareConsumptionRequest, prepareSuccessorConsumption, seedConsumptionProof,
  writeConsumptionQaResult } from "./helpers/c02-consumption-fixture.js";

const tool = { id: "af9d3918-b6c9-4ddd-927f-0a783a22f487", name: "byte-qa-fixture" };
const deployment = [{ fileName: "qa.mjs", sha256: "cd".repeat(32), byteSize: 3 }];
describe("C02 consumption preparation (reader seeds are not atomic writer evidence)", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => { owned = await createCommitSourceHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  // The parent's frozen-receipt comparison selects ONLY this title substring (three cases).
  // Before: unrecognized_keys / qaCorrectionFollowup. After: a byte-bound v2 receipt.
  it.each(["html", "content", "content-only"] as const)(
    "C02 receipt boundary accepts issued %s QA bytes and preserves the stored correction ref", async mode => {
      const c = await issueC02(owned, { mode }), request = await prepareConsumptionRequest(c);
      const supplied = await writeConsumptionQaResult(c, request), before = structuredClone(request.snapshot);
      const [[primary], [peer]] = await Promise.all([
        owned.db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`,
        c.peer.$client<{ pid: number }[]>`select pg_backend_pid() as pid`,
      ]);
      expect(primary!.pid).not.toBe(peer!.pid);
      const { receipt, qa } = await verifyQaArtifact(request, tool, deployment);
      const main = commitFacts(commitBuffers(mode, "new")).find(file => file.role === "main")!;
      expect(receipt).toMatchObject({
        schemaVersion: "workflow.tool-artifact.v2", role: "qa",
        companyId: c.ref.companyId, missionId: c.s.p.missionId, workflowRunId: c.ref.workflowRunId,
        stepRunId: c.followup.target.stepRunId, stepId: c.followup.target.stepId,
        executionGeneration: c.followup.target.executionGeneration, retryCount: 1, iterationIndex: 2,
        requestId: request.snapshot.requestId, sha256: createHash("sha256").update(supplied.bytes).digest("hex"),
        byteSize: supplied.bytes.length, input: { workProductId: c.applied.revisions[0]!.workProductId,
          sha256: main.sha256, byteSize: main.byteSize, producer: c.s.producer },
      });
      expect(qa).toEqual(supplied.result);
      expect(receipt.input.assetManifest).toEqual(supplied.result.assetManifest);
      if (mode === "html") {
        const manifest = supplied.facts.find(file => file.relativePath === "bundle-index.json")!;
        expect(receipt.input.htmlManifest).toMatchObject({ sha256: manifest.sha256, byteSize: manifest.byteSize });
        expect(receipt.input.ancillaryManifest).toEqual(supplied.result.ancillaryManifest);
      }
      expect(receipt).not.toHaveProperty("qaCorrectionFollowup");
      expect(request.snapshot).toEqual(before);
      expect(request.snapshot.qaCorrectionFollowup).toEqual(c.ref);
      expect(request.snapshot.requestId).not.toBe(c.ref.requestId);
      expect((await currentConsumptionStep(c)).metadata.toolArtifactRequest).toEqual(before);
    }, 30000);

  it("keeps the ordinary real core executor path with an explicit external-QA producer double", async () => {
    expect(databaseConnectionString()).toBeTruthy();
    const f = await fixture(), result = await f.invoke();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.toolArtifactReceipt).toMatchObject({ schemaVersion: "workflow.tool-artifact.v2",
      role: "qa", companyId: f.companyId, workflowRunId: f.runId, stepRunId: f.qaId, requestId: f.requestId });
    const [step] = await database().select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
    expect(step!.metadata.toolArtifactRequest).not.toHaveProperty("qaCorrectionFollowup");
    // fixture.invoke uses executeCoreWorkflowTool; its child script replaces only the external producer.
    // This is not public tool completion or proof/consumption atomicity.
  }, 30000);

  it("strictly parses frozen proof input without granting issuance authority", async () => {
    const c = await issueC02(owned), request = await prepareConsumptionRequest(c);
    await writeConsumptionQaResult(c, request);
    const { receipt } = await verifyQaArtifact(request, tool, deployment);
    const seed = await seedConsumptionProof(c, request, receipt);
    // New exports must be loaded only in after-contract cases, never required by the before comparison.
    const api = await import("../services/workflow/qa-artifact-receipt.js");
    expect(api.parseQaCorrectionToolConsumptionProof(seed.proof)).toEqual(seed.proof);
    const { completedAt: omitted, ...missing } = seed.proof;
    expect(omitted).toBe(seed.completed.completedAt!.toISOString());
    const invalid = [
      missing, { ...seed.proof, extra: true },
      { ...seed.proof, statusTransitionVersion: -1 },
      { ...seed.proof, ref: { ...c.ref, requestId: randomUUID() } },
      { ...seed.proof, request: { ...seed.proof.request, requestId: "other-tool-request" } },
      { ...seed.proof, request: { ...seed.proof.request, artifactExecution: {
        ...seed.proof.request.artifactExecution, extra: true } } },
      { ...seed.proof, receipt: { ...seed.proof.receipt, requestId: "other-tool-request" } },
      { ...seed.proof, receipt: { ...seed.proof.receipt, schemaVersion: "workflow.tool-artifact.v1" } },
      { ...seed.proof, receipt: { ...seed.proof.receipt, role: "publication" } },
      { ...seed.proof, receipt: { ...seed.proof.receipt, contractHash: "00".repeat(32) } },
    ];
    for (const raw of invalid) expect(() => api.parseQaCorrectionToolConsumptionProof(raw)).toThrow();
    for (const field of ["ref", "request", "receipt"]) {
      const raw: Record<string, unknown> = { ...seed.proof };
      delete raw[field];
      expect(() => api.parseQaCorrectionToolConsumptionProof(raw)).toThrow();
    }
  }, 30000);

  it("rejects missing proof, wrong lookup and every foreign event-row identity", async () => {
    const c = await issueC02(owned), request = await prepareConsumptionRequest(c);
    await writeConsumptionQaResult(c, request);
    const { receipt } = await verifyQaArtifact(request, tool, deployment);
    const seed = await seedConsumptionProof(c, request, receipt);
    const api = await import("../services/workflow/qa-artifact-receipt.js");
    expect(await api.readQaCorrectionToolConsumptionProof(owned.db, seed.lookup)).toEqual({
      eventId: seed.row.id, proof: seed.proof });
    for (const lookup of [
      { ...seed.lookup, proofEventId: randomUUID() },
      { ...seed.lookup, requestId: c.ref.requestId },
      { ...seed.lookup, stepRunId: c.s.f.producer.id },
      { ...seed.lookup, sha256: "00".repeat(32) },
      { ...seed.lookup, ref: { ...c.ref, appliedEventId: randomUUID() } },
    ]) await expect(api.readQaCorrectionToolConsumptionProof(owned.db, lookup)).rejects.toThrow();
    const faults: Partial<typeof seed.row>[] = [
      { companyId: c.s.f.otherCompanyId }, { missionId: null }, { workflowRunId: null },
      { workflowStepRunId: c.s.f.producer.id }, { issueId: c.s.f.producer.issueId },
      { executionGeneration: seed.row.executionGeneration! + 1 },
      { eventType: "qa_correction_followup_consumed" }, { layer: "different-layer" },
      { idempotencyKey: "qa-correction-tool-proof:" + c.ref.requestId },
      { toStatus: "failed" }, { createdAt: new Date(seed.row.createdAt.getTime() + 1) },
      { heartbeatRunId: c.s.f.verdictHeartbeatId }, { wakeupRequestId: c.s.f.verdictWakeId },
    ];
    for (const fault of faults) {
      try {
        await c.peer.update(workflowTransitionEvents).set(fault).where(eq(workflowTransitionEvents.id, seed.row.id));
        await expect(api.readQaCorrectionToolConsumptionProof(owned.db, seed.lookup)).rejects.toThrow();
      } finally {
        await c.peer.update(workflowTransitionEvents).set(seed.row).where(eq(workflowTransitionEvents.id, seed.row.id));
      }
    }
    expect(await api.readQaCorrectionToolConsumptionProof(owned.db, seed.lookup)).toEqual({
      eventId: seed.row.id, proof: seed.proof });
  }, 60000);

  it("rejects well-shaped request/receipt copies that disagree with actual C03 issuance", async () => {
    const c = await issueC02(owned), request = await prepareConsumptionRequest(c);
    await writeConsumptionQaResult(c, request);
    const { receipt } = await verifyQaArtifact(request, tool, deployment);
    const seed = await seedConsumptionProof(c, request, receipt);
    const api = await import("../services/workflow/qa-artifact-receipt.js");
    const q = seed.proof.request, r = seed.proof.receipt;
    const unissuedRef = { ...c.ref, requestId: randomUUID() };
    const wrongInputs = [
      { ...r.input, workProductId: c.s.productId },
      { ...r.input, sha256: "00".repeat(32) },
      { ...r.input, path: c.s.file },
      { ...r.input, assetManifest: [] },
      { ...r.input, htmlManifest: { ...r.input.htmlManifest!, sha256: "00".repeat(32) } },
      { ...r.input, ancillaryManifest: [] },
      { ...r.input, producer: { ...r.input.producer, heartbeatRunId: c.s.f.verdictHeartbeatId } },
    ];
    const wrongProofs = [
      ...wrongInputs.map(input => ({ ...seed.proof, request: { ...q, input }, receipt: { ...r, input } })),
      { ...seed.proof, followupEventId: randomUUID() },
      { ...seed.proof, ref: unissuedRef, request: { ...q, qaCorrectionFollowup: unissuedRef } },
      { ...seed.proof, request: { ...q, retryCount: q.retryCount + 1 },
        receipt: { ...r, retryCount: r.retryCount + 1 } },
    ];
    for (const proof of wrongProofs) {
      // Both copies agree, so only an independent issued-record read can reject these counterexamples.
      expect(api.parseQaCorrectionToolConsumptionProof(proof)).toEqual(proof);
      try {
        await c.peer.update(workflowTransitionEvents).set({ payload: proof }).where(eq(workflowTransitionEvents.id, seed.row.id));
        await expect(api.readQaCorrectionToolConsumptionProof(owned.db, { ...seed.lookup, ref: proof.ref })).rejects.toThrow();
      } finally {
        await c.peer.update(workflowTransitionEvents).set({ payload: seed.proof }).where(eq(workflowTransitionEvents.id, seed.row.id));
      }
    }
  }, 60000);

  it("reads immutable B by event ID after actual C issuance replaces current request receipt and status", async () => {
    const b = await issueC02(owned), requestB = await prepareConsumptionRequest(b);
    await writeConsumptionQaResult(b, requestB);
    const verifiedB = await verifyQaArtifact(requestB, tool, deployment);
    const seed = await seedConsumptionProof(b, requestB, verifiedB.receipt);
    const api = await import("../services/workflow/qa-artifact-receipt.js");
    expect(seed.proof.statusTransitionVersion).toBe(seed.completed.statusTransitionVersion);
    expect(seed.proof.statusTransitionVersion).not.toBe(seed.row.finalizationVersion);
    const original = await api.readQaCorrectionToolConsumptionProof(owned.db, seed.lookup);
    const { c, request } = await prepareSuccessorConsumption(b);
    await writeConsumptionQaResult(c, request, "final");
    const verifiedC = await verifyQaArtifact(request, tool, deployment), current = await currentConsumptionStep(c);
    await c.peer.update(workflowStepRuns).set({ completedAt: null,
      metadata: { ...current.metadata, toolArtifactReceipt: verifiedC.receipt } }).where(eq(workflowStepRuns.id, current.id));
    const before = await currentConsumptionStep(c);
    expect(before.status).toBe("running");
    expect(before.metadata.toolArtifactRequest).toEqual(request.snapshot);
    expect(before.metadata.toolArtifactReceipt).toEqual(verifiedC.receipt);
    expect(request.snapshot.qaCorrectionFollowup).toEqual(c.ref);
    expect(c.ref.requestId).not.toBe(b.ref.requestId);
    expect(request.snapshot.requestId).not.toBe(requestB.snapshot.requestId);
    expect(request.snapshot.input.workProductId).toBe(c.applied.revisions[0]!.workProductId);
    expect(await api.readQaCorrectionToolConsumptionProof(owned.db, seed.lookup)).toEqual(original);
    expect(await currentConsumptionStep(c)).toEqual(before);
    const [stored] = await c.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, seed.row.id));
    expect(stored).toEqual(seed.row);
  }, 60000);

  it.each(["tool_qa", "workflow_verdict"] as const)(
    "retains stored consumption v1 and requires proofEventId only for v2 tool evidence (%s)", async kind => {
      const c = await issueC02(owned), seed = await storeC02ConsumptionInput(c, kind);
      expect(seed.consumed.schemaVersion).toBe("workflow.qa-correction.consumption.v1");
      expect(qaCorrectionConsumptionSchema.parse(seed.row.payload)).toEqual(seed.consumed);
      expect((await readQaCorrectionFollowupConsumption(owned.db, c.ref, readIssuedQaCorrection))?.eventId).toBe(seed.row.id);
      expect(seed.row.idempotencyKey).toBe(qaCorrectionConsumptionKey(c.ref.requestId));
      const v2 = { ...seed.consumed, schemaVersion: "workflow.qa-correction.consumption.v2" };
      if (kind === "tool_qa") {
        expect(qaCorrectionConsumptionSchema.safeParse(v2).success).toBe(false);
        expect(qaCorrectionConsumptionSchema.parse({ ...v2,
          evidence: { ...seed.consumed.evidence, proofEventId: randomUUID() } })).toMatchObject({
          schemaVersion: "workflow.qa-correction.consumption.v2", evidence: { kind: "tool_qa" } });
      } else expect(qaCorrectionConsumptionSchema.parse(v2).evidence).toEqual(seed.consumed.evidence);
      // storeC02ConsumptionInput proves stored v1 reading only, never a completed stage13 writer.
    }, 30000);
});
