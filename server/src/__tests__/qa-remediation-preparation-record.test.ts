// server/src/__tests__/qa-remediation-preparation-record.test.ts
//
// Stage B1 correction — 순수 row-classifier/집계 계약 테스트(실제 기계 형태 행). DB/프로세스/회복 성공은
// 모의하지 않는다: 읽기·적용·완료 경로는 B2/B3 통합 소관이다. 여기는 계약 경계만 검증한다.

import { expect, it } from "vitest";
import path from "node:path";
import { hashContract } from "../services/quality/contract.js";
import { hashQaCorrectionPayload, type QaCorrectionAttempt } from "../services/workflow/control-flow/qa-correction-contract.js";
import { remediationIdempotencyKey } from "../services/workflow/control-flow/qa-remediation-contract.js";
import {
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, classifyQaRemediationLegacyRow, classifyQaRemediationPreparationRow, countQaRemediationReservations,
  qaRemediationPreparationKey, type QaRemediationEventRow, type QaRemediationPreparationScope,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash, type QaRemediationQualityBinding } from "../services/workflow/control-flow/qa-remediation-quality-binding.js";
import type { QaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { aggregateQaRemediationPreparationRead } from "../services/workflow/control-flow/qa-remediation-preparation-reader.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const A = "a".repeat(64), B = "b".repeat(64);
const ITEMS = [
  { op: "string_replace" as const, file: "/artifacts/report.md", find: "old title", replace: "new title" },
  { op: "string_replace" as const, file: "/artifacts/report.md", find: "second flaw", replace: "fixed" },
  { op: "string_replace" as const, file: "/artifacts/notes.txt", find: "x", replace: "y" },
];
const filesFor = (items: typeof ITEMS) => [...new Set(items.map((i) => path.resolve(i.file)))].map((file, n) => ({
  path: file, beforeSha256: n % 2 ? A : B, afterSha256: n % 2 ? B : A, beforeByteSize: 10, afterByteSize: 11,
}));

function attempts() {
  return {
    producer: { stepRunId: id(5), stepId: "write", issueId: id(6), executionGeneration: 1, retryCount: 0, iterationIndex: 2 },
    qa: { stepRunId: id(8), stepId: "qa", issueId: id(9), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
  };
}
function verdict(a: ReturnType<typeof attempts>, items = ITEMS, eventId = id(10), heartbeatRunId = id(11)) {
  return { eventId, heartbeatRunId, qa: a.qa, items, remediationsHash: hashQaCorrectionPayload(items) };
}
function preparationPayload(a: ReturnType<typeof attempts>, verdicts: ReturnType<typeof verdict>[], files = filesFor(ITEMS)) {
  return {
    schemaVersion: "workflow.qa-remediation.prepare.v2" as const, preparationId: id(1), companyId: id(2), missionId: id(3),
    workflowRunId: id(4), dispatchAuthorityVersion: 7, producer: a.producer, verdicts, files, preparedAt: "2026-10-30T07:00:00.000Z",
  };
}
function qualityPreparation(a: ReturnType<typeof attempts>, v: ReturnType<typeof verdict>) {
  const p = preparationPayload(a, [v]);
  const source = { companyId: id(2), issueId: id(6), heartbeatRunId: id(11), executionEpoch: 1, inputHash: A,
    mission: { kind: "mission" as const, id: id(3) }, workflow: { kind: "workflow_step" as const,
      runId: id(4), stepRunId: id(5), generation: 1, dispatchAuthorityVersion: 7 } };
  const qualityBinding: QaRemediationQualityBinding = {
    kind: "quality_current_output", actionId: id(12), groupId: id(13), policyVersionId: id(14), intentKey: "current-output",
    targetHash: A, effectHash: B, retryEnvelopeHash: A, source, sourceAttemptHash: hashContract(source),
    canonicalBinding: { companyId: id(2), actionId: id(12), missionId: id(3), workflowRunId: id(4), stepRunId: id(8), issueId: id(9) },
    reviewItemId: id(15), verifierRunId: id(11), verifierEpoch: 4,
    fileHashes: p.files.map((file) => ({ file: file.path, before: B, after: file.afterSha256 })),
    uploadedEvidence: { provider: "local_disk", objectKey: "quality/evidence.json", contentType: "application/json", byteSize: 128, sha256: A, originalFilename: "quality-evidence.json" },
    expiresAt: "2026-10-31T00:00:00.000Z",
  };
  return { ...p, schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, qualityBinding };
}
function prepRow(payload: QaRemediationPreparation): QaRemediationEventRow {
  return {
    id: payload.preparationId, companyId: payload.companyId, missionId: payload.missionId, workflowRunId: payload.workflowRunId,
    workflowStepRunId: payload.producer.stepRunId, issueId: payload.producer.issueId, heartbeatRunId: null,
    executionGeneration: payload.producer.executionGeneration, eventType: "qa_remediation_prepared", layer: "workflow_validation",
    decision: null, verdict: null, reason: null, reasonCode: null, idempotencyKey: qaRemediationPreparationKey(payload),
    payload: payload as unknown as Record<string, unknown>, createdAt: new Date("2026-10-30T07:00:00Z"),
  };
}
function legacyRow(a: ReturnType<typeof attempts>, items = ITEMS, outcome: "applied" | "write_failed" = "applied", sourceVerdictEventId = id(10), rowId = id(20)): QaRemediationEventRow {
  const payload = {
    kind: "qa_remediation_applied", outcome, producerStepId: a.producer.stepId, producerStepRunId: a.producer.stepRunId,
    producerIteration: a.producer.iterationIndex, qaStepId: a.qa.stepId, sourceVerdictEventId, appliedAt: "2026-10-30T06:59:00.000Z", items,
  };
  return {
    id: rowId, companyId: id(2), missionId: id(3), workflowRunId: id(4), workflowStepRunId: a.qa.stepRunId, issueId: a.qa.issueId,
    heartbeatRunId: id(11), executionGeneration: a.qa.executionGeneration, eventType: "qa_remediation_applied", layer: "workflow_validation",
    decision: outcome === "write_failed" ? "mechanical_remediation_write_failed" : "mechanical_remediation_applied",
    verdict: "request_changes", reason: "workflow_api", reasonCode: "qa_remediation",
    idempotencyKey: remediationIdempotencyKey(id(2), a.qa.stepRunId, sourceVerdictEventId),
    payload: payload as unknown as Record<string, unknown>, createdAt: new Date("2026-10-30T06:59:00Z"),
  };
}
function scope(a: ReturnType<typeof attempts>, verdicts: ReturnType<typeof verdict>[], qualityBinding?: QaRemediationPreparationScope["qualityBinding"]): QaRemediationPreparationScope {
  return {
    companyId: id(2), missionId: id(3), workflowRunId: id(4), dispatchAuthorityVersion: 7, producer: a.producer,
    verdicts: verdicts.map((v) => ({ eventId: v.eventId, heartbeatRunId: v.heartbeatRunId, qa: v.qa, remediationsHash: v.remediationsHash })),
    ...(qualityBinding ? { qualityBinding } : {}),
  };
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const invalidDetail = (row: QaRemediationEventRow, s: QaRemediationPreparationScope) => {
  const c = classifyQaRemediationPreparationRow(row, s);
  return c.kind === "invalid" ? c.detail : `expected invalid, got ${c.kind}`;
};

it("valid preparation classifies prepared; growth beyond 2MB after-size is legitimate", () => {
  const a = attempts(), v = verdict(a);
  const payload = preparationPayload(a, [v]);
  payload.files[0]!.afterByteSize = 5 * 1024 * 1024; // 정상적 증가 — after 크기에 2MB 상한 없음(원본 before 만 상한)
  const c = classifyQaRemediationPreparationRow(prepRow(payload), scope(a, [v]));
  expect(c).toMatchObject({ kind: "prepared", eventId: id(1) });
  if (c.kind !== "prepared") return;
  expect(c.preparation.verdicts[0]!.items).toEqual(ITEMS); // 원본 순서·문자열 보존
  expect(c.preparation.files.map((f) => f.path)).toEqual(["/artifacts/report.md", "/artifacts/notes.txt"]);
  expect(c.preparation.files.every((f) => f.beforeByteSize <= 2 * 1024 * 1024)).toBe(true);
});

it("v3 binds exact Quality identity, holds mismatches, keeps stale cycles and dedups history", () => {
  const a = attempts(), v = verdict(a), p = qualityPreparation(a, v), b = p.qualityBinding;
  const q = scope(a, [v], { actionId: b.actionId, bindingHash: qaRemediationQualityBindingHash(b) }), row = prepRow(p);
  expect(classifyQaRemediationPreparationRow(row, q)).toMatchObject({ kind: "prepared" });
  expect(classifyQaRemediationPreparationRow(prepRow(preparationPayload(a, [v])), q)).toMatchObject({ kind: "invalid", detail: "quality_binding_missing" });
  const missing: Record<string, unknown> = { ...p }; delete missing.qualityBinding;
  expect(classifyQaRemediationPreparationRow({ ...row, payload: missing }, q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: null } as unknown as typeof p), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: { ...b, actionId: id(99) } }), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: { ...b, sourceAttemptHash: B } }), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: { ...b, fileHashes: [] } }), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: { ...b, canonicalBinding: { ...b.canonicalBinding, stepRunId: id(99) } } }), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(prepRow({ ...p, qualityBinding: { ...b, fileHashes: b.fileHashes.map((file, i) => i ? file : { ...file, file: "/artifacts/other.md" }) } }), q)).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(row, scope(a, [v], { actionId: id(99), bindingHash: qaRemediationQualityBindingHash(b) }))).toMatchObject({ kind: "invalid" });
  expect(classifyQaRemediationPreparationRow(row, scope(a, [v], { actionId: b.actionId, bindingHash: A }))).toMatchObject({ kind: "invalid" });
  const prior = clone(p); prior.dispatchAuthorityVersion = 8; prior.qualityBinding.source.workflow.dispatchAuthorityVersion = 8;
  prior.qualityBinding.sourceAttemptHash = hashContract(prior.qualityBinding.source);
  expect(classifyQaRemediationPreparationRow(prepRow(prior), scope(a, [v]))).toMatchObject({ kind: "stale" });
  const matched = classifyQaRemediationPreparationRow(row, q), legacy = classifyQaRemediationLegacyRow(legacyRow(a), q);
  expect(countQaRemediationReservations([matched], [legacy], q).get(a.qa.stepRunId)).toBe(1);
});

it("non-normalized absolute item.file is accepted via resolve without rewriting item/hash", () => {
  const a = attempts();
  const payload = clone(preparationPayload(a, [verdict(a)]));
  payload.verdicts[0]!.items[0]!.file = "/artifacts/./report.md";
  payload.verdicts[0]!.remediationsHash = hashQaCorrectionPayload(payload.verdicts[0]!.items); // hash 는 원본 문자열 그대로 반영
  expect(classifyQaRemediationPreparationRow(prepRow(payload), scope(a, payload.verdicts))).toMatchObject({ kind: "prepared" });
  const relative = clone(preparationPayload(a, [verdict(a)]));
  relative.verdicts[0]!.items[0]!.file = "artifacts/report.md"; // 상대경로는 여전히 거부
  relative.verdicts[0]!.remediationsHash = hashQaCorrectionPayload(relative.verdicts[0]!.items);
  expect(invalidDetail(prepRow(relative), scope(a, [verdict(a)]))).toBe("payload");
});

it("well-formed foreign records classify stale — never absent and never invalid", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const foreign = (mutate: (p: ReturnType<typeof preparationPayload>, row: QaRemediationEventRow) => void) => {
    const p = clone(preparationPayload(a, [v])), row = prepRow(p);
    mutate(p, row);
    row.idempotencyKey = qaRemediationPreparationKey(p);
    return classifyQaRemediationPreparationRow(row, s);
  };
  expect(foreign((p, row) => { p.companyId = id(99); row.companyId = id(99); })).toMatchObject({ kind: "stale" });
  expect(foreign((p, row) => { p.workflowRunId = id(98); row.workflowRunId = id(98); })).toMatchObject({ kind: "stale" });
  expect(foreign((p, row) => { p.missionId = id(97); row.missionId = id(97); })).toMatchObject({ kind: "stale" });
  expect(foreign((p, row) => { p.producer.executionGeneration = 2; row.executionGeneration = 2; })).toMatchObject({ kind: "stale" });
  expect(foreign((p) => { p.dispatchAuthorityVersion = 8; })).toMatchObject({ kind: "stale" }); // 권한 버전 불일치 — 절대 prepared 아님
  const qaGen = scope({ ...a, qa: { ...a.qa, executionGeneration: 2 } as QaCorrectionAttempt }, [{ ...v, qa: { ...a.qa, executionGeneration: 2 } as QaCorrectionAttempt }]);
  expect(classifyQaRemediationPreparationRow(prepRow(preparationPayload(a, [v])), qaGen)).toMatchObject({ kind: "stale" });
});

it("malformed preparations classify invalid with explicit reasons", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const bad = (mutate: (p: ReturnType<typeof preparationPayload>) => void) => {
    const p = clone(preparationPayload(a, [v]));
    mutate(p);
    return invalidDetail(prepRow(p), s);
  };
  expect(bad((p) => { p.schemaVersion = "workflow.qa-remediation.prepare.v1"; })).toBe("payload");
  expect(bad((p) => { p.verdicts = []; })).toBe("payload");
  expect(bad((p) => { p.files = []; })).toBe("payload");
  expect(bad((p) => { p.verdicts[0]!.remediationsHash = A; })).toBe("payload");
  expect(bad((p) => { p.preparedAt = "not-a-timestamp"; })).toBe("payload");
  expect(bad((p) => { (p as unknown as Record<string, unknown>).qualityBinding = {}; })).toBe("payload"); // strict historical v2
  expect(bad((p) => { p.verdicts[0]!.items[0]!.file = 42 as unknown as string; })).toBe("payload"); // 문자열 강제 변환 없음
  expect(bad((p) => { p.files[0]!.beforeByteSize = 2 * 1024 * 1024 + 1; })).toBe("payload"); // 원본 before 2MB 상한 유지
  const keyTampered = prepRow(preparationPayload(a, [v]));
  expect(invalidDetail({ ...keyTampered, idempotencyKey: "other" }, s)).toBe("idempotency_key");
  expect(invalidDetail({ ...keyTampered, layer: "control" }, s)).toBe("layer");
  expect(invalidDetail({ ...keyTampered, id: id(50) }, s)).toBe("preparation_id");
  expect(invalidDetail({ ...keyTampered, workflowStepRunId: id(51) }, s)).toBe("row_producer");
});

it("duplicate or non-covering file/verdict references classify invalid", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const bad = (mutate: (p: ReturnType<typeof preparationPayload>) => void) => {
    const p = clone(preparationPayload(a, [v]));
    mutate(p);
    return invalidDetail(prepRow(p), s);
  };
  expect(bad((p) => { p.verdicts = [v, verdict(a, ITEMS, v.eventId)]; })).toBe("payload"); // duplicate verdict eventId
  expect(bad((p) => { p.verdicts = [v, verdict(a, ITEMS, id(12))]; })).toBe("payload"); // duplicate qa attempt
  expect(bad((p) => { p.files = [...p.files, { ...p.files[0]! }]; })).toBe("payload"); // duplicate file identity
  expect(bad((p) => { p.verdicts[0]!.items = [{ ...ITEMS[0]!, file: "/artifacts/unlisted.md" }]; p.verdicts[0]!.remediationsHash = hashQaCorrectionPayload(p.verdicts[0]!.items); })).toBe("payload"); // missing file reference
  expect(bad((p) => { p.files = [...p.files, { path: "/artifacts/extra.md", beforeSha256: A, afterSha256: B, beforeByteSize: 1, afterByteSize: 1 }]; })).toBe("payload"); // extra file identity
  expect(bad((p) => { p.files[0] = { ...p.files[0]!, path: "/artifacts/./report.md" }; })).toBe("payload"); // 식별자는 정규 표현만
});

it("legacy rows require the exact stored envelope; mismatched rows stay distinguishable", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const effect = classifyQaRemediationLegacyRow(legacyRow(a), s);
  expect(effect).toMatchObject({ kind: "legacy_effect", scoped: true });
  if (effect.kind === "legacy_effect") expect(effect.effect).toMatchObject({ outcome: "applied", sourceVerdictEventId: id(10), remediationsHash: hashQaCorrectionPayload(ITEMS) });
  expect(classifyQaRemediationLegacyRow(legacyRow(a, ITEMS, "write_failed"), s)).toMatchObject({ kind: "legacy_effect" });
  const thirdDecision = legacyRow(a, ITEMS, "write_failed");
  thirdDecision.decision = "mechanical_remediation_waiting"; // 제3의 값 — 불 일치 동치로는 잡히지 않는다
  expect(classifyQaRemediationLegacyRow(thirdDecision, s)).toMatchObject({ kind: "invalid" });
  const nullDecision = legacyRow(a);
  nullDecision.decision = null;
  expect(classifyQaRemediationLegacyRow(nullDecision, s)).toMatchObject({ kind: "invalid" });
  const wrongMission = legacyRow(a); wrongMission.missionId = id(96);
  expect(classifyQaRemediationLegacyRow(wrongMission, s)).toMatchObject({ kind: "stale", scoped: true }); // mission 은 분류기가 노출
  const wrongIssue = legacyRow(a); wrongIssue.issueId = id(32);
  expect(classifyQaRemediationLegacyRow(wrongIssue, s)).toMatchObject({ kind: "invalid" }); // 불가능 상태 = 파손
  const wrongQaStep = legacyRow(a); wrongQaStep.payload.qaStepId = "other-qa";
  expect(classifyQaRemediationLegacyRow(wrongQaStep, s)).toMatchObject({ kind: "invalid" });
  const wrongIteration = legacyRow(a); wrongIteration.payload.producerIteration = 9;
  expect(classifyQaRemediationLegacyRow(wrongIteration, s)).toMatchObject({ kind: "invalid" });
  const wrongHeartbeat = legacyRow(a); wrongHeartbeat.heartbeatRunId = id(31);
  expect(classifyQaRemediationLegacyRow(wrongHeartbeat, s)).toMatchObject({ kind: "stale" }); // 실행 봉투 불일치 = 이전 실행 증거
  const foreignVerdict = classifyQaRemediationLegacyRow(legacyRow(a, ITEMS, "applied", id(77)), s);
  expect(foreignVerdict).toMatchObject({ kind: "stale", scoped: true }); // 다른 verdict 소속 — absent 아님
  const foreignScopeRow = legacyRow(a);
  foreignScopeRow.companyId = id(99); foreignScopeRow.workflowRunId = id(99);
  foreignScopeRow.idempotencyKey = remediationIdempotencyKey(id(99), a.qa.stepRunId, id(10)); // 행 자체는 정합 — scope 만 외부
  expect(classifyQaRemediationLegacyRow(foreignScopeRow, s)).toMatchObject({ kind: "stale", scoped: false });
  const wrongKey = legacyRow(a);
  expect(classifyQaRemediationLegacyRow({ ...wrongKey, idempotencyKey: "other" }, s)).toMatchObject({ kind: "invalid" });
});

it("aggregate: relevant invalid or conflicting matches win over prepared with preparation null", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const good = prepRow(preparationPayload(a, [v]));
  expect(aggregateQaRemediationPreparationRead([good], [], s)).toMatchObject({ status: "prepared", preparationEventId: id(1) });
  const broken = { ...prepRow(preparationPayload(a, [v])), id: id(50), idempotencyKey: "bad" }; // 관련 invalid 행
  const combined = aggregateQaRemediationPreparationRead([good, broken], [], s);
  expect(combined.status).toBe("invalid");
  expect(combined.preparation).toBeNull();
  expect(combined.preparationEventId).toBeNull();
  expect(combined.invalidRows.length).toBe(1); // 오류가 prepared 안에 숨지 않는다
  const twin = clone(preparationPayload(a, [v])); twin.preparationId = id(30); // 같은 매칭 2건 — 충돌
  const conflict = aggregateQaRemediationPreparationRead([good, prepRow(twin)], [], s);
  expect(conflict.status).toBe("invalid");
  expect(conflict.preparation).toBeNull();
  expect(conflict.detail).toContain("conflicting");
  const foreignProducer = clone(preparationPayload(a, [v]));
  foreignProducer.producer = { ...a.producer, stepRunId: id(95) };
  expect(aggregateQaRemediationPreparationRead([prepRow(foreignProducer)], [], s).status).toBe("absent"); // 경계 밖 행은 배제 — 무관 분기 홀드 없음
  const legacyForeignStep = legacyRow(a); legacyForeignStep.workflowStepRunId = id(94);
  legacyForeignStep.idempotencyKey = remediationIdempotencyKey(id(2), id(94), id(10));
  expect(aggregateQaRemediationPreparationRead([], [legacyForeignStep], s).status).toBe("absent"); // 현재 QA step 밖 legacy 도 배제
  const priorCycle = clone(preparationPayload(a, [v])); priorCycle.dispatchAuthorityVersion = 8;
  const stale = aggregateQaRemediationPreparationRead([prepRow(priorCycle)], [], s);
  expect(stale.status).toBe("stale"); // 이전 사이클 증거 — absent 아님, 영구 차단 정책도 아님(B2 계속 판단)
  expect(stale.staleDetails.length).toBe(1);
});

it("reservation counting dedups only exact scope/producer/verdict/hash; invalid prevents nothing silently", () => {
  const a = attempts(), v = verdict(a), s = scope(a, [v]);
  const preparedRow = classifyQaRemediationPreparationRow(prepRow(preparationPayload(a, [v])), s);
  const matchedLegacy = classifyQaRemediationLegacyRow(legacyRow(a), s);
  expect(countQaRemediationReservations([preparedRow], [matchedLegacy], s).get(a.qa.stepRunId)).toBe(1); // 정확 대응 — 이중 계산 없음
  expect(countQaRemediationReservations([preparedRow], [], s).get(a.qa.stepRunId)).toBe(1); // 미완료 예약도 센다
  expect(countQaRemediationReservations([], [matchedLegacy], s).get(a.qa.stepRunId)).toBe(1);
  const otherProducerLegacy = legacyRow(a); otherProducerLegacy.payload.producerStepRunId = id(95);
  const otherProducerClass = classifyQaRemediationLegacyRow(otherProducerLegacy, s);
  expect(otherProducerClass).toMatchObject({ kind: "stale" }); // 다른 producer 시도의 같은 verdict+hash
  expect(countQaRemediationReservations([preparedRow], [otherProducerClass], s).get(a.qa.stepRunId)).toBe(2); // 별도 시도로 센다
  const oldPrepPayload = clone(preparationPayload(a, [v]));
  oldPrepPayload.producer = { ...a.producer, stepRunId: id(95) };
  oldPrepPayload.preparationId = id(40);
  const oldPrep = classifyQaRemediationPreparationRow(prepRow(oldPrepPayload), s);
  expect(oldPrep).toMatchObject({ kind: "stale" }); // 이전 producer iteration 예약 — 현재는 아니지만 여전히 상한 소모
  expect(countQaRemediationReservations([preparedRow, oldPrep], [], s).get(a.qa.stepRunId)).toBe(2); // QA stepRun 상한은 생산자 시도마다 리셋 아님 — 결코 1이 아니다
  expect(countQaRemediationReservations([oldPrep], [otherProducerClass], s).get(a.qa.stepRunId)).toBe(1); // 정확 대응(같은 producer tuple+verdict+hash)일 때만 이중 계산 제거
  const olderVerdictLegacy = classifyQaRemediationLegacyRow(legacyRow(a, ITEMS, "applied", id(66), id(21)), s);
  expect(countQaRemediationReservations([preparedRow], [matchedLegacy, olderVerdictLegacy], s).get(a.qa.stepRunId)).toBe(2);
  const invalidPrep = classifyQaRemediationPreparationRow({ ...prepRow(preparationPayload(a, [v])), idempotencyKey: "bad" }, s);
  expect(countQaRemediationReservations([invalidPrep], [], s).get(a.qa.stepRunId)).toBe(0); // 귀속 불명 — 숫자로 입장 열지 않고 상태(invalid)가 차단
  const foreignPayload = clone(preparationPayload(a, [v]));
  foreignPayload.companyId = id(99); foreignPayload.missionId = id(98); foreignPayload.workflowRunId = id(97);
  expect(countQaRemediationReservations([classifyQaRemediationPreparationRow(prepRow(foreignPayload), s)], [], s).get(a.qa.stepRunId)).toBe(0); // 외부 scope 예약 제외
});

// Native rework updates iterationIndex on the existing producer row; prior attempts still spend the QA cap.
it("keeps same-row older iterations in aggregate counts and dedups only the stored producer iteration", () => {
  const current = attempts(), v = verdict(current), s = scope(current, [v]);
  const old = { ...current, producer: { ...current.producer, iterationIndex: 1 } };
  const priorVerdict = verdict(old, ITEMS, id(66));
  const prior = preparationPayload(old, [priorVerdict]); prior.preparationId = id(40);
  const latest = prepRow(preparationPayload(current, [v]));
  const priorRow = prepRow(prior);
  expect(aggregateQaRemediationPreparationRead([priorRow, latest], [], s).reservationCounts.get(current.qa.stepRunId)).toBe(2);
  const exactLegacy = legacyRow(old, ITEMS, "applied", id(66));
  expect(aggregateQaRemediationPreparationRead([priorRow], [exactLegacy], s).reservationCounts.get(current.qa.stepRunId)).toBe(1);
  const differentIteration = legacyRow({ ...old, producer: { ...old.producer, iterationIndex: 0 } }, ITEMS, "applied", id(66));
  expect(aggregateQaRemediationPreparationRead([priorRow], [differentIteration], s).reservationCounts.get(current.qa.stepRunId)).toBe(2);
});
