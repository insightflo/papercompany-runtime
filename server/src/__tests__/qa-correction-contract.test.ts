import { expect, it } from "vitest";
import {
  assertQaCorrectionEventLinks, hashQaCorrectionPayload, parseQaCorrectionEventPayload,
  qaCorrectionAppliedKey, qaCorrectionFollowupKey, qaCorrectionPreparationKey, qaCorrectionSourceMeasuredKey,
} from "../services/workflow/control-flow/qa-correction-contract.js";

// Oracle: document revision 9 and the compatibility addendum, not inferred server authority.
// These checks cover C02/C03 record connections and C12 supported input shapes; no DB or file IO.
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const A = "a".repeat(64), B = "b".repeat(64);
function fixture() {
  const producer = { stepRunId: id(5), stepId: "write", issueId: id(6), executionGeneration: 2, retryCount: 0, iterationIndex: 0 };
  const qa = { stepRunId: id(8), stepId: "qa", issueId: id(9), executionGeneration: 2, retryCount: 0, iterationIndex: 0 };
  const preparation = {
    schemaVersion: "workflow.qa-correction.prepare.v1", correctionId: id(1), companyId: id(2), missionId: id(3),
    workflowRunId: id(4), dispatchAuthorityVersion: 3, producer,
    authority: { kind: "workflow_qa" as const, verdicts: [{ eventId: id(10), heartbeatRunId: id(11), qa, remediationsHash: A }], toolEvidence: null },
    sources: [{ productId: id(7), provenance: { kind: "registered_legacy" as const } }],
    bindings: [{ bindingId: id(12), consumer: qa, referencedStepId: "write", expectedProductId: id(7) }],
    preparedAt: "2026-10-19T00:00:00.000Z",
  };
  const measured = {
    schemaVersion: "workflow.qa-correction.source-measured.v1", preparationEventId: id(1),
    preparationHash: hashQaCorrectionPayload(preparation), measuredAt: "2026-10-19T00:00:01.000Z",
    sources: [{ productId: id(7), files: [{ role: "main" as const, relativePath: "report.json", sha256: A, byteSize: 7 }] }],
  };
  const applied = {
    schemaVersion: "workflow.qa-correction.applied.v1", correctionId: id(1), preparationEventId: id(1),
    preparationHash: measured.preparationHash, sourceMeasuredEventId: id(13), sourceMeasuredHash: hashQaCorrectionPayload(measured),
    revisions: [{ revisionId: id(15), sourceProductId: id(7), workProductId: id(18), root: "/owned/correction",
      mainRelativePath: "report.json", files: [{ role: "main" as const, relativePath: "report.json", beforeSha256: A, sha256: B, byteSize: 9 }] }],
    bindingChanges: [{ bindingId: id(12), fromProductId: id(7), toProductId: id(18) }],
    qualityUseEvidenceRefId: null, followupEventIds: [id(16)], appliedAt: "2026-10-19T00:00:02.000Z",
  };
  const followup = {
    schemaVersion: "workflow.qa-correction.followup.v1", requestId: id(17), correctionId: id(1), appliedEventId: id(14),
    operation: "recheck" as const, target: { ...qa, retryCount: 1 }, dispatchAuthorityVersion: 3, revisionIds: [id(15)],
  };
  return { preparation, sourceMeasured: { eventId: id(13), payload: measured }, applied: { eventId: id(14), payload: applied },
    followups: [{ eventId: id(16), payload: followup }] };
}
type Fixture = ReturnType<typeof fixture>;
function events(c: Fixture): [string, unknown][] {
  return [["qa_correction_prepared", c.preparation], ["qa_correction_source_measured", c.sourceMeasured.payload],
    ["qa_remediation_applied", c.applied.payload], ["qa_correction_followup_requested", c.followups[0]!.payload]];
}
function set(value: unknown, path: string, replacement: unknown): void {
  const keys = path.split(".");
  let record = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) record = record[key] as Record<string, unknown>;
  record[keys[keys.length - 1]!] = replacement;
}
function workflowProducer() {
  return { schemaVersion: "workflow.work-product-producer.v1", companyId: id(2), missionId: id(3), workflowRunId: id(4),
    stepRunId: id(5), stepId: "write", executionGeneration: 2, retryCount: 0, iterationIndex: 0, heartbeatRunId: id(19) };
}
function withProvenance(provenance: unknown) {
  const p = fixture().preparation;
  return { ...p, sources: [{ productId: id(7), provenance }] };
}
function qualityPreparation() {
  const p = fixture().preparation;
  return { ...p, authority: { kind: "quality_current_output", verdicts: p.authority.verdicts,
    actionId: id(20), groupId: id(21), policyVersionId: id(22), intentKey: "repair-current-output",
    targetHash: A, effectHash: B, retryEnvelopeHash: A, reviewItemId: id(23), verifierRunId: id(24), verifierEpoch: 0,
    source: { companyId: id(2), issueId: id(6), heartbeatRunId: id(25), executionEpoch: 0, inputHash: A,
      mission: { kind: "mission", id: id(3) }, workflow: { kind: "workflow_step", runId: id(4), stepRunId: id(5), generation: 2, dispatchAuthorityVersion: 3 } },
  } };
}

it("C02/C03 accepts four complete versioned records and their explicit links", () => {
  const c = fixture();
  for (const [type, payload] of events(c)) expect(parseQaCorrectionEventPayload(type, payload)).toEqual(payload);
  expect(() => assertQaCorrectionEventLinks(c)).not.toThrow();
});
it("C12 preserves an unsealed legacy preparation without invented measurements or provenance", () => {
  const p = parseQaCorrectionEventPayload("qa_correction_prepared", fixture().preparation);
  expect(p.sources).toEqual([{ productId: id(7), provenance: { kind: "registered_legacy" } }]);
  expect("sha256" in p.sources[0]!).toBe(false);
});
it("rejects event/version mismatches, unknown event types and unknown fields for all four records", () => {
  const rows = events(fixture());
  rows.forEach(([type, payload], index) => {
    expect(() => parseQaCorrectionEventPayload(type, rows[(index + 1) % rows.length]![1])).toThrow();
    expect(() => parseQaCorrectionEventPayload(type, { ...(payload as object), schemaVersion: "workflow.qa-correction.prepare.v2" })).toThrow();
    expect(() => parseQaCorrectionEventPayload(type, { ...(payload as object), unexpected: true })).toThrow();
  });
  for (const type of ["toString", "__proto__", "qa_correction_storage_failed"]) {
    expect(() => parseQaCorrectionEventPayload(type, fixture().preparation)).toThrow();
  }
});
const invalidPreparationFields: [string, unknown][] = [
  ["companyId", "not-a-uuid"], ["producer.issueId", "missing"], ["producer.executionGeneration", -1],
  ["producer.retryCount", Number.MAX_SAFE_INTEGER + 1], ["producer.iterationIndex", 0.5], ["dispatchAuthorityVersion", -1],
  ["authority.verdicts.0.remediationsHash", "A".repeat(64)], ["authority.verdicts.0.heartbeatRunId", "missing"],
  ["producer.extra", true], ["authority.verdicts.0.extra", true], ["sources.0.provenance.extra", true],
  ["bindings.0.consumer.extra", true], ["bindings.0.expectedProductId", id(99)],
];
it.each(invalidPreparationFields)("rejects invalid preparation field %s", (path, value) => {
  const p = fixture().preparation;
  set(p, path, value);
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", p)).toThrow();
});
it("accepts zero and the safe integer boundary, but rejects invalid measured/applied/followup counters", () => {
  const p = fixture().preparation;
  p.producer.executionGeneration = Number.MAX_SAFE_INTEGER;
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", p)).not.toThrow();
  for (const bad of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
    const c = fixture();
    c.sourceMeasured.payload.sources[0]!.files[0]!.byteSize = bad;
    c.applied.payload.revisions[0]!.files[0]!.byteSize = bad;
    c.followups[0]!.payload.target.retryCount = bad;
    for (const [type, payload] of events(c).slice(1)) expect(() => parseQaCorrectionEventPayload(type, payload)).toThrow();
  }
});
it("C12 preserves identity-only and fully sealed workflow producers, and explicit prior corrections", () => {
  for (const producer of [workflowProducer(), { ...workflowProducer(), sha256: A, byteSize: 7 }]) {
    const provenance = { kind: "workflow_producer", workflowProducer: producer };
    expect(parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance(provenance)).sources[0]!.provenance).toEqual(provenance);
  }
  const prior = { kind: "prior_correction", appliedEventId: id(30) };
  expect(parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance(prior)).sources[0]!.provenance).toEqual(prior);
});
it("rejects partial or invalid producer proofs without a legacy fallback", () => {
  const badProducers = [{ ...workflowProducer(), sha256: A }, { ...workflowProducer(), byteSize: 7 },
    { ...workflowProducer(), sha256: "bad", byteSize: 7 }, { ...workflowProducer(), heartbeatRunId: "bad" },
    { ...workflowProducer(), retryCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...workflowProducer(), sha256: A, byteSize: Number.MAX_SAFE_INTEGER + 1 }];
  for (const producer of badProducers) {
    for (const kind of ["workflow_producer", "registered_legacy"]) {
      expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance({ kind, workflowProducer: producer }))).toThrow();
    }
  }
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance({ kind: "registered_legacy", workflowProducer: null }))).toThrow();
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance({ kind: "prior_correction", appliedEventId: "bad" }))).toThrow();
});
it("C12 uses the shared quality SourceAttempt without requiring tool QA hashes", () => {
  const p = qualityPreparation();
  const parsed = parseQaCorrectionEventPayload("qa_correction_prepared", p);
  expect(parsed.authority).toEqual(p.authority);
  expect("toolEvidence" in parsed.authority).toBe(false);
  for (const [path, value] of [["authority.source.executionEpoch", -1], ["authority.source.workflow.generation", Number.MAX_SAFE_INTEGER + 1],
    ["authority.source.extra", true], ["authority.verifierEpoch", -1], ["authority.toolEvidence", null]] as [string, unknown][]) {
    const bad = qualityPreparation();
    set(bad, path, value);
    expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", bad)).toThrow();
  }
  const tool = { ...fixture().preparation, authority: { ...fixture().preparation.authority,
    toolEvidence: { requestId: "tool:existing-request", executionGeneration: 2, contractHash: A, qaConfigHash: B } } };
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", tool)).not.toThrow();
});
it("hashes canonical JSON against a fixed SHA-256 vector and preserves correction order", () => {
  // SHA-256 of the literal UTF-8 JSON {"a":1,"b":2}; this expected value is not generated by the implementation.
  expect(hashQaCorrectionPayload({ b: 2, a: 1 })).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  expect(hashQaCorrectionPayload({ a: { y: 2, x: 1 }, b: 3 })).toBe(hashQaCorrectionPayload({ b: 3, a: { x: 1, y: 2 } }));
  // Two replacements of the same field have different final meanings when their order changes.
  const items = [{ path: "title", replacement: "Ready" }, { path: "title", replacement: "Done" }];
  expect(hashQaCorrectionPayload(items)).not.toBe(hashQaCorrectionPayload([...items].reverse()));
});
it("rejects non-JSON values instead of dropping or converting them, without invoking getters", () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  const bad: unknown[] = [undefined, { missing: undefined }, [undefined], NaN, Infinity, -Infinity, -0, 1n, Symbol("x"), () => 1,
    new Date("2026-10-19T00:00:00Z"), new Map(), new Array(1), cyclic, Object.create({ inherited: 1 }),
    Object.assign([1], { extra: 1 }), { [Symbol("hidden")]: 1 }, Object.defineProperty({}, "hidden", { value: 1 })];
  for (const value of bad) expect(() => hashQaCorrectionPayload(value)).toThrow();
  let reads = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { reads += 1; return 1; } });
  expect(() => hashQaCorrectionPayload(getter)).toThrow();
  expect(reads).toBe(0);
  const shared = { value: 1 };
  expect(hashQaCorrectionPayload([shared, shared])).toBe(hashQaCorrectionPayload([{ value: 1 }, { value: 1 }]));
  const optionalUndefined = { ...workflowProducer(), sha256: undefined, byteSize: undefined };
  expect(() => parseQaCorrectionEventPayload("qa_correction_prepared", withProvenance({ kind: "workflow_producer", workflowProducer: optionalUndefined }))).toThrow();
});
it("C03 separates preparation and measurement hashes and checks the sealed original against measurement", () => {
  const c = fixture();
  expect(c.applied.payload.preparationHash).not.toBe(c.applied.payload.sourceMeasuredHash);
  c.applied.payload.sourceMeasuredHash = c.applied.payload.preparationHash;
  expect(() => assertQaCorrectionEventLinks(c)).toThrow();
  const sealed = fixture();
  const preparation = withProvenance({ kind: "workflow_producer", workflowProducer: { ...workflowProducer(), sha256: A, byteSize: 7 } });
  const linked = { ...sealed, preparation };
  linked.sourceMeasured.payload.preparationHash = hashQaCorrectionPayload(preparation);
  linked.applied.payload.preparationHash = linked.sourceMeasured.payload.preparationHash;
  linked.applied.payload.sourceMeasuredHash = hashQaCorrectionPayload(linked.sourceMeasured.payload);
  expect(() => assertQaCorrectionEventLinks(linked)).not.toThrow();
  linked.sourceMeasured.payload.sources[0]!.files[0]!.byteSize = 8;
  linked.applied.payload.sourceMeasuredHash = hashQaCorrectionPayload(linked.sourceMeasured.payload);
  expect(() => assertQaCorrectionEventLinks(linked)).toThrow();
});
const brokenLinks: [string, (c: Fixture) => void][] = [
  ["preparation ID", c => { c.applied.payload.preparationEventId = id(99); }],
  ["correction ID", c => { c.applied.payload.correctionId = id(99); }],
  ["measurement ID", c => { c.applied.payload.sourceMeasuredEventId = id(99); }],
  ["binding destination", c => { c.applied.payload.bindingChanges[0]!.toProductId = id(99); }],
  ["original digest", c => { c.applied.payload.revisions[0]!.files[0]!.beforeSha256 = B; }],
  ["followup event ID", c => { c.followups[0]!.eventId = id(99); }],
  ["followup applied ID", c => { c.followups[0]!.payload.appliedEventId = id(99); }],
  ["followup revision ID", c => { c.followups[0]!.payload.revisionIds = [id(99)]; }],
  ["followup target ID", c => { c.followups[0]!.payload.target.stepRunId = id(99); }],
  ["followup authority version", c => { c.followups[0]!.payload.dispatchAuthorityVersion = 4; }],
];
it.each(brokenLinks)("C02/C03 rejects a mismatched %s", (_name, breakLink) => {
  const c = fixture(); breakLink(c);
  expect(() => assertQaCorrectionEventLinks(c)).toThrow();
});
it("rejects a measurement bound to a different preparation even with its updated content hash", () => {
  const c = fixture(); c.sourceMeasured.payload.preparationEventId = id(99);
  c.applied.payload.sourceMeasuredHash = hashQaCorrectionPayload(c.sourceMeasured.payload);
  expect(() => assertQaCorrectionEventLinks(c)).toThrow();
});
it("never treats write_failed as applied success or allows other followup operations", () => {
  expect(() => parseQaCorrectionEventPayload("qa_remediation_applied", { ...fixture().applied.payload, outcome: "write_failed" })).toThrow();
  for (const operation of ["recover", "close"]) {
    expect(() => parseQaCorrectionEventPayload("qa_correction_followup_requested", { ...fixture().followups[0]!.payload, operation })).toThrow();
  }
});
it("uses stable lifetime keys and different keys for different authorities and targets", () => {
  const p = fixture().preparation, target = fixture().followups[0]!.payload.target;
  expect(qaCorrectionPreparationKey(p)).toBe(qaCorrectionPreparationKey({ ...p, correctionId: id(99), preparedAt: "2026-10-19T00:00:03Z" }));
  expect(qaCorrectionPreparationKey(p)).not.toBe(qaCorrectionPreparationKey({ ...p, producer: { ...p.producer, retryCount: 1 } }));
  const differentAuthority = fixture().preparation; differentAuthority.authority.verdicts[0]!.remediationsHash = B;
  expect(qaCorrectionPreparationKey(p)).not.toBe(qaCorrectionPreparationKey(differentAuthority));
  expect(qaCorrectionSourceMeasuredKey(id(1))).toBe("qa-correction-source-measured:00000000-0000-4000-8000-000000000001");
  expect(qaCorrectionAppliedKey(id(1))).toBe("qa-correction-applied:00000000-0000-4000-8000-000000000001");
  expect(qaCorrectionFollowupKey(id(1), target)).toBe(qaCorrectionFollowupKey(id(1), { ...target }));
  expect(qaCorrectionFollowupKey(id(1), target)).not.toBe(qaCorrectionFollowupKey(id(1), { ...target, stepRunId: id(99) }));
  expect(() => qaCorrectionSourceMeasuredKey("bad")).toThrow();
  expect(() => qaCorrectionAppliedKey("bad")).toThrow();
  expect(() => qaCorrectionFollowupKey("bad", target)).toThrow();
});
