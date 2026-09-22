import { describe, expect, it } from "vitest";
import {
  AGENT_SHADOW_CONF_FLOOR_DEFAULT,
  AGENT_SHADOW_TEXT_CHAR_CAP,
  assembleAgentJudgmentShadowState,
  buildShadowStructureStats,
  computeAgentJudgmentShadowVerdict,
  extractShadowVisibleText,
} from "../services/judgment/agent-judgment-shadow-state.js";

describe("extractShadowVisibleText", () => {
  it("비문자열·빈 문자열은 null 을 반환한다", () => {
    expect(extractShadowVisibleText(null)).toBeNull();
    expect(extractShadowVisibleText(undefined)).toBeNull();
    expect(extractShadowVisibleText(123)).toBeNull();
    expect(extractShadowVisibleText("")).toBeNull();
  });

  it("script/style/noscript/template/svg 블록과 HTML 주석을 제거한다", () => {
    const html =
      "<html><body><h1>제목</h1><script>var leak = \"SCRIPTMARK\";</script>" +
      "<style>body { color: red }</style><noscript>noscript-text</noscript>" +
      "<template>template-text</template><svg><text>svg-text</text></svg>" +
      "<!-- comment-marker --><p>본문</p></body></html>";
    const result = extractShadowVisibleText(html);
    expect(result?.truncated).toBe(false);
    expect(result?.text).toContain("제목");
    expect(result?.text).toContain("본문");
    for (const marker of ["SCRIPTMARK", "color: red", "noscript-text", "template-text", "svg-text", "comment-marker"]) {
      expect(result?.text).not.toContain(marker);
    }
  });

  it("기본 엔티티를 디코드한다", () => {
    const result = extractShadowVisibleText("<p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;a&#39; end&nbsp;</p>");
    expect(result?.text).toBe('A & B <tag> "q" \'a\' end');
  });

  it("공백을 정규화한다(연속 공백 → 단일 스페이스 + trim)", () => {
    const result = extractShadowVisibleText("<p>가나\t다\n\n  라    마</p>");
    expect(result?.text).toBe("가나 다 라 마");
  });

  it("상한을 넘으면 절단하고 truncated=true, 상한 이하는 truncated=false", () => {
    const cap = AGENT_SHADOW_TEXT_CHAR_CAP;
    const over = extractShadowVisibleText("<p>" + "x".repeat(cap + 500) + "</p>");
    expect(over?.text).toHaveLength(cap);
    expect(over?.truncated).toBe(true);
    const exact = extractShadowVisibleText("<p>" + "y".repeat(cap) + "</p>");
    expect(exact?.text).toHaveLength(cap);
    expect(exact?.truncated).toBe(false);
  });
});

describe("buildShadowStructureStats", () => {
  it("빈 HTML 은 docChars/textChars 0 이고 노드는 최소 1개다", () => {
    const stats = buildShadowStructureStats("");
    expect(stats.docChars).toBe(0);
    expect(stats.textChars).toBe(0);
    expect(stats.nodeCount).toBeGreaterThanOrEqual(1);
  });

  it("일반 HTML 의 수치는 html-preflight(inspectHtmlDocument) 기준과 같다", () => {
    const html = "<html><body><p>hello <b>world</b></p><p>두번째</p></body></html>";
    expect(buildShadowStructureStats(html)).toEqual({ docChars: html.length, textChars: 13, nodeCount: 10 });
  });
});

describe("assembleAgentJudgmentShadowState", () => {
  it("document 문자열로 축약 state 를 만든다(원문·스크립트 미포함)", () => {
    const html = "<html><body><h1>제목</h1><script>var leak = 1;</script><p>본문</p></body></html>";
    const state = assembleAgentJudgmentShadowState(html, "리포트 검토");
    expect(state?.subject).toBe("리포트 검토");
    expect(state?.document_text).toBe(extractShadowVisibleText(html)?.text);
    expect(state?.text_truncated).toBe(false);
    expect(state?.structure_stats).toEqual(buildShadowStructureStats(html));
    expect(JSON.stringify(state)).not.toContain("var leak");
  });

  it("subject 를 생략하면 빈 문자열 기본값을 쓴다", () => {
    const state = assembleAgentJudgmentShadowState("<p>본문</p>");
    expect(state?.subject).toBe("");
  });

  it("document 가 비문자열·빈 문자열이면 null(호출자 skip)", () => {
    expect(assembleAgentJudgmentShadowState(null)).toBeNull();
    expect(assembleAgentJudgmentShadowState(undefined)).toBeNull();
    expect(assembleAgentJudgmentShadowState(123)).toBeNull();
    expect(assembleAgentJudgmentShadowState("")).toBeNull();
    expect(assembleAgentJudgmentShadowState({ document: "x" })).toBeNull();
  });
});

type RawAnswer = Record<string, unknown>;

function answer(name: string, fields: Partial<RawAnswer>): RawAnswer {
  return { name, type: "noul", ...fields };
}

function bothTrue(confA: number, confB: number): RawAnswer[] {
  return [
    answer("complete_html", { value: true, confidence: confA }),
    answer("claims_grounded", { value: true, confidence: confB }),
  ];
}

describe("computeAgentJudgmentShadowVerdict — 계산형 verdict 전 분기", () => {
  it("둘 다 true + conf >= floor → low_risk(최소 신뢰도 보고)", () => {
    const verdict = computeAgentJudgmentShadowVerdict(bothTrue(0.9, 0.8));
    expect(verdict.verdict).toBe("low_risk");
    expect(verdict.minConfidence).toBe(0.8);
  });

  it("하나라도 false → needs_full_review", () => {
    const verdict = computeAgentJudgmentShadowVerdict([
      answer("complete_html", { value: true, confidence: 0.9 }),
      answer("claims_grounded", { value: false, confidence: 0.9 }),
    ]);
    expect(verdict.verdict).toBe("needs_full_review");
    expect(verdict.minConfidence).toBe(0.9);
  });

  it("질문 결측 → insufficient_evidence(malformed)", () => {
    const verdict = computeAgentJudgmentShadowVerdict([
      answer("complete_html", { value: true, confidence: 0.9 }),
    ]);
    expect(verdict.verdict).toBe("insufficient_evidence");
    expect(verdict.reason).toMatch(/^malformed:/);
    expect(verdict.minConfidence).toBeNull();
  });

  it("boolean 이 아닌 value → insufficient_evidence(malformed)", () => {
    for (const bad of ["yes", 1]) {
      const verdict = computeAgentJudgmentShadowVerdict([
        answer("complete_html", { value: bad, confidence: 0.9 }),
        answer("claims_grounded", { value: true, confidence: 0.9 }),
      ]);
      expect(verdict.verdict).toBe("insufficient_evidence");
      expect(verdict.reason).toMatch(/^malformed:/);
    }
  });

  it("noul 이 아닌 type → insufficient_evidence(malformed)", () => {
    const verdict = computeAgentJudgmentShadowVerdict([
      { name: "complete_html", type: "choice", value: true, confidence: 0.9 },
      answer("claims_grounded", { value: true, confidence: 0.9 }),
    ]);
    expect(verdict.verdict).toBe("insufficient_evidence");
    expect(verdict.reason).toMatch(/^malformed:/);
  });

  it("confidence 결측·범위 밖 → insufficient_evidence(malformed)", () => {
    for (const bad of [undefined, 1.5, Number.NaN]) {
      const verdict = computeAgentJudgmentShadowVerdict([
        answer("complete_html", { value: true, confidence: 0.9 }),
        answer("claims_grounded", { value: true, ...(bad === undefined ? {} : { confidence: bad }) }),
      ]);
      expect(verdict.verdict).toBe("insufficient_evidence");
      expect(verdict.reason).toMatch(/^malformed:/);
    }
  });

  it("min conf < floor → insufficient_evidence(low_confidence)", () => {
    const verdict = computeAgentJudgmentShadowVerdict(bothTrue(0.9, 0.5));
    expect(verdict.verdict).toBe("insufficient_evidence");
    expect(verdict.reason).toBe("low_confidence");
    expect(verdict.minConfidence).toBeNull();
    // false 답변 + 저신뢰도도 마찬가지로 실패 닫힘(floor 게이트가 등급 판정보다 앞선다)
    const falseLow = computeAgentJudgmentShadowVerdict([
      answer("complete_html", { value: true, confidence: 0.9 }),
      answer("claims_grounded", { value: false, confidence: 0.4 }),
    ]);
    expect(falseLow.verdict).toBe("insufficient_evidence");
    expect(falseLow.reason).toBe("low_confidence");
  });

  it("경계값 conf === floor 는 통과한다", () => {
    expect(computeAgentJudgmentShadowVerdict(bothTrue(AGENT_SHADOW_CONF_FLOOR_DEFAULT, AGENT_SHADOW_CONF_FLOOR_DEFAULT)).verdict).toBe("low_risk");
    expect(computeAgentJudgmentShadowVerdict(bothTrue(0.9, 0.85), 0.9).verdict).toBe("insufficient_evidence");
  });

  it("unknown 입력 오염(배열 아님) → insufficient_evidence(malformed)", () => {
    for (const bad of [null, "x", {}, 42]) {
      const verdict = computeAgentJudgmentShadowVerdict(bad);
      expect(verdict.verdict).toBe("insufficient_evidence");
      expect(verdict.reason).toMatch(/^malformed:/);
    }
  });
});
