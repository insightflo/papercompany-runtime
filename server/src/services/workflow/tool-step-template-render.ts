import path from "node:path";
import { STEP_ARTIFACT_TOKEN } from "./step-artifact-references.js";

const RUN_METADATA_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;
/**
 * [workflow child fix P2-9] 자식 run 입력 토큰 — 부모 workflow 스텝 inputs 가
 * 자식 run metadata.workflowChildInputs 에 저장되고, 자식의 tool 스텝이
 * {$childInputs.<key>} 로 개별 소비한다. 미지 키는 토큰 잔존 → 기존 strict
 * fail-closed(ANY_UNRESOLVED_TOKEN_RE) 가 dispatch 를 거부한다.
 */
const CHILD_INPUTS_TOKEN = /\{\$childInputs\.([A-Za-z0-9_]+)\}/g;
/** 렌더 후 잔존 검출용(fail-closed) — 유효 문자셋 밖의 키(customer-id 등)도 포괄한다(fix3 P2-6). */
const UNRESOLVED_CHILD_INPUTS_TOKEN = /\{\$childInputs\.[^}]*\}/u;

/**
 * 문자열이 아닌 run metadata 값을 템플릿 치환 문자열로 변환.
 * undefined(키 부재와 동급)는 null을 반환해 호출자가 토큰을 유지하게 한다.
 */
export function stringifyWorkflowRunMetadataValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : null;
}

/**
 * [fix2 P2-7] 렌더 후 미해결 {$childInputs.*} 토큰은 fail-closed — enqueue/실행 이전에
 * 구조화 실패(throw)로 마감된다. 도구 실행기가 알 수 없는 자식 입력 토큰을 받는 일은 없다.
 */
function renderChecked(value: unknown, runDate: string, runId: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  const rendered = renderTemplates(value, runDate, runId, pathsByStepId, runMetadata);
  const serialized = JSON.stringify(rendered ?? "");
  const unresolved = UNRESOLVED_CHILD_INPUTS_TOKEN.exec(serialized);
  if (unresolved) {
    throw new Error(
      `Unresolved {$childInputs} token in tool args: ${unresolved[0]}`
      + " (child input keys must be declared on the parent workflow step inputs)",
    );
  }
  return rendered;
}

/**
 * [수정 변경맵 Q11 — 대상층 재렌더] seed 물화 재검증용 순수 렌더: 실행 경로와 동일한 renderChecked
 * 파이프라인으로 인자를 재렌더하되, 해석 결과값(run 좌표·run metadata·참조 경로 맵)을 호출자가
 * 명시적으로 공급받는다. DB 조회·핀 기록은 수행하지 않는다(해석 기계의 렌더 단말만 재사용).
 */
export function renderWorkflowToolStepArgsWithResolvedValues(input: {
  args: unknown; runDate: string; runId: string; pathsByStepId: Map<string, string>; runMetadata: Record<string, unknown>;
}): unknown {
  return renderChecked(input.args, input.runDate, input.runId, input.pathsByStepId, input.runMetadata);
}

/**
 * [arg hygiene — 2026-09-02] bash ANSI-C 이스케이프 잔여 정화.
 * 오너/에이전트가 셸 오류 메시지에서 복사한 경로가 `$'/srv/...'` 또는 `$/srv/...` 형태로
 * 인자에 섞여 들어오면 도구가 존재하지 않는 경로(`$/...`)를 열다 실패한다(2026-08-29/31
 * enqueue-naver-publish 오염 2건, 25.6분 현수). `$/`·`$'`로 시작하는 문자열 값은
 * 정상 경로/값으로 존재할 수 없으므로 선행 `$`를 제거한다.
 */
export function stripShellEscapeResidue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$/") || value.startsWith("$'")) return value.slice(1);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => stripShellEscapeResidue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripShellEscapeResidue(entry);
    }
    return out;
  }
  return value;
}

/**
 * [runMonth — 2026-09-03] runDate(YYYY-MM-DD)에서 월 폴더용 YYYYMM 추출.
 * 파싱 실패 시 null — 렌더러는 원문 토큰을 그대로 둔다(렌더 실패보다 눈에 보이는 실패).
 */
export function runMonthFromRunDate(runDate: string): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(runDate);
  return match ? `${match[1]}${match[2]}` : null;
}

function renderTemplates(value: unknown, runDate: string, runId: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return stripShellEscapeResidue(value
      .replaceAll("{$runDate}", runDate)
      .replaceAll("{$date}", runDate)
      .replaceAll("{$workflowRunId}", runId)
      .replaceAll("{$runMonth}", runMonthFromRunDate(runDate) ?? "{$runMonth}")
      .replace(STEP_ARTIFACT_TOKEN, (token, stepId: string, field: string) => {
        const workProductPath = pathsByStepId.get(stepId);
        if (!workProductPath) return token;
        if (field === "workProductPath") return workProductPath;
        if (field === "siblingAssetsDir") return path.join(path.dirname(workProductPath), "assets");
        return path.dirname(workProductPath);
      })
      .replace(RUN_METADATA_TOKEN, (token, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(runMetadata, key)) return token;
        const rendered = stringifyWorkflowRunMetadataValue(runMetadata[key]);
        return rendered === null ? token : rendered;
      })
      .replace(CHILD_INPUTS_TOKEN, (token, key: string) => {
        const childInputs = runMetadata.workflowChildInputs;
        if (!childInputs || typeof childInputs !== "object" || Array.isArray(childInputs)) return token;
        const bag = childInputs as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(bag, key)) return token;
        const rendered = stringifyWorkflowRunMetadataValue(bag[key]);
        return rendered === null ? token : rendered;
      }));
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, runDate, runId, pathsByStepId, runMetadata));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplates(item, runDate, runId, pathsByStepId, runMetadata)]));
  }
  return value;
}
