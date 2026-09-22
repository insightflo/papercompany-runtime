// server/src/services/judgment/agent-judgment-shadow-state.ts
//
// [파일 목적] Jev agent-judgment 섀도 캘리브레이션(v2) — 섀도 판단 입력 조립 + 계산형
//   verdict 의 순수 계산층. DB·라우트·실행제어 무접촉(단위 테스트로 검증).
//
// [핵심 원칙] 모델 추정 overall 제거 — 최종 등급(low_risk | needs_full_review |
//   insufficient_evidence)은 코드가 계산한다(실패 닫힘). 모델은 noul 사실질문
//   (complete_html, claims_grounded)에만 답하고, 답변이 결측·오염되거나 최소 신뢰도에
//   못 미치면 insufficient_evidence 로 닫는다.
//
// [입력 축약] 판단 공급자에는 원문 HTML 을 보내지 않는다 — 가시 텍스트만 뽑은
//   document_text(상한 절단) + 구조 통계 structure_stats 만 전달한다.

// 구조 통계는 stage-1 html-preflight(inspectHtmlDocument) 기준을 그대로 재사용한다.
import { JSDOM } from "jsdom";
import { inspectHtmlDocument } from "./html-preflight-executor.js";

export interface AgentShadowStructureStats {
  docChars: number;
  textChars: number;
  nodeCount: number;
}

/** 가시 텍스트 추출 상한(자). 초과분은 절단하고 truncated 플래그를 세운다. */
export const AGENT_SHADOW_TEXT_CHAR_CAP = 20_000;

/** noul 답변 최소 신뢰도(기본 바닥값). min confidence 미달이면 insufficient_evidence. */
export const AGENT_SHADOW_CONF_FLOOR_DEFAULT = 0.6;

// DOM spec NodeType.TEXT_NODE(Node.js 전역에는 Node 인터페이스가 없어 지역 상수로 둔다).
const TEXT_NODE_TYPE = 3;
/** 가시 텍스트에서 제외할 블록 태그 — html-preflight NON_VISIBLE_TAGS + svg. */
const HIDDEN_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

/**
 * [목적] jsdom 파싱 후 가시 텍스트 노드만 모은다. script/style/noscript/template/svg
 *   하위 텍스트는 조상 태그 검사로 제외하고, 주석 노드(nodeType 8)는 애초에 텍스트
 *   노드가 아니므로 자연히 빠진다. 기본 엔티티(&amp; 등)는 파서가 이미 디코드한다.
 * [출력] 공백 정규화 전 원시 가시 텍스트. 파싱 자체가 실패하면 null.
 */
function collectVisibleRawText(html: string): string | null {
  let document: Document;
  try {
    document = new JSDOM(html).window.document;
  } catch {
    return null;
  }
  const root = document.body ?? document.documentElement;
  if (!root) return "";
  let raw = "";
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.nodeType === TEXT_NODE_TYPE) {
      let parent = node.parentElement;
      let hidden = false;
      while (parent) {
        if (HIDDEN_TAGS.has(parent.tagName.toUpperCase())) {
          hidden = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!hidden) raw += node.nodeValue ?? "";
    }
    pending.push(...Array.from(node.childNodes));
  }
  return raw;
}

/**
 * [목적] HTML 에서 가시 텍스트만 추출한다. script/style/noscript/template/svg 블록과
 *   HTML 주석 제거, 기본 엔티티(&amp; &lt; &gt; &quot; &#39; &nbsp;) 디코드,
 *   공백 정규화(연속 공백 → 단일 스페이스 + trim), 상한 절단을 적용한다.
 * [출력] { text, truncated }. 비문자열·빈 문자열 입력은 null(호출자가 skip 판정).
 */
export function extractShadowVisibleText(html: unknown): { text: string; truncated: boolean } | null {
  if (typeof html !== "string" || html.length === 0) return null;
  const raw = collectVisibleRawText(html);
  if (raw === null) return null;
  // \s 는 줄바꿈·탭·&nbsp;(U+00A0)까지 묶어 단일 스페이스로 정규화한다.
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= AGENT_SHADOW_TEXT_CHAR_CAP) {
    return { text: normalized, truncated: false };
  }
  return { text: normalized.slice(0, AGENT_SHADOW_TEXT_CHAR_CAP), truncated: true };
}

/**
 * [목적] stage-1 html-preflight 와 동일 기준의 구조 통계 — jsdom 파싱 후
 *   inspectHtmlDocument 를 재사용해 docChars/textChars/nodeCount 를 얻는다.
 *   판단 입력은 축약해도 통계 기준은 기존 게이트와 일치시킨다(비교 정합성).
 *   textChars 는 inspectHtmlDocument 기준(가시 텍스트에서 모든 공백을 제거한 글자 수).
 */
export function buildShadowStructureStats(html: string): AgentShadowStructureStats {
  try {
    return inspectHtmlDocument(new JSDOM(html).window.document, html.length).stats;
  } catch {
    // 병리적 입력으로 파싱이 실패해도 호출자를 죽이지 않는다 — 통계 0(실패 닫힘 표식).
    return { docChars: html.length, textChars: 0, nodeCount: 0 };
  }
}

/**
 * 섀도 판단에 전달되는 축약 state. 원문 HTML 은 포함되지 않는다.
 * type 별칭으로 선언해 JudgmentAskState(Record 기반)에 암시적 인덱스 시그니처로 할당 가능.
 */
export type AgentShadowState = {
  subject: string;
  document_text: string;
  text_truncated: boolean;
  structure_stats: AgentShadowStructureStats;
};

/**
 * [목적] v1 감사행의 inputState 에서 섀도 판단용 축약 state 를 조립한다.
 *   document 는 문자열이어야 하고, 비문자열·빈 문자열이면 null(호출자 skip).
 * [출력] AgentShadowState — subject 는 원본 값, 없으면 빈 문자열.
 */
export function assembleAgentJudgmentShadowState(document: unknown, subject?: string): AgentShadowState | null {
  if (typeof document !== "string" || document.length === 0) return null;
  const visible = extractShadowVisibleText(document);
  if (!visible) return null;
  return {
    subject: typeof subject === "string" ? subject : "",
    document_text: visible.text,
    text_truncated: visible.truncated,
    structure_stats: buildShadowStructureStats(document),
  };
}

/** 계산형 verdict 값. low_risk = 검토 생략 후보, needs_full_review = 전체 검토 필요. */
export type AgentShadowVerdictValue = "low_risk" | "needs_full_review" | "insufficient_evidence";

export interface AgentShadowVerdict {
  verdict: AgentShadowVerdictValue;
  /** "malformed:<원인>" | "low_confidence" | 등급 산출 근거 요약. */
  reason: string;
  /** 검증 통과한 noul 답변들의 최소 confidence. 검증 실패 시 null. */
  minConfidence: number | null;
}

function malformed(reason: string): AgentShadowVerdict {
  return { verdict: "insufficient_evidence", reason, minConfidence: null };
}

/** 검증 통과한 noul 답변(value/confidence). 하나라도 어기면 null(malformed). */
interface ValidatedNoulAnswer {
  value: boolean;
  confidence: number;
}

/**
 * [목적] 외부 JSON answers 에서 특정 이름의 noul 답변을 꺼내 직접 검증한다.
 *   조건: 정확히 1개 존재(결측·중복 모두 모호 → 실패 닫힘), type "noul", value boolean,
 *   confidence 0..1 유한 숫자. 형태를 믿지 않고 하나씩 확인한다.
 */
function readNoulAnswer(answers: unknown[], name: string): ValidatedNoulAnswer | null {
  const matches = answers.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) && (entry as Record<string, unknown>).name === name,
  );
  if (matches.length !== 1) return null;
  const answer = matches[0];
  if (answer.type !== "noul") return null;
  if (typeof answer.value !== "boolean") return null;
  const confidence = answer.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  return { value: answer.value, confidence };
}

/**
 * [목적] 계산형 verdict(실패 닫힘). complete_html·claims_grounded(noul, boolean value,
 *   0..1 numeric confidence) 중 하나라도 결측·오염이면 insufficient_evidence
 *   ("malformed:..."), min confidence 가 floor 미만이면 insufficient_evidence
 *   ("low_confidence"), 둘 다 true 면 low_risk, 그 외엔 needs_full_review.
 * [보안] answers 는 외부 JSON(unknown)으로 받아 직접 검증한다 — 형태를 믿지 않는다.
 */
export function computeAgentJudgmentShadowVerdict(
  answers: unknown,
  floor: number = AGENT_SHADOW_CONF_FLOOR_DEFAULT,
): AgentShadowVerdict {
  if (!Array.isArray(answers)) return malformed("malformed:answers_not_array");
  const completeHtml = readNoulAnswer(answers, "complete_html");
  if (!completeHtml) return malformed("malformed:complete_html");
  const claimsGrounded = readNoulAnswer(answers, "claims_grounded");
  if (!claimsGrounded) return malformed("malformed:claims_grounded");
  const minConfidence = Math.min(completeHtml.confidence, claimsGrounded.confidence);
  // 신뢰도 게이트가 등급 판정보다 앞선다 — false 답변 + 저신뢰도도 insufficient_evidence.
  if (minConfidence < floor) {
    return { verdict: "insufficient_evidence", reason: "low_confidence", minConfidence: null };
  }
  if (completeHtml.value && claimsGrounded.value) {
    return { verdict: "low_risk", reason: "noul_all_true", minConfidence };
  }
  const failed = [
    ...(completeHtml.value ? [] : ["complete_html"]),
    ...(claimsGrounded.value ? [] : ["claims_grounded"]),
  ].join(",");
  return { verdict: "needs_full_review", reason: "noul_false:" + failed, minConfidence };
}
