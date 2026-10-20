import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactRelativePathSchema, sourceAttemptSchema, workProductProducerSchema } from "@paperclipai/shared";

// C02/C03/C12: pure versioned records; parsing never proves server issuance or authority.
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().safe().nonnegative();
const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const unique = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(id => right.includes(id));

function invalidJson(): never { throw new Error("qa_correction_non_json"); }
function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number") {
      if (!Number.isFinite(input) || Object.is(input, -0)) return invalidJson();
      return JSON.stringify(input);
    }
    if (typeof input !== "object" || seen.has(input)) return invalidJson();
    if (Object.getOwnPropertySymbols(input).length) return invalidJson();
    seen.add(input);
    try {
      const names = Object.getOwnPropertyNames(input);
      const read = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalidJson();
        return descriptor.value;
      };
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || names.length !== input.length + 1) return invalidJson();
        return `[${Array.from({ length: input.length }, (_, index) => encode(read(String(index)))).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) return invalidJson();
      return `{${names.sort().map(key => `${JSON.stringify(key)}:${encode(read(key))}`).join(",")}}`;
    } finally { seen.delete(input); }
  }
  return encode(value);
}

export function hashQaCorrectionPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// Workflow step IDs and existing frozen tool request IDs are opaque strings, not DB UUIDs.
export const qaCorrectionAttemptSchema = z.object({
  stepRunId: uuid, stepId: text, issueId: uuid,
  executionGeneration: count, retryCount: count, iterationIndex: count,
}).strict();
export const qaCorrectionVerdictAuthoritySchema = z.object({
  eventId: uuid, heartbeatRunId: uuid, qa: qaCorrectionAttemptSchema, remediationsHash: sha256,
}).strict();
const producerSchema = workProductProducerSchema.refine(p =>
  [p.executionGeneration, p.retryCount, p.iterationIndex].every(Number.isSafeInteger)
  && (p.byteSize === undefined || Number.isSafeInteger(p.byteSize)), "qa_correction_unsafe_producer_count");
export const qaCorrectionSourceProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registered_legacy") }).strict(),
  z.object({ kind: z.literal("workflow_producer"), workflowProducer: producerSchema }).strict(),
  z.object({ kind: z.literal("prior_correction"), appliedEventId: uuid }).strict(),
]);
export const qaCorrectionAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow_qa"), verdicts: z.array(qaCorrectionVerdictAuthoritySchema).min(1),
    toolEvidence: z.object({ requestId: text, executionGeneration: count, contractHash: sha256, qaConfigHash: sha256 }).strict().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("quality_current_output"), verdicts: z.array(qaCorrectionVerdictAuthoritySchema).min(1),
    actionId: uuid, groupId: uuid, policyVersionId: uuid, intentKey: z.string().min(1).max(200),
    targetHash: sha256, effectHash: sha256, retryEnvelopeHash: sha256,
    source: sourceAttemptSchema, reviewItemId: uuid, verifierRunId: uuid, verifierEpoch: count,
  }).strict(),
]);
const sourceSchema = z.object({ productId: uuid, provenance: qaCorrectionSourceProvenanceSchema }).strict();
const bindingSchema = z.object({
  bindingId: uuid, consumer: qaCorrectionAttemptSchema, referencedStepId: text, expectedProductId: uuid,
}).strict();
export const qaCorrectionPreparationSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.prepare.v1"), correctionId: uuid,
  companyId: uuid, missionId: uuid, workflowRunId: uuid, dispatchAuthorityVersion: count,
  producer: qaCorrectionAttemptSchema, authority: qaCorrectionAuthoritySchema,
  sources: z.array(sourceSchema).min(1), bindings: z.array(bindingSchema), preparedAt: timestamp,
}).strict().refine(p => unique(p.sources, s => s.productId) && unique(p.bindings, b => b.bindingId)
  && unique(p.authority.verdicts, v => v.eventId)
  && p.bindings.every(b => p.sources.some(s => s.productId === b.expectedProductId)), "qa_correction_preparation_references");

const fileFields = { role: z.enum(["main", "asset", "ancillary"]), relativePath: artifactRelativePathSchema, sha256, byteSize: count };
const completeFiles = (files: readonly { relativePath: string; role: string }[]) =>
  unique(files, f => f.relativePath) && files.filter(f => f.role === "main").length === 1;
const measuredSourceSchema = z.object({
  productId: uuid, files: z.array(z.object(fileFields).strict()).min(1).refine(completeFiles, "qa_correction_file_manifest"),
}).strict();
export const qaCorrectionSourceMeasuredSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.source-measured.v1"),
  preparationEventId: uuid, preparationHash: sha256,
  sources: z.array(measuredSourceSchema).min(1), measuredAt: timestamp,
}).strict().refine(m => unique(m.sources, s => s.productId), "qa_correction_duplicate_source");
// Keep the HTML bundle role spelling; it is distinct from the physical artifact path.
const ancillaryRoleSchema = z.string().max(512).refine(s => s.split("/").every(p =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) && ![".", ".."].includes(p)));
const revisionSchema = z.object({
  revisionId: uuid, sourceProductId: uuid, workProductId: uuid, root: text, mainRelativePath: artifactRelativePathSchema,
  bundleManifestRelativePath: artifactRelativePathSchema.nullable().optional(),
  assetsRelativeRoot: artifactRelativePathSchema.nullable().optional(),
  ancillaryRoleBindings: z.array(z.object({ role: ancillaryRoleSchema,
    relativePath: artifactRelativePathSchema }).strict()).max(100).optional(),
  files: z.array(z.object({ ...fileFields, beforeSha256: sha256 }).strict()).min(1),
}).strict().refine(r => r.sourceProductId !== r.workProductId && completeFiles(r.files)
  && r.files.some(f => f.role === "main" && f.relativePath === r.mainRelativePath), "qa_correction_revision_manifest")
  .refine(r => typeof r.bundleManifestRelativePath !== "string"
    || r.files.some(f => f.role === "ancillary" && f.relativePath === r.bundleManifestRelativePath), "qa_correction_bundle_manifest")
  .refine(r => r.assetsRelativeRoot === undefined || r.files.every(f => f.role !== "asset"
    || (typeof r.assetsRelativeRoot === "string" && f.relativePath.startsWith(r.assetsRelativeRoot + "/"))), "qa_correction_assets_root")
  .refine(r => r.ancillaryRoleBindings === undefined || (unique(r.ancillaryRoleBindings, b => b.role)
    && unique(r.ancillaryRoleBindings, b => b.relativePath)
    && sameIds(r.ancillaryRoleBindings.map(b => b.relativePath), r.files.filter(f =>
      f.role === "ancillary" && f.relativePath !== r.bundleManifestRelativePath).map(f => f.relativePath))),
  "qa_correction_ancillary_role_bindings");
export const qaCorrectionAppliedSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.applied.v1"), correctionId: uuid,
  preparationEventId: uuid, preparationHash: sha256, sourceMeasuredEventId: uuid, sourceMeasuredHash: sha256,
  revisions: z.array(revisionSchema).min(1),
  bindingChanges: z.array(z.object({ bindingId: uuid, fromProductId: uuid, toProductId: uuid }).strict()),
  qualityUseEvidenceRefId: uuid.nullable(), followupEventIds: z.array(uuid).min(1), appliedAt: timestamp,
}).strict().refine(a => unique(a.revisions, r => r.revisionId) && unique(a.revisions, r => r.sourceProductId)
  && unique(a.revisions, r => r.workProductId) && unique(a.bindingChanges, b => b.bindingId)
  && unique(a.followupEventIds, id => id), "qa_correction_duplicate_application_reference");
export const qaCorrectionFollowupSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.followup.v1"), requestId: uuid, correctionId: uuid,
  appliedEventId: uuid, operation: z.literal("recheck"), target: qaCorrectionAttemptSchema,
  dispatchAuthorityVersion: count, revisionIds: z.array(uuid).min(1),
}).strict().refine(f => unique(f.revisionIds, id => id), "qa_correction_duplicate_revision");

export type QaCorrectionAttempt = z.infer<typeof qaCorrectionAttemptSchema>;
export type QaCorrectionVerdictAuthority = z.infer<typeof qaCorrectionVerdictAuthoritySchema>;
export type QaCorrectionSourceProvenance = z.infer<typeof qaCorrectionSourceProvenanceSchema>;
export type QaCorrectionAuthority = z.infer<typeof qaCorrectionAuthoritySchema>;
export type QaCorrectionPreparation = z.infer<typeof qaCorrectionPreparationSchema>;
export type QaCorrectionSourceMeasured = z.infer<typeof qaCorrectionSourceMeasuredSchema>;
export type QaCorrectionApplied = z.infer<typeof qaCorrectionAppliedSchema>;
export type QaCorrectionFollowup = z.infer<typeof qaCorrectionFollowupSchema>;

// C02: references identify records; only DB readers can prove delivery or consumption.
export const qaCorrectionFollowupRefSchema = z.object({
  companyId: uuid, workflowRunId: uuid, appliedEventId: uuid, requestId: uuid,
}).strict();
export const qaCorrectionDeliverySchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.delivery.v1"),
  ref: qaCorrectionFollowupRefSchema, followupEventId: uuid,
  wakeupRequestId: uuid, heartbeatRunId: uuid, deliveredAt: timestamp,
}).strict();
const workflowVerdictEvidenceSchema = z.object({
  kind: z.literal("workflow_verdict"), eventId: uuid, deliveryEventId: uuid,
}).strict();
const toolQaEvidenceFields = { kind: z.literal("tool_qa"), stepRunId: uuid, requestId: text, sha256 };
const consumptionFields = {
  ref: qaCorrectionFollowupRefSchema, followupEventId: uuid,
  followup: qaCorrectionFollowupSchema, consumedAt: timestamp,
};
// v1 remains readable for stored history; new tool evidence binds an immutable proof event.
export const qaCorrectionConsumptionSchema = z.discriminatedUnion("schemaVersion", [
  z.object({
    schemaVersion: z.literal("workflow.qa-correction.consumption.v1"), ...consumptionFields,
    evidence: z.discriminatedUnion("kind", [
      workflowVerdictEvidenceSchema, z.object(toolQaEvidenceFields).strict(),
    ]),
  }).strict(),
  z.object({
    schemaVersion: z.literal("workflow.qa-correction.consumption.v2"), ...consumptionFields,
    evidence: z.discriminatedUnion("kind", [
      workflowVerdictEvidenceSchema, z.object({ ...toolQaEvidenceFields, proofEventId: uuid }).strict(),
    ]),
  }).strict(),
]).refine(c => c.ref.requestId === c.followup.requestId
  && c.ref.appliedEventId === c.followup.appliedEventId, "qa_correction_consumption_reference");
export type QaCorrectionFollowupRef = z.infer<typeof qaCorrectionFollowupRefSchema>;
export type QaCorrectionDelivery = z.infer<typeof qaCorrectionDeliverySchema>;
export type QaCorrectionConsumption = z.infer<typeof qaCorrectionConsumptionSchema>;

// Existing (companyId, idempotencyKey) uniqueness owns one delivery/consumption per request.
export function qaCorrectionDeliveryKey(requestId: string): string {
  return "qa-correction-delivered:" + uuid.parse(requestId);
}
export function qaCorrectionConsumptionKey(requestId: string): string {
  return "qa-correction-consumed:" + uuid.parse(requestId);
}

const eventSchemas = {
  qa_correction_prepared: qaCorrectionPreparationSchema,
  qa_correction_source_measured: qaCorrectionSourceMeasuredSchema,
  qa_remediation_applied: qaCorrectionAppliedSchema,
  qa_correction_followup_requested: qaCorrectionFollowupSchema,
} as const;
export type QaCorrectionEventType = keyof typeof eventSchemas;
export type QaCorrectionEventPayload = z.infer<(typeof eventSchemas)[QaCorrectionEventType]>;
export function parseQaCorrectionEventPayload<T extends QaCorrectionEventType>(eventType: T, payload: unknown): z.infer<(typeof eventSchemas)[T]>;
export function parseQaCorrectionEventPayload(eventType: string, payload: unknown): QaCorrectionEventPayload;
export function parseQaCorrectionEventPayload(eventType: string, payload: unknown): QaCorrectionEventPayload {
  if (!Object.prototype.hasOwnProperty.call(eventSchemas, eventType)) throw new Error("qa_correction_event_type");
  canonicalJson(payload);
  return eventSchemas[eventType as QaCorrectionEventType].parse(payload);
}

// Lookup keys do not prove issuance. Existing rows must also match their frozen payloads.
// A preparation lifetime is independent of its newly allocated ID, timestamp and measured bytes.
export function qaCorrectionPreparationKey(value: unknown): string {
  const p = parseQaCorrectionEventPayload("qa_correction_prepared", value);
  return `qa-correction-prepared:${hashQaCorrectionPayload({ companyId: p.companyId, missionId: p.missionId,
    workflowRunId: p.workflowRunId, dispatchAuthorityVersion: p.dispatchAuthorityVersion, producer: p.producer, authority: p.authority })}`;
}
export function qaCorrectionSourceMeasuredKey(preparationEventId: string): string {
  return `qa-correction-source-measured:${uuid.parse(preparationEventId)}`;
}
export function qaCorrectionAppliedKey(correctionId: string): string {
  return `qa-correction-applied:${uuid.parse(correctionId)}`;
}
export function qaCorrectionFollowupKey(correctionId: string, target: QaCorrectionAttempt): string {
  canonicalJson(target);
  return `qa-correction-followup:${uuid.parse(correctionId)}:${qaCorrectionAttemptSchema.parse(target).stepRunId}`;
}

type EventRecord = { eventId: string; payload: unknown };
/** Compare supplied records only. DB ownership, issuance, currentness and historical authority need independent reads. */
export function assertQaCorrectionEventLinks(input: {
  preparation: unknown; sourceMeasured: EventRecord; applied: EventRecord; followups: readonly EventRecord[];
}): void {
  const p = parseQaCorrectionEventPayload("qa_correction_prepared", input.preparation);
  const m = parseQaCorrectionEventPayload("qa_correction_source_measured", input.sourceMeasured.payload);
  const a = parseQaCorrectionEventPayload("qa_remediation_applied", input.applied.payload);
  const measuredId = uuid.parse(input.sourceMeasured.eventId), appliedId = uuid.parse(input.applied.eventId);
  const followups = input.followups.map(event => ({ eventId: uuid.parse(event.eventId),
    payload: parseQaCorrectionEventPayload("qa_correction_followup_requested", event.payload) }));
  const check = (valid: boolean) => { if (!valid) throw new Error("qa_correction_link_mismatch"); };
  // Hash the original JSON records, including the existing shared contract's spelling, before any parser normalization.
  const preparationHash = hashQaCorrectionPayload(input.preparation);
  check(m.preparationEventId === p.correctionId && m.preparationHash === preparationHash);
  check(a.correctionId === p.correctionId && a.preparationEventId === p.correctionId && a.preparationHash === preparationHash);
  check(a.sourceMeasuredEventId === measuredId && a.sourceMeasuredHash === hashQaCorrectionPayload(input.sourceMeasured.payload));
  check(unique([p.correctionId, measuredId, appliedId, ...followups.map(f => f.eventId)], id => id));
  check(sameIds(p.sources.map(s => s.productId), m.sources.map(s => s.productId)));
  check(sameIds(p.sources.map(s => s.productId), a.revisions.map(r => r.sourceProductId)));
  for (const source of p.sources) {
    const measured = m.sources.find(s => s.productId === source.productId)!;
    const revision = a.revisions.find(r => r.sourceProductId === source.productId)!;
    check(!p.sources.some(s => s.productId === revision.workProductId));
    check(revision.files.length === measured.files.length);
    for (const file of measured.files) {
      check(revision.files.some(f => f.relativePath === file.relativePath && f.role === file.role && f.beforeSha256 === file.sha256));
    }
    const main = measured.files.find(f => f.role === "main")!;
    check(revision.mainRelativePath === main.relativePath);
    if (source.provenance.kind === "workflow_producer") {
      const producer = source.provenance.workflowProducer;
      if (producer.sha256 !== undefined) check(producer.sha256 === main.sha256 && producer.byteSize === main.byteSize);
    }
  }
  check(a.bindingChanges.length === p.bindings.length);
  for (const binding of p.bindings) {
    const revision = a.revisions.find(r => r.sourceProductId === binding.expectedProductId)!;
    check(a.bindingChanges.some(b => b.bindingId === binding.bindingId && b.fromProductId === binding.expectedProductId
      && b.toProductId === revision.workProductId));
  }
  check((p.authority.kind === "quality_current_output") === (a.qualityUseEvidenceRefId !== null));
  check(sameIds(a.followupEventIds, followups.map(f => f.eventId)));
  check(unique(followups, f => f.payload.requestId) && unique(followups, f => f.payload.target.stepRunId));
  const targets = [...p.authority.verdicts.map(v => v.qa), ...p.bindings.map(b => b.consumer)];
  for (const { payload: followup } of followups) {
    check(followup.correctionId === p.correctionId && followup.appliedEventId === appliedId);
    check(followup.dispatchAuthorityVersion === p.dispatchAuthorityVersion);
    check(followup.revisionIds.every(id => a.revisions.some(r => r.revisionId === id)));
    // A recheck may advance attempt counters; actual allowed progression belongs to the DB authority boundary.
    check(targets.some(t => t.stepRunId === followup.target.stepRunId && t.stepId === followup.target.stepId && t.issueId === followup.target.issueId));
  }
}
