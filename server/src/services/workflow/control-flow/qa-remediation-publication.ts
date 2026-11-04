// server/src/services/workflow/control-flow/qa-remediation-publication.ts
//
// [purpose] Stage B owned root — 검증된 qa_remediation_prepared(v2) 예약을 read-only 로 재구성하고,
//   이미 획득한 native file owner 에 정확한 publish item 집합을 넘긴다. 이 모듈은 파일을 직접
//   변경하지 않는다. 실제 temp/write/fsync/replace/readback 은 소유된 helper 가 수행한다.
//
// [authority — 오직 호출자 소유] 이 helper 는 preparation 레코드나 해시 자체를 쓰기 권한으로 해석하지
//   않는다. 호출자(B2 root)가 (1) 이 preparationId 예약 행의 정확한 소유와 (2) mission→run 잠금 순서의
//   단일-기록자 권한을 이미 보유한 상태에서만 호출해야 하며, 그 전제는 아래 Authority 입력으로 명시적으로
//   선언·문서화만 한다(예약/잠금 부재 시 호출 자체가 root 계약 위반이다). 해시·bytes 는 권한을 만들지
//   않으며, native guard 수명과 DB 권한 재검증은 B2 root 가 공급한다. 이 모듈은 DB mutation·wake 없이
//   publish 계획만 반환한다(완료 tx/wake 는 B2 root 소관).
//
// [safety]
//   - preflight-first: 모든 대상을 읽어 before/after/neither 분류와 재구성 검증을 마치기 전엔 아무
//     파일도 기록하지 않는다(mismatched input 이면 전체 홀드 — 부분 기록 없음).
//   - identity, not intent(C5): bytes 해시는 before/after 상태 인식(멱등 증거)에만 쓰이고 권한의
//     원천은 DB 예약이다. after 상태는 verified-skip, before 상태만 결정론적 재구성 후 기록,
//     그 외(neither)는 typed 홀드로 절대 덮어쓰지 않는다.
//   - recovery: native helper 의 다중 파일 부분 게시 뒤 재호출은 after 상태를 skip 하고 남은 before 만 적용한다.
//   - alias: canonical 경로가 realpath 와 정확히 일치하는 정규 파일만 대상이다. symlink 구성요소는
//     승인 경계 밖 우회 위험으로 거부한다(리다이렉트 추종/재작성 없음 — B2 root 가 경계를 공급).
//   - io_error 계약: 부분 IO 실패는 io_error typed 결과로만 보고되며 not_applicable/producer 재작업으로
//     축소되지 않는다 — B2 는 같은 예약으로 이 helper 를 다시 호출해 이어붙인다.

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  FILE_OWNER_PROTOCOL_VERSION,
  type FileOwnerPublishItem,
  type QaRemediationFileOwner,
} from "./qa-remediation-file-owner.js";
import {
  parseQaRemediationPreparation,
  type QaRemediationFileIdentity,
  type QaRemediationPreparation,
} from "./qa-remediation-preparation-contract.js";
import { QA_REMEDIATION_MAX_FILE_BYTES } from "./qa-remediation-contract.js";

const OWNER_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** [caller-held precondition] 호출자(B2 root)가 이미 정확한 예약·잠금을 보유했음을 선언하는 입력. */
export interface QaRemediationPublicationAuthority {
  /** 호출자가 소유 중인 예약 행 id — preparation.preparationId 와 정확 일치해야 한다. */
  readonly reservationEventId: string;
  /** 호출자의 현재 발행 권한 버전 — preparation.dispatchAuthorityVersion 와 정확 일치해야 한다. */
  readonly dispatchAuthorityVersion: number;
  /** caller-authorized 경계(생산자 active workProduct 정규 절대경로) — loadProducerArtifactBoundary 계약. */
  readonly allowedFiles: ReadonlySet<string>;
  readonly allowedDirs: readonly string[];
}

export type QaRemediationPublicationHeldReason =
  | "invalid_preparation"
  | "authority_mismatch"
  | "target_not_regular"
  | "alias_refused"
  | "state_mismatch"
  | "reconstruction_mismatch"
  | "owner_required"
  | "owner_target_mismatch"
  | "unsupported_payload_size"
  | "unsupported_frame_size"
  | "native_owner_held";

export type QaRemediationFilePublicationStatus =
  | "applied"         // 이번 호출에서 temp+rename+readback 검증까지 완료
  | "already_applied" // preflight 가 after 신원 확인 — 재기록 없는 verified skip
  | "held"            // preflight 홀드로 기록되지 않음(다른 파일이 원인 포함)
  | "mismatch_held"   // 이 파일이 홀드 원인(before/after 어느 신원도 아님·재구성 불일치·alias)
  | "io_error"        // 이 파일 기록/재읽기 중 IO 실패
  | "not_attempted";  // 앞선 io_error 로 시도되지 않음

export interface QaRemediationFilePublication {
  readonly file: string;
  readonly status: QaRemediationFilePublicationStatus;
  readonly detail: string;
}

export type QaRemediationPublicationResult =
  | { readonly outcome: "published"; readonly files: readonly QaRemediationFilePublication[]; readonly detail: string }
  | { readonly outcome: "held"; readonly reason: QaRemediationPublicationHeldReason; readonly files: readonly QaRemediationFilePublication[]; readonly detail: string }
  | { readonly outcome: "io_error"; readonly files: readonly QaRemediationFilePublication[]; readonly detail: string };

type PreflightOutcome =
  | { readonly kind: "apply"; readonly identity: QaRemediationFileIdentity; readonly desired: Buffer }
  | { readonly kind: "skip"; readonly identity: QaRemediationFileIdentity; readonly desired: Buffer }
  | { readonly kind: "held"; readonly identity: QaRemediationFileIdentity; readonly reason: QaRemediationPublicationHeldReason; readonly detail: string }
  | { readonly kind: "io_error"; readonly identity: QaRemediationFileIdentity; readonly detail: string };

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** canonical 경계 판정 — legacy isInsideBoundary 패턴을 그대로 적용(경계 자체는 호출자가 공급). */
function isLexicallyInside(canonical: string, authority: QaRemediationPublicationAuthority): boolean {
  if (authority.allowedFiles.has(canonical)) return true;
  return authority.allowedDirs.some((dir) => {
    const rel = path.relative(path.resolve(dir), canonical);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/** ordered exact-once 재구성 — preparation.verdicts 순서·items 원본 순서 그대로(legacy 시뮬레이션과 동일 규칙). */
function reconstructAfter(identity: QaRemediationFileIdentity, preparation: QaRemediationPreparation, before: Buffer):
{ ok: true; desired: Buffer } | { ok: false; detail: string } {
  let content = before.toString("utf8");
  let applied = 0;
  for (const verdict of preparation.verdicts) {
    for (const item of verdict.items) {
      if (path.resolve(item.file) !== identity.path) continue;
      const first = content.indexOf(item.find);
      if (first === -1 || content.indexOf(item.find, first + 1) !== -1) {
        return { ok: false, detail: `find not exactly-once in ${identity.path}` };
      }
      content = content.slice(0, first) + item.replace + content.slice(first + item.find.length);
      applied += 1;
    }
  }
  if (applied === 0) return { ok: false, detail: `no ordered items cover ${identity.path}` };
  const desired = Buffer.from(content, "utf8");
  if (sha256(desired) !== identity.afterSha256 || desired.length !== identity.afterByteSize) {
    return { ok: false, detail: `reconstructed bytes do not match recorded after identity for ${identity.path}` };
  }
  return { ok: true, desired };
}

/** 단일 대상 preflight — 상태 분류·alias 검증·(before 면) 재구성 검증까지. 기록은 하지 않는다. */
async function preflightFile(identity: QaRemediationFileIdentity, preparation: QaRemediationPreparation): Promise<PreflightOutcome> {
  if (identity.afterByteSize > QA_REMEDIATION_MAX_FILE_BYTES) {
    return { kind: "held", identity, reason: "unsupported_payload_size", detail: "desired bytes exceed the native file-owner limit" };
  }
  let st;
  try {
    st = await stat(identity.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "held", identity, reason: "state_mismatch", detail: "target missing" };
    }
    return { kind: "io_error", identity, detail: `stat failed: ${message(error)}` };
  }
  if (!st.isFile()) return { kind: "held", identity, reason: "target_not_regular", detail: "target is not a regular file" };
  try {
    if ((await realpath(identity.path)) !== identity.path) {
      return { kind: "held", identity, reason: "alias_refused", detail: "path resolves through a symlink component (realpath differs)" };
    }
  } catch (error) {
    return { kind: "io_error", identity, detail: `realpath failed: ${message(error)}` };
  }
  // 크기가 어느 신원과도 다르면 읽지 않고 neither — 과대 파일을 이 단계에서 차단한다.
  if (st.size !== identity.beforeByteSize && st.size !== identity.afterByteSize) {
    return { kind: "held", identity, reason: "state_mismatch", detail: "byte size matches neither before nor after identity" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(identity.path);
  } catch (error) {
    return { kind: "io_error", identity, detail: `read failed: ${message(error)}` };
  }
  const digest = sha256(bytes);
  if (digest === identity.afterSha256 && bytes.length === identity.afterByteSize) {
    return { kind: "skip", identity, desired: bytes };
  }
  if (digest !== identity.beforeSha256 || bytes.length !== identity.beforeByteSize) {
    return { kind: "held", identity, reason: "state_mismatch", detail: "bytes match neither before nor after identity" };
  }
  const reconstruction = reconstructAfter(identity, preparation, bytes);
  if (!reconstruction.ok) return { kind: "held", identity, reason: "reconstruction_mismatch", detail: reconstruction.detail };
  return { kind: "apply", identity, desired: reconstruction.desired };
}

/**
 * [purpose] 검증된 예약의 파일들만 결정론적으로 게시한다. 권한은 호출자 소유(상단 계약) — 이 함수는
 *   예약·잠금의 존재를 증명하지 않고, Authority 바인딩(예약 id/권한 버전/경계) 정합성만 검사한다.
 */
export async function publishQaRemediationPreparation(
  preparation: unknown,
  authority: QaRemediationPublicationAuthority,
  owner?: Pick<QaRemediationFileOwner, "targets" | "publish">,
  beforeNativePublish?: () => void,
): Promise<QaRemediationPublicationResult> {
  let parsed: QaRemediationPreparation;
  try {
    parsed = parseQaRemediationPreparation(preparation);
  } catch (error) {
    return { outcome: "held", reason: "invalid_preparation", files: [], detail: `malformed preparation: ${message(error)}` };
  }
  if (parsed.preparationId !== authority.reservationEventId || parsed.dispatchAuthorityVersion !== authority.dispatchAuthorityVersion) {
    return { outcome: "held", reason: "authority_mismatch", files: [], detail: "caller reservation/authority version does not bind this preparation" };
  }
  for (const identity of parsed.files) {
    if (!isLexicallyInside(identity.path, authority)) {
      return { outcome: "held", reason: "authority_mismatch", files: [], detail: `file outside caller-authorized boundary: ${identity.path}` };
    }
  }
  if (!owner) {
    return { outcome: "held", reason: "owner_required", files: [], detail: "an acquired native file owner is required" };
  }
  const targetSet = parsed.files.map((file) => file.path).sort();
  const ownedTargets = [...owner.targets()];
  if (ownedTargets.length !== targetSet.length || ownedTargets.some((target, index) => target !== targetSet[index])) {
    return { outcome: "held", reason: "owner_target_mismatch", files: [], detail: "acquired owner targets do not match the exact sorted preparation targets" };
  }

  // preflight: 전 대상 분류·검증. 하나라도 불일치면 아무 파일도 기록하지 않는다.
  const outcomes: PreflightOutcome[] = [];
  for (const identity of parsed.files) outcomes.push(await preflightFile(identity, parsed));
  const held = outcomes.find((o): o is Extract<PreflightOutcome, { kind: "held" }> => o.kind === "held");
  if (held) {
    return {
      outcome: "held",
      reason: held.reason,
      files: outcomes.map((o) => ({
        file: o.identity.path,
        status: o.kind === "held" ? "mismatch_held" : o.kind === "io_error" ? "io_error" : "held",
        detail: o.kind === "apply" || o.kind === "skip" ? "not written: preflight held before any write" : o.detail,
      })),
      detail: `preflight held: ${held.detail}`,
    };
  }
  const preflightIo = outcomes.find((o): o is Extract<PreflightOutcome, { kind: "io_error" }> => o.kind === "io_error");
  if (preflightIo) {
    return {
      outcome: "io_error",
      files: outcomes.map((o) => ({
        file: o.identity.path,
        status: o.kind === "io_error" ? "io_error" : "not_attempted",
        detail: o.kind === "io_error" ? o.detail : "not attempted: preflight io failure",
      })),
      detail: `preflight io failure: ${preflightIo.detail}`,
    };
  }

  const plan: Extract<PreflightOutcome, { kind: "apply" | "skip" }>[] = [];
  for (const o of outcomes) if (o.kind === "apply" || o.kind === "skip") plan.push(o);
  const items: FileOwnerPublishItem[] = plan.map((entry) => ({
    target: entry.identity.path,
    beforeSha256: entry.identity.beforeSha256,
    beforeSize: entry.identity.beforeByteSize,
    afterSha256: entry.identity.afterSha256,
    afterSize: entry.identity.afterByteSize,
    bytesB64: entry.desired.toString("base64"),
  }));
  const serializedFrame = `${JSON.stringify({ v: FILE_OWNER_PROTOCOL_VERSION,
    id: "00000000-0000-4000-8000-000000000000", op: "publish", items })}\n`;
  if (Buffer.byteLength(serializedFrame, "utf8") > OWNER_MAX_FRAME_BYTES) {
    return { outcome: "held", reason: "unsupported_frame_size",
      files: plan.map((entry) => ({ file: entry.identity.path, status: "held", detail: "not written: complete native request exceeds the frame limit" })),
      detail: "complete serialized native publish frame exceeds the 8 MiB transport limit" };
  }

  beforeNativePublish?.();
  const native = await owner.publish(items);
  const files = native.files.map((file) => ({ file: file.target, status: file.status, detail: file.detail }));
  if (native.outcome === "held") {
    return { outcome: "held", reason: "native_owner_held", files, detail: native.detail };
  }
  if (native.outcome === "io_error") return { outcome: "io_error", files, detail: native.detail };
  return { outcome: "published", files, detail: native.detail };
}
