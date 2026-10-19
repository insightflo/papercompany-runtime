import path from "node:path";
import { chmod, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, missions, qualityActions, qualityActionGroups,
  qualityPolicyVersions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import * as artifactFiles from "../services/workflow/artifact-files.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { readIssuedQaCorrectionFollowup, observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup,
  readQaCorrectionFollowupDb, readQaCorrectionFollowupConsumption } from "../services/workflow/control-flow/qa-correction-followup.js";
import { qaCorrectionConsumptionSchema } from "../services/workflow/control-flow/qa-correction-contract.js";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { commitDbState, makeCommitSource, makeCommitPrior } from "./qa-correction-commit-fixture.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, issueC02, issueNextC02,
  storeC02ConsumptionInput, type C02Case } from "./helpers/c02-fixture.js";

// C02 rev39; C03/C12 preservation. Oracles: independent fixture bytes, original counters and peer SQL.
// Consumption cases below are reader INPUT validation, never stage13 writer/actual-QA evidence.
describe("C02 stage7 issued followup readers", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "c02-quality-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  const state = (c: C02Case) => commitDbState({ ...c.s, db: c.peer });
  const history = (c: C02Case) => readIssuedQaCorrectionFollowup(c.peer, c.ref, readIssuedQaCorrection);
  const observe = (c: C02Case) => observeQaCorrectionFollowup(c.peer, c.ref, readIssuedQaCorrection);
  async function current(c: C02Case, observation: Awaited<ReturnType<typeof observe>>) {
    return c.peer.transaction(tx => readCurrentQaCorrectionFollowup(tx, c.ref, observation, async (db, scope) => {
      expect(db === tx).toBe(true);
      return readIssuedQaCorrection(db, scope);
    }));
  }

  it("reads real committed B, original counters/producer and peer rows while the old QA request still names A", async () => {
    const c = await issueC02(owned), before = await state(c), selected = await history(c);
    const r = c.stored.revisions[0]!, expected = commitBuffers("html", "new");
    expect(selected.followupEventId).toBe(c.followupRow.id);
    expect(selected.followup).toEqual(c.followup);
    expect(selected.followup.target).toEqual({ stepRunId: c.s.f.qa.id, stepId: c.s.f.qa.stepId,
      issueId: c.s.f.qa.issueId, executionGeneration: c.s.f.qa.executionGeneration, retryCount: 1, iterationIndex: 2 });
    expect(selected.revisions[0]!.workflowProducer).toEqual(c.s.producer);
    expect(before.products.find(p => p.id === r.workProductId)?.status).toBe("active");
    expect(before.pins.find(b => b.id === c.s.f.bindingId)?.workProductId).toBe(r.workProductId);
    expect(before.events.filter(e => e.id === c.appliedRow.id || e.id === c.followupRow.id)).toHaveLength(2);
    expect(c.applied.revisions[0]!.files.map(({ beforeSha256: _, ...f }) => f).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath))).toEqual(commitFacts(expected).sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
    for (const [name, bytes] of expected) expect(await readFile(path.join(r.root, name))).toEqual(bytes);
    const [qa] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
    expect((qa!.metadata.toolArtifactRequest as typeof c.s.request).input.workProductId).toBe(c.s.productId);
    const observation = await observe(c);
    vi.spyOn(artifactFiles, "captureArtifactRoot").mockRejectedValue(Error("file IO inside DB recheck"));
    vi.spyOn(artifactFiles, "readArtifactBytes").mockRejectedValue(Error("file IO inside DB recheck"));
    expect((await current(c, observation)).revisions[0]!.revision.workProductId).toBe(r.workProductId);
    expect((await readQaCorrectionFollowupDb(c.peer, c.ref, readIssuedQaCorrection)).status).toBe("db_current_only");
    expect(await state(c)).toEqual(before);
  }, 20000);

  it.each(["company", "run", "request"] as const)("rejects a different reference: %s", async kind => {
    const c = await issueC02(owned, { mode: "content-only" }), ref = { ...c.ref };
    if (kind === "company") ref.companyId = c.s.f.otherCompanyId;
    if (kind === "run") ref.workflowRunId = randomUUID();
    if (kind === "request") ref.requestId = randomUUID();
    await expect(readIssuedQaCorrectionFollowup(c.peer, ref, readIssuedQaCorrection)).rejects.toThrow();
  }, 20000);

  it.each(["target", "applied", "key", "followup-link"] as const)("rejects forged stored linkage: %s", async kind => {
    const c = await issueC02(owned, { mode: "content-only" }), payload = structuredClone(c.followup);
    if (kind === "target") payload.target = c.s.p.producer;
    if (kind === "applied") payload.appliedEventId = randomUUID();
    if (kind === "followup-link") await c.peer.update(workflowTransitionEvents)
      .set({ payload: { ...c.applied, followupEventIds: [c.s.p.authority.verdicts[0]!.eventId] } })
      .where(eq(workflowTransitionEvents.id, c.appliedRow.id));
    else await c.peer.update(workflowTransitionEvents).set(kind === "key" ? { idempotencyKey: "forged" } : { payload })
      .where(eq(workflowTransitionEvents.id, c.followupRow.id));
    await expect(history(c)).rejects.toThrow();
  }, 20000);

  it("keeps B history and rechecks B after new PASS without requiring the old rejection to stay latest", async () => {
    const c = await issueC02(owned, { mode: "content-only" });
    await appendQaVerdict(c.peer, c.s.f, "pass");
    expect((await history(c)).followupEventId).toBe(c.followupRow.id);
    expect((await current(c, await observe(c))).followup.requestId).toBe(c.ref.requestId);
  }, 20000);

  it("keeps actual B→C history and original producer identity but refuses current B", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), token = await observe(b), c = await issueNextC02(b);
    expect((await history(b)).followup.requestId).toBe(b.ref.requestId);
    await expect(current(b, token)).rejects.toThrow();
    expect((await history(c)).revisions[0]!.workflowProducer).toEqual(b.s.producer);
    expect((await current(c, await observe(c))).revisions[0]!.revision.workProductId).toBe(c.stored.revisions[0]!.workProductId);
    expect(await readFile(path.join(c.stored.revisions[0]!.root, "report.html"))).toEqual(commitBuffers("content-only", "final").get("report.html"));
    expect((await state(c)).pins.find(p => p.id === b.s.f.bindingId)?.workProductId).toBe(c.stored.revisions[0]!.workProductId);
  }, 20000);

  it("keeps legacy proof absent instead of inventing a producer from current counters", async () => {
    const c = await issueC02(owned, { mode: "content-only", legacy: true });
    expect((await history(c)).revisions[0]!.workflowProducer).toBeNull();
    await c.peer.update(workflowStepRuns).set({ retryCount: 7, iterationIndex: 8 }).where(eq(workflowStepRuns.id, c.s.f.producer.id));
    expect((await history(c)).revisions[0]!.workflowProducer).toBeNull();
    await expect(readQaCorrectionFollowupDb(c.peer, c.ref, readIssuedQaCorrection)).rejects.toThrow();
  }, 20000);

  it.each(["run-cancel", "mission-cancel", "authority", "target", "hidden", "binding", "product"] as const)(
    "refuses a stale current read after observation: %s", async kind => {
      const c = await issueC02(owned, { mode: "content-only" }), token = await observe(c);
      if (kind === "run-cancel") await c.peer.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, c.ref.workflowRunId));
      if (kind === "mission-cancel") await c.peer.update(missions).set({ status: "cancelled" }).where(eq(missions.id, c.s.p.missionId));
      if (kind === "authority") await c.peer.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, c.ref.workflowRunId));
      if (kind === "target") await c.peer.update(workflowStepRuns).set({ retryCount: 2 }).where(eq(workflowStepRuns.id, c.s.f.qa.id));
      if (kind === "hidden") await c.peer.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, c.s.f.qa.issueId!));
      if (kind === "binding") await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId }).where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
      if (kind === "product") await c.peer.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, c.stored.revisions[0]!.workProductId));
      await expect(current(c, token)).rejects.toThrow();
      if (kind !== "binding") expect((await history(c)).followup.requestId).toBe(c.ref.requestId);
    }, 20000);

  it.each(["report.html", "assets/nested/pixel.svg", "source-notes.txt", "bundle-index.json"])(
    "rejects whole-manifest byte mutation while DB-only reads remain explicitly limited: %s", async name => {
      const c = await issueC02(owned), file = path.join(c.stored.revisions[0]!.root, name);
      await chmod(file, 0o600); await writeFile(file, Buffer.from("tampered"));
      expect((await readQaCorrectionFollowupDb(c.peer, c.ref, readIssuedQaCorrection)).status).toBe("db_current_only");
      await expect(observe(c)).rejects.toThrow();
    }, 20000);

  it("uses the already-issued last quality slot with zero new reservations, use rows or writes", async () => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), before = await state(c);
    expect(before.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(before.receipts.filter(r => r.qualityContract.kind === "use")).toHaveLength(1);
    expect(before.receipts.some(r => r.id === c.applied.qualityUseEvidenceRefId)).toBe(true);
    expect(before.usage.reduce((n, r) => n + r.executionAttempts, 0)).toBe(1);
    expect((await current(c, await observe(c))).status).toBe("rechecked_only");
    expect(await state(c)).toEqual(before);
  }, 20000);

  it.each(["cancel", "policy", "deadline", "cost"] as const)("rechecks current quality limits without allocating: %s", async kind => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), a = c.s.p.authority;
    if (a.kind !== "quality_current_output") throw Error("quality fixture required");
    if (kind === "cancel") await c.peer.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, a.actionId));
    if (kind === "policy") await c.peer.update(qualityPolicyVersions).set({ disabledAt: new Date() }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (kind === "deadline") await c.peer.update(qualityActionGroups).set({ deadlineAt: new Date() }).where(eq(qualityActionGroups.id, a.groupId));
    if (kind === "cost") {
      const [group] = await c.peer.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, a.groupId));
      await c.peer.update(qualityActionGroups).set({ usage: { ...group!.usage, chargedCostCents: 101 } }).where(eq(qualityActionGroups.id, a.groupId));
    }
    const before = await state(c);
    await expect(observe(c)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
  }, 20000);

  it("compares the observed binding lifetime again inside the caller transaction", async () => {
    const c = await issueC02(owned, { mode: "content-only" }), token = await observe(c);
    await c.peer.update(workflowStepOutputBindings).set({ resolvedAt: new Date(c.appliedRow.createdAt.getTime() + 1000) })
      .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
    expect((await readQaCorrectionFollowupDb(c.peer, c.ref, readIssuedQaCorrection)).status).toBe("db_current_only");
    await expect(current(c, token)).rejects.toThrow("observation");
    expect((await current(c, await observe(c))).status).toBe("rechecked_only");
  }, 20000);

  it("refuses forged observations and propagates read failures rather than granting permission", async () => {
    const c = await issueC02(owned, { mode: "content-only" });
    await expect(current(c, { ref: c.ref })).rejects.toThrow("observation");
    const token = await observe(c);
    await expect(readCurrentQaCorrectionFollowup(c.peer, c.ref, token, readIssuedQaCorrection)).rejects.toThrow("transaction");
    const error = Error("database unavailable");
    await expect(readQaCorrectionFollowupDb(c.peer, c.ref, async () => { throw error; })).rejects.toBe(error);
  }, 20000);

  it.each(["workflow_verdict", "tool_qa"] as const)("checks stored %s consumption INPUT, without claiming writer execution", async kind => {
    const c = await issueC02(owned, { mode: "content-only" });
    expect(await readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection)).toBeNull();
    const input = await storeC02ConsumptionInput(c, kind);
    if (input.heartbeatRunId) await c.peer.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.heartbeatRunId));
    vi.spyOn(artifactFiles, "captureArtifactRoot").mockRejectedValue(Error("DB relation must not read files"));
    vi.spyOn(artifactFiles, "readArtifactBytes").mockRejectedValue(Error("DB relation must not read files"));
    expect(await readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection)).toEqual({
      status: "db_consumption_relation_only", consumed: input.consumed, eventId: input.row.id });
    if (input.consumed.evidence.kind === "tool_qa") expect(input.consumed.evidence.requestId).toContain("tool-qa:opaque:");
  }, 20000);

  describe("C02 stage7R-B HTML ancillary consumption input", () => {
    it("accepts actual B with the independent research role and complete file facts", async () => {
      const c = await issueC02(owned), input = await storeC02ConsumptionInput(c, "tool_qa");
      const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
      const receipt = toolArtifactReceiptSchema.parse(step!.metadata.toolArtifactReceipt);
      const notes = commitFacts(commitBuffers("html", "new")).find(f => f.relativePath === "source-notes.txt")!;
      expect(c.applied.revisions[0]!.ancillaryRoleBindings).toEqual([{ role: "research", relativePath: "source-notes.txt" }]);
      expect(receipt.input.ancillaryManifest).toEqual([{ fileName: "research", sha256: notes.sha256, byteSize: notes.byteSize }]);
      const before = await state(c);
      vi.spyOn(artifactFiles, "captureArtifactRoot").mockRejectedValue(Error("DB relation must not read files"));
      vi.spyOn(artifactFiles, "readArtifactBytes").mockRejectedValue(Error("DB relation must not read files"));
      expect(await readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection)).toEqual({
        status: "db_consumption_relation_only", consumed: input.consumed, eventId: input.row.id });
      expect(await state(c)).toEqual(before);
    }, 20000);

    it.each(["omitted", "hash", "physical-name", "size", "extra", "duplicate"] as const)(
      "rejects matching request/receipt ancillary tampering: %s", async kind => {
        const c = await issueC02(owned);
        await storeC02ConsumptionInput(c, "tool_qa");
        const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
        const request = structuredClone(step!.metadata.toolArtifactRequest as typeof c.s.request);
        const receipt = toolArtifactReceiptSchema.parse(step!.metadata.toolArtifactReceipt);
        const ancillary = structuredClone(receipt.input.ancillaryManifest), first = ancillary?.[0];
        if (!ancillary || !first) throw Error("independent HTML ancillary input required");
        if (kind === "omitted") ancillary.length = 0;
        if (kind === "hash") first.sha256 = "ff".repeat(32);
        if (kind === "physical-name") first.fileName = "source-notes.txt";
        if (kind === "size") first.byteSize++;
        if (kind === "extra") ancillary.push({ ...first, fileName: "extra" });
        if (kind === "duplicate") ancillary.push({ ...first });
        request.input.ancillaryManifest = structuredClone(ancillary);
        receipt.input.ancillaryManifest = structuredClone(ancillary);
        expect(request.input).toEqual(receipt.input);
        expect(toolArtifactReceiptSchema.safeParse(receipt).success).toBe(true);
        await c.peer.update(workflowStepRuns).set({ metadata: { ...step!.metadata,
          toolArtifactRequest: request, toolArtifactReceipt: receipt } }).where(eq(workflowStepRuns.id, step!.id));
        await expect(readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection))
          .rejects.toThrow("qa_correction_followup_consumption");
      }, 20000);

    it.each(["tool_qa", "workflow_verdict"] as const)(
      "preserves explicit historical HTML input without roles, consumption=%s", async kind => {
        // Existing historical reader INPUT fixture, not a claim of successful issuance by the current writer.
        const s = await makeCommitPrior(await makeCommitSource(owned.db, owned.root, "html")), old = s.history;
        if (!old) throw Error("historical input required");
        const peer = owned.connect(), ref = { ...old.scope, requestId: old.followup.requestId };
        const [followupRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, old.followupId));
        if (!followupRow) throw Error("historical followup input required");
        const c = { s, peer, ref, followup: old.followup, followupRow, stored: { revisions: old.applied.revisions } };
        const before = await readIssuedQaCorrectionFollowup(peer, ref, readIssuedQaCorrection);
        expect(before.revisions[0]!.revision).not.toHaveProperty("ancillaryRoleBindings");
        expect(before.revisions[0]!.revision.bundleManifestRelativePath).toBe("bundle-index.json");
        const input = await storeC02ConsumptionInput(c, kind);
        const relation = readQaCorrectionFollowupConsumption(peer, ref, readIssuedQaCorrection);
        if (kind === "tool_qa") await expect(relation).rejects.toThrow("qa_correction_followup_consumption");
        else expect(await relation).toEqual({
          status: "db_consumption_relation_only", consumed: input.consumed, eventId: input.row.id });
        expect(await readIssuedQaCorrectionFollowup(peer, ref, readIssuedQaCorrection)).toEqual(before);
      }, 20000);
  });

  it.each(["workflow_verdict", "tool_qa"] as const)("rejects unrelated %s evidence despite a valid consumption schema", async kind => {
    const c = await issueC02(owned, { mode: "content-only" }), input = await storeC02ConsumptionInput(c, kind);
    const payload = structuredClone(input.consumed);
    if (payload.evidence.kind === "workflow_verdict") payload.evidence.eventId = c.s.p.authority.verdicts[0]!.eventId;
    else payload.evidence.requestId = "another:opaque:request";
    expect(qaCorrectionConsumptionSchema.safeParse(payload).success).toBe(true);
    await c.peer.update(workflowTransitionEvents).set({ payload }).where(eq(workflowTransitionEvents.id, input.row.id));
    await expect(readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection)).rejects.toThrow();
  }, 20000);

  it.each(["target", "revision", "event-type", "wake-link"] as const)("rejects forged consumption relationship: %s", async kind => {
    const c = await issueC02(owned, { mode: "content-only" }), input = await storeC02ConsumptionInput(c, "workflow_verdict");
    const payload = structuredClone(input.consumed);
    if (kind === "target") payload.followup.target.retryCount++;
    if (kind === "revision") payload.followup.revisionIds = [randomUUID()];
    if (kind === "wake-link") await c.peer.update(agentWakeupRequests).set({ payload: { qaCorrectionFollowup: {
      ...c.ref, requestId: randomUUID() } } }).where(eq(agentWakeupRequests.id, input.wakeupRequestId!));
    else await c.peer.update(workflowTransitionEvents).set(kind === "event-type" ? { eventType: "arbitrary_event" } : { payload })
      .where(eq(workflowTransitionEvents.id, input.row.id));
    await expect(readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection)).rejects.toThrow();
  }, 20000);
});
