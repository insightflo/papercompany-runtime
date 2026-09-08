import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { conflict, HttpError } from "../../../errors.js";
import { hashStructuredValue, stableStringify } from "../../issue-execution-cards/hash.js";
import {
  snapshotHashSchema,
  snapshotNonNegSafeIntSchema,
  snapshotStateSchema,
  type SnapshotState,
} from "./snapshot-state.js";

/**
 * [파일 목적] Task5c1 순수 signed snapshot 경계 — SnapshotState 를 5분 TTL HMAC 토큰으로
 *   sign/verify 하고 stateHash 를 계산한다. env/global clock 접근 없음, key 생성/폴백 없음
 *   (32바이트 Buffer 만). preview/readmodel/config/routes 는 이후 조립 슬라이스 소관.
 * [불변식]
 *   - 모든 실패(런타임 입력/스키마/토큰 형식/서명/시간/크기)는 공개 균일 오류
 *     `stale_snapshot` 하나로 균일화 — 값/Zod 진단/암호 오류 문자열 노출 금지.
 *   - wire: base64url(canonical envelope JSON) + "." + base64url(HMAC-SHA256 32바이트),
 *     HMAC 입력은 domain 분리 "papercompany.workflow-resume.snapshot.v1." + encoded segment.
 *   - JSON 파싱 전에 HMAC 검증. 파싱 후 stableStringify(envelope) === 원문 UTF8 강제
 *     (중복 키/비정규 공백/키 순서/비정규 base64url/패딩 전부 거부).
 *   - 무효 UTF8 바이트 거부: 디코딩된 text 를 재인코딩한 바이트가 원본 envelope 바이트와
 *     정확히 일치해야 한다 (lone 0xFF 등이 U+FFFD 로 치환되어 통과하는 것을 차단, fix1).
 *   - 시간창: issuedAt <= now < expiresAt (만료 순간 포함 거부), expiresAt === issuedAt+300000.
 *   - 이 모듈은 token 무결성만 인증 — factsHash 진실성이나 eligibility 을 판정하지 않는다.
 */

const SNAPSHOT_HMAC_DOMAIN = "papercompany.workflow-resume.snapshot.v1.";
const SNAPSHOT_TTL_MS = 300_000;
const SNAPSHOT_MAX_TOKEN_LENGTH = 16_384;
const SNAPSHOT_KEY_LENGTH = 32;
const SNAPSHOT_SIGNATURE_LENGTH = 32;
const MAX_DATE_MS = 8_640_000_000_000_000;

const snapshotEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    keyId: z.string(),
    stateHash: snapshotHashSchema,
    issuedAt: snapshotNonNegSafeIntSchema,
    expiresAt: snapshotNonNegSafeIntSchema,
    state: snapshotStateSchema,
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.expiresAt !== envelope.issuedAt + SNAPSHOT_TTL_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expiry mismatch" });
    }
    if (envelope.issuedAt > MAX_DATE_MS - SNAPSHOT_TTL_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "issuedAt out of Date range" });
    }
  });

/** 공개 균일 오류 — 내부 사유를 절대 반영하지 않는 고정 메시지. */
function staleSnapshot(): HttpError {
  return conflict("stale_snapshot");
}

/** 모든 내부 예외(Zod/JSON/crypto/타입)를 균일 오류로 수렴시킨다. */
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof HttpError && error.message === "stale_snapshot") throw error;
    throw staleSnapshot();
  }
}

function assertRuntimeInputs(key: Buffer, now: Date): void {
  if (!Buffer.isBuffer(key) || key.length !== SNAPSHOT_KEY_LENGTH) throw staleSnapshot();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw staleSnapshot();
}

function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function isCanonicalBase64UrlSegment(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  return Buffer.from(segment, "base64url").toString("base64url") === segment;
}

export function signSnapshot(payload: SnapshotState, key: Buffer, now: Date): string {
  return guard(() => {
    assertRuntimeInputs(key, now);
    const state = snapshotStateSchema.parse(payload);
    const issuedAt = now.getTime();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > MAX_DATE_MS - SNAPSHOT_TTL_MS) {
      throw staleSnapshot();
    }
    const envelope = {
      schemaVersion: 1 as const,
      keyId: keyIdOf(key),
      stateHash: hashStructuredValue(state),
      issuedAt,
      expiresAt: issuedAt + SNAPSHOT_TTL_MS,
      state,
    };
    snapshotEnvelopeSchema.parse(envelope);
    const encoded = Buffer.from(stableStringify(envelope), "utf8").toString("base64url");
    const signature = createHmac("sha256", key)
      .update(SNAPSHOT_HMAC_DOMAIN + encoded)
      .digest("base64url");
    const token = encoded + "." + signature;
    if (token.length > SNAPSHOT_MAX_TOKEN_LENGTH) throw staleSnapshot();
    return token;
  });
}

export function verifySnapshot(token: string, key: Buffer, now: Date): SnapshotState {
  return guard(() => {
    assertRuntimeInputs(key, now);
    if (typeof token !== "string" || token.length === 0 || token.length > SNAPSHOT_MAX_TOKEN_LENGTH) {
      throw staleSnapshot();
    }
    const segments = token.split(".");
    if (segments.length !== 2 || segments[0].length === 0 || segments[1].length === 0) {
      throw staleSnapshot();
    }
    const [envelopeSegment, signatureSegment] = segments;
    if (!isCanonicalBase64UrlSegment(envelopeSegment) || !isCanonicalBase64UrlSegment(signatureSegment)) {
      throw staleSnapshot();
    }
    const signatureBytes = Buffer.from(signatureSegment, "base64url");
    if (signatureBytes.length !== SNAPSHOT_SIGNATURE_LENGTH) throw staleSnapshot();
    // HMAC 을 JSON 파싱 전에 검증한다 (timingSafeEqual).
    const expectedSignature = createHmac("sha256", key)
      .update(SNAPSHOT_HMAC_DOMAIN + envelopeSegment)
      .digest();
    if (!timingSafeEqual(signatureBytes, expectedSignature)) throw staleSnapshot();

    const envelopeBytes = Buffer.from(envelopeSegment, "base64url");
    const text = envelopeBytes.toString("utf8");
    // 서명 검증 직후/파싱 전: 무효 UTF8 바이트는 디코딩 시 U+FFFD 로 치환되므로
    // 재인코딩 바이트가 원본과 일치하지 않는다 — 이 경우 균일 오류로 거부한다 (fix1).
    if (!Buffer.from(text, "utf8").equals(envelopeBytes)) throw staleSnapshot();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw staleSnapshot();
    }
    const envelope = snapshotEnvelopeSchema.parse(parsed);
    if (stableStringify(parsed) !== text) throw staleSnapshot();
    if (envelope.keyId !== keyIdOf(key)) throw staleSnapshot();
    if (envelope.stateHash !== hashStructuredValue(envelope.state)) throw staleSnapshot();
    const nowMs = now.getTime();
    if (!(envelope.issuedAt <= nowMs && nowMs < envelope.expiresAt)) throw staleSnapshot();
    return envelope.state;
  });
}

export function hashSnapshotState(payload: SnapshotState): string {
  return guard(() => hashStructuredValue(snapshotStateSchema.parse(payload)));
}
