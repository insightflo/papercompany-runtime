/**
 * [파일 목적] LOCAL SKETCH receipt parser + 고정 라벨 에러/필드 헬퍼 + 로컬 주입 선행
 *   증거(predecessors) 검증/hydration. production 아님 — 합성 공급값만 다룬다.
 * [수정시 주의]
 *   - 거절은 항상 하나의 고정 code 라벨이다. 입력 값 유출/자연어 판단 금지.
 *   - 선행 증거는 production 신뢰/이력 주장이 아니라 테스트가 공급한 합성 문서다.
 *   - scope 비교는 새 증거 문서의 소유 바인딩에 필요한 최소 범위다(보안 일반화 금지).
 */

import { createHash } from "node:crypto";
import {
  LOCAL_SKETCH_MODE, LOCAL_SKETCH_PREDECESSORS_SCHEMA, LOCAL_SKETCH_RECEIPT_SCHEMA,
  type LocalSketchAssembly, type LocalSketchPredecessorEvidence, type LocalSketchReceipt,
  type LocalSketchScope,
} from "./local-sketch-types.js";

/** 고정 code 라벨만 담는다 — 입력 값 유출 금지. */
export class LocalSketchRejectedError extends Error {}

export type FieldSpec = Record<string, "text" | "figure" | "object">;
const RECEIPT_KEYS = ["schema", "mode", "scope", "claim_id", "clips", "credits"];
export const SCOPE_SPECS: FieldSpec = {
  job_id: "text", company_id: "text", mission_id: "text", workflow_run_id: "text", step_run_id: "text",
  step_id: "text", issue_id: "text", execution_generation: "figure", attempt: "figure", spec_sha256: "text",
};
const CLIP_SPECS: FieldSpec = {
  frame: "figure", path: "text", source_object: "text", file_sha256: "text",
  stored_object: "text", stored_sha256: "text",
};
const CREDIT_SPECS: FieldSpec = { event_id: "text", amount: "figure", evidence_record: "text" };
export const BINDING_SPECS: FieldSpec = { video_sha256: "text", channel_id: "text", metadata: "object" };
export const METADATA_SPECS: FieldSpec = { video_title: "text", video_description: "text", privacy: "text" };

export function fail(code: string): never {
  throw new LocalSketchRejectedError(code);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : fail("invalid:receipt");
}
function figure(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail("invalid:receipt");
}
/** 정확 키 집합 + 필드별 primitive type 검증 — 거절은 항상 하나의 고정 라벨. */
export function pickObject<T extends object>(value: unknown, specs: FieldSpec, field: string): T {
  if (!isObject(value)) fail(`invalid:receipt.${field}`);
  const keys = Object.keys(value);
  const expected = Object.keys(specs);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    fail(`invalid:receipt.${field}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(specs)) {
    if (kind === "object" && !isObject(value[key])) fail(`invalid:receipt.${field}`);
    out[key] = kind === "text" ? text(value[key]) : kind === "figure" ? figure(value[key]) : value[key];
  }
  return out as T;
}
export function toolText(result: Record<string, unknown>, field: string): string {
  const value = result[field];
  return typeof value === "string" && value !== "" ? value : fail(`tool_field_missing:${field}`);
}
export function toolFigure(result: Record<string, unknown>, field: string): number {
  const value = result[field];
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`tool_field_missing:${field}`);
}
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function isLower64Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
/** 10 필드 전부의 소유 바인딩 비교(최소 범위; 메타데이터 일반 비교/서명 아님). */
export function scopeEquals(a: LocalSketchScope, b: LocalSketchScope): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  return Object.keys(SCOPE_SPECS).every((key) => left[key] === right[key]);
}

/** 파일 parser: 정확 schema/mode/scope 검증 + raw bytes 로부터의 receipt hash.
 *  값 규칙(uuid/16진/scope 일치)은 Python 계약이 이미 검증했다 — 여기선 구조만 강제한다. */
export function parseLocalSketchReceipt(bytes: Uint8Array): { receipt: LocalSketchReceipt; sha256: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("invalid:receipt");
  }
  if (!isObject(parsed)) fail("invalid:receipt");
  const raw = parsed as Record<string, unknown>;
  if (Object.keys(raw).length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((key) => key in raw)) {
    fail("invalid:receipt");
  }
  if (raw.schema !== LOCAL_SKETCH_RECEIPT_SCHEMA) fail("invalid:receipt.schema");
  if (raw.mode !== LOCAL_SKETCH_MODE) fail("invalid:receipt.mode");
  if (!Array.isArray(raw.clips) || !Array.isArray(raw.credits)) fail("invalid:receipt");
  const receipt: LocalSketchReceipt = {
    schema: raw.schema as LocalSketchReceipt["schema"], mode: raw.mode as LocalSketchReceipt["mode"],
    scope: pickObject<LocalSketchScope>(raw.scope, SCOPE_SPECS, "scope"),
    claim_id: text(raw.claim_id),
    clips: (raw.clips as unknown[]).map((entry) => pickObject<LocalSketchReceipt["clips"][number]>(entry, CLIP_SPECS, "clips")),
    credits: (raw.credits as unknown[]).map((entry) => pickObject<LocalSketchReceipt["credits"][number]>(entry, CREDIT_SPECS, "credits")),
  };
  return { receipt, sha256: sha256Hex(bytes) };
}

/** 이후 시작 step 의 차단 대상 분기(clips-gate/assemble-gate 의 false 쪽). */
export function blockedTargetFor(
  startStepId: string,
): { stage: "clips-gate" | "assemble-gate"; branchStepId: string } | null {
  if (startStepId === "clips-blocked") return { stage: "clips-gate", branchStepId: "clips-blocked" };
  if (startStepId === "assemble-blocked") return { stage: "assemble-gate", branchStepId: "assemble-blocked" };
  return null;
}

/** 합성 assemble 증거의 구조적 유효성(값은 소비자가 도구 결과와 대조한다). */
export function assemblyIsValid(a: LocalSketchAssembly | undefined): boolean {
  if (!a || typeof a.videoObject !== "string" || a.videoObject === "") return false;
  return Number.isFinite(a.bytes) && a.bytes > 0
    && Number.isFinite(a.durationSec) && a.durationSec > 0
    && isLower64Hex(a.manifestSha256) && isLower64Hex(a.videoSha256);
}

/** 공급된 선행 증거 문서 검증 + snapshot(호출자 변형 차단). 미공급이면 undefined.
 *  schema/mode/선택 필드 타입 불량은 missing_predecessor_evidence,
 *  scope/receiptSha256 불일치는 predecessor_scope_mismatch 다. */
export function validateSuppliedPredecessors(
  supplied: LocalSketchPredecessorEvidence | undefined,
  expectedScope: LocalSketchScope,
  receiptSha256: string,
): LocalSketchPredecessorEvidence | undefined {
  if (!supplied) return undefined;
  const doc = supplied as unknown as Record<string, unknown>;
  if (!isObject(doc)) fail("missing_predecessor_evidence");
  if (doc.schema !== LOCAL_SKETCH_PREDECESSORS_SCHEMA || doc.mode !== LOCAL_SKETCH_MODE) {
    fail("missing_predecessor_evidence");
  }
  if (!isObject(doc.scope)) fail("missing_predecessor_evidence");
  let scope: LocalSketchScope;
  try {
    scope = pickObject<LocalSketchScope>(doc.scope, SCOPE_SPECS, "scope");
  } catch {
    fail("missing_predecessor_evidence");
  }
  if (typeof doc.receiptSha256 !== "string" || doc.receiptSha256 === "") fail("missing_predecessor_evidence");
  if ((doc.clipsGateOk !== undefined && typeof doc.clipsGateOk !== "boolean")
    || (doc.assembleGateOk !== undefined && typeof doc.assembleGateOk !== "boolean")
    || (doc.decisionId !== undefined && (typeof doc.decisionId !== "string" || doc.decisionId === ""))
    || (doc.assemble !== undefined && !isObject(doc.assemble))) {
    fail("missing_predecessor_evidence");
  }
  if (!scopeEquals(scope, expectedScope) || doc.receiptSha256 !== receiptSha256) {
    fail("predecessor_scope_mismatch");
  }
  return structuredClone(supplied);
}

/** apply 가 생성/디스패치 전에 요구 선행 증거를 강제한다(자동 fallback 금지). */
export function requirePrerequisites(
  startStepId: string,
  evidence: LocalSketchPredecessorEvidence | undefined,
): void {
  if (startStepId === "clips-gate") return; // 선행 증거 불필요
  if (startStepId === "clips-blocked") {
    if (evidence?.clipsGateOk !== false) fail("missing_predecessor_evidence");
    return;
  }
  if (startStepId === "assemble") {
    if (evidence?.clipsGateOk !== true) fail("missing_predecessor_evidence");
    return;
  }
  if (!assemblyIsValid(evidence?.assemble)) fail("missing_predecessor_evidence");
  if (startStepId === "assemble-gate") return;
  const gateMustBeOk = startStepId !== "assemble-blocked";
  if (gateMustBeOk && evidence?.assembleGateOk !== true) fail("missing_predecessor_evidence");
  if (!gateMustBeOk && evidence?.assembleGateOk !== false) fail("missing_predecessor_evidence");
  if (startStepId === "publish" && !evidence?.decisionId) fail("missing_predecessor_evidence");
}

/** receipt-gate 통과 후 이후 시작 step 에 주입할 합성 증거(assemble/decisionId 만). */
export function predecessorSeeds(
  startStepId: string,
  evidence: LocalSketchPredecessorEvidence | undefined,
): Pick<LocalSketchPredecessorEvidence, "assemble" | "decisionId"> {
  const seeds: Pick<LocalSketchPredecessorEvidence, "assemble" | "decisionId"> = {};
  if (["assemble-gate", "final-review", "publish"].includes(startStepId) && evidence?.assemble) {
    seeds.assemble = structuredClone(evidence.assemble);
  }
  if (startStepId === "publish" && evidence?.decisionId) seeds.decisionId = evidence.decisionId;
  return seeds;
}
