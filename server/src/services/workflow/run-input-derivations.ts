/**
 * 워크플로우 runInputs 파생 입력(deriveFrom) 지원.
 *
 * - 추출기는 고정 명명 레지스트리만 존재한다(정의에 임의 정규식 저장 금지 — ReDoS/실행권위 방어).
 * - 파생은 실행 생성 시점(POST /workflows/:id/runs) 메타데이터 채움에만 쓰인다.
 *   큐/런 실행 의미는 건드리지 않는다(순수 계산).
 */

export type WorkflowRunInputDeriveFrom = {
  input: string;
  extract: "youtubeVideoId";
};

export type WorkflowRunInputDeclaration = {
  key: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  deriveFrom?: WorkflowRunInputDeriveFrom;
};

/** 11자 YouTube 영상 ID 추출. youtu.be/ID, watch?v=ID, shorts/ID (+ &si= 등 파라미터 동반) 지원. */
export function extractYoutubeVideoId(value: string): string | null {
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
    /[?&]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

const RUN_INPUT_EXTRACTORS: Record<WorkflowRunInputDeriveFrom["extract"], (value: string) => string | null> = {
  youtubeVideoId: extractYoutubeVideoId,
};

/**
 * 정의 저장 시점 검증: deriveFrom.input은 같은 runInputs 선언 안의 형제 키를 참조해야 한다.
 * 실패 메시지는 "Invalid workflow runInputs:" 프리픽스를 가지며 라우트가 422로 번역한다.
 */
export function validateRunInputDeclarations(runInputs: readonly WorkflowRunInputDeclaration[] | undefined): void {
  if (!runInputs || runInputs.length === 0) return;
  const declaredKeys = new Set(runInputs.map((input) => input.key));
  for (const input of runInputs) {
    if (!input.deriveFrom) continue;
    if (!declaredKeys.has(input.deriveFrom.input)) {
      throw new Error(
        `Invalid workflow runInputs: input "${input.key}" deriveFrom references unknown input "${input.deriveFrom.input}"`,
      );
    }
  }
}

export type RunInputDerivationResult =
  | { status: "ok"; metadata: Record<string, unknown> }
  | { status: "error"; message: string };

/**
 * 실행 입력 파생 적용:
 * - 사용자가 값을 직접 줬으면 추출로 덮어쓰지 않는다.
 * - 값 누락/공란이면 소스 입력 값에서 추출해 채운다.
 * - 추출 실패 + required(기본 true) → 구조화 에러. required 아님 → 생략(기존 동작).
 */
export function applyRunInputDerivations(
  runInputs: readonly WorkflowRunInputDeclaration[] | undefined,
  metadata: Record<string, unknown> | undefined,
): RunInputDerivationResult {
  const derived = runInputs?.filter((input) => input.deriveFrom) ?? [];
  if (derived.length === 0) return { status: "ok", metadata: metadata ?? {} };

  const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const input of derived) {
    const deriveFrom = input.deriveFrom!;
    const provided = nextMetadata[input.key];
    if (typeof provided === "string" && provided.trim().length > 0) continue;

    const source = nextMetadata[deriveFrom.input];
    const extracted = typeof source === "string" && source.trim().length > 0
      ? RUN_INPUT_EXTRACTORS[deriveFrom.extract](source.trim())
      : null;
    if (extracted === null) {
      const required = input.required !== false;
      if (required) {
        return {
          status: "error",
          message: `${input.key} could not be derived from ${deriveFrom.input}; check the URL format`,
        };
      }
      delete nextMetadata[input.key];
      continue;
    }
    nextMetadata[input.key] = extracted;
  }
  return { status: "ok", metadata: nextMetadata };
}
