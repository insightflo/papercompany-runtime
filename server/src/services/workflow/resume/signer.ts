import { HttpError } from "../../../errors.js";
import type { ResumeSnapshotSigner } from "./preview.js";

/** 서명 키는 매 호출 process.env 에서 읽는다. 누락/오작형은 고정 503 — fallback/난수 키 없음.
 *   [승인=재개 2026-10-23] route(webflow-resume.ts) 로드러와 동일 계약의 공용 로더로 추출. */
const SIGNING_KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const SIGNING_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export function loadResumeSignerFromEnv(): ResumeSnapshotSigner {
  const raw = process.env[SIGNING_KEY_ENV];
  if (typeof raw !== "string" || !SIGNING_KEY_PATTERN.test(raw)) {
    throw new HttpError(503, "resume_unavailable");
  }
  return { key: Buffer.from(raw, "hex"), now: () => new Date() };
}
