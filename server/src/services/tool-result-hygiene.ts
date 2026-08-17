// [tool result hygiene] 같은 run에서 같은 도구가 같은 에러를 반복 반환할 때,
//   응답 본문을 1줄 요약으로 축소해 에이전트 히스토리 누적(컨텍스트 비대)을 막는다.
//
// 근거(2026-08-17 실측 해부): 검증 에이전트가 불허된 social-search 커뮤니티를 반복 조회하며
//   동일 HTTP 400 진단문이 매턴 전문(全文)으로 세션 히스토리에 쌓여 한 run이 52만+ 토큰이 됨.
//   로컬 CLI(pi/hermes/commandcode)의 run 내 히스토리는 CLI가 소유하므로 papercompany가
//   통제할 수 있는 유일한 지점이 이 HTTP 응답 body다(모든 어댑터가 이 엔드포인트를 호출).
//
// 설계 원칙 (AGENTS 규칙 7/8 준수):
//   - 첫 발생은 전문 그대로 통과(증거 보존). 두 번째부터만 축소.
//   - 응답 JSON shape와 status는 유지 — error 키가 계속 존재하고 문자열이다.
//   - 워크플로우 스텝 증거(completeWorkflowToolStepFromResult)는 다른 경로(executeCoreWorkflowTool
//     반환값)를 쓰므로 이 축소의 영향을 받지 않는다. 여기는 에이전트 향 응답만 다룬다.
//   - 에이전트 자연어를 파싱하지 않는다(기계 생성 JSON의 error 문자열만 정규화 비교).

import { createHash } from "node:crypto";

const MAX_TRACKED_SIGNATURES = 2000;
const SIGNATURE_TTL_MS = 2 * 60 * 60 * 1000;
/** 축소 시 원문을 이 만큼은 남긴다(에이전트가 무엇의 중복인지 알 수 있게). */
const DUPLICATE_EXCERPT_CHARS = 140;

type SignatureEntry = { count: number; firstSeenAt: number };

const signatures = new Map<string, SignatureEntry>();

/** 에러 문자열 정규화: 숫자는 타임아웃 밀리초·경과시간 등 가변부라 마스킹, 공백 축약. */
export function normalizeToolErrorSignature(text: string): string {
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function signatureKey(input: { tool: string; status?: number | null; error: string }): string {
  const normalized = normalizeToolErrorSignature(input.error).slice(0, 2000);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${input.tool}|${input.status ?? "x"}|${hash}`;
}

function evictStaleSignatures(now: number): void {
  if (signatures.size <= MAX_TRACKED_SIGNATURES) return;
  for (const [key, entry] of signatures) {
    if (now - entry.firstSeenAt > SIGNATURE_TTL_MS) signatures.delete(key);
  }
  while (signatures.size > MAX_TRACKED_SIGNATURES) {
    const oldest = signatures.keys().next().value;
    if (oldest === undefined) break;
    signatures.delete(oldest);
  }
}

export type ToolErrorHygieneResult = {
  /** 그대로 보낼 body(첫 발생이면 입력과 동일 객체) */
  body: Record<string, unknown>;
  /** 이 (run, tool, 시그니처) 조합의 누적 발생 횟수. 1이면 첫 발생. */
  duplicateCount: number;
};

function condenseErrorText(error: string, count: number): string {
  const excerpt = error.length > DUPLICATE_EXCERPT_CHARS
    ? `${error.slice(0, DUPLICATE_EXCERPT_CHARS)} …`
    : error;
  return `${excerpt} [duplicate tool error ×${count} in this run — identical to an earlier response; do not retry the same call unchanged]`;
}

function recordAndCondense(input: {
  runId: string;
  tool: string;
  status?: number | null;
  error: string;
}): { error: string; count: number } | null {
  const now = Date.now();
  const key = `${input.runId}|${signatureKey({ tool: input.tool, status: input.status, error: input.error })}`;
  const existing = signatures.get(key);
  if (!existing) {
    evictStaleSignatures(now);
    signatures.set(key, { count: 1, firstSeenAt: now });
    return null;
  }
  existing.count += 1;
  return { error: condenseErrorText(input.error, existing.count), count: existing.count };
}

/**
 * 에이전트 향 도구 실행 응답 body에서 중복 에러를 축소한다.
 *   - errorPath "error": 최상위 {error: string} (core tool body / throw 응답)
 *   - errorPath "result.error": {result: {error: string}} (plugin ToolExecutionResult)
 * 에러가 없거나(성공) 문자열이 아니면 그대로 반환한다.
 */
export function condenseDuplicateToolErrorBody(input: {
  runId: string;
  tool: string;
  status?: number | null;
  body: Record<string, unknown>;
  errorPath?: "error" | "result.error";
}): ToolErrorHygieneResult {
  const { body } = input;
  const errorPath = input.errorPath ?? "error";

  let errorContainer: Record<string, unknown> | null = null;
  let error: unknown = undefined;
  if (errorPath === "result.error") {
    const inner = body.result;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return { body, duplicateCount: 1 };
    errorContainer = inner as Record<string, unknown>;
    error = errorContainer.error;
  } else {
    errorContainer = body;
    error = body.error;
  }
  if (typeof error !== "string" || error.length === 0) return { body, duplicateCount: 1 };

  const condensed = recordAndCondense({
    runId: input.runId,
    tool: input.tool,
    status: input.status,
    error,
  });
  if (!condensed) return { body, duplicateCount: 1 };

  const nextBody: Record<string, unknown> =
    errorPath === "result.error"
      ? { ...body, result: { ...(body.result as Record<string, unknown>), error: condensed.error } }
      : { ...body, error: condensed.error };
  return { body: nextBody, duplicateCount: condensed.count };
}

/** 테스트 전용: 상태 초기화. */
export function resetToolErrorHygieneForTests(): void {
  signatures.clear();
}
