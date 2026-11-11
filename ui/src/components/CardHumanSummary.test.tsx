import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardHumanSummary } from "./CardHumanSummary";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import type { HumanSummaryView } from "@/api/approvals";

/** [휴먼카드 해석 블록] 표시 전용 계약: 신형(Stage 3) 3항목 축소 렌더, 구 5섹션 행 레거시 폴백 렌더,
 *  pending/failed 상태, 없으면 원문 폴백(랜더 없음). */

/** 신형 고정 축소 형식 — API 뷰 타입은 구 스키마로 선언되어 있어 신형 형태는 캐스트로 주입한다. */
const compactDone: HumanSummaryView = {
  status: "done",
  adapterType: "pi_local",
  model: "test-model",
  summary: {
    symptom: ["에이전트 고용 승인 대기", "새 에이전트 고용 요청이 결정을 기다립니다"],
    optionsLine: "승인(고용 진행) / 거절(중단)",
    interpretation: "사람이 고용을 허락해야 진행되기 때문에 확인이 필요합니다.",
  } as unknown as HumanSummaryView["summary"],
  error: null,
  updatedAt: new Date("2026-11-01") as unknown as string,
};

/** 구형(Stage 3 이전 저장 행) 5섹션 형식 — 레거시 렌더 폴백 검증용. */
const legacyDone: HumanSummaryView = {
  status: "done",
  adapterType: "pi_local",
  model: "test-model",
  summary: {
    oneLine: "에이전트 고용 승인 요약",
    whatHappening: "새 에이전트를 고용하려는 요청입니다.",
    decisionNeeded: "고용을 승인할지 결정하세요.",
    options: [{ label: "승인", meaning: "에이전트가 고용됩니다" }],
    cautions: ["승인만으로 실행되지 않을 수 있습니다"],
  },
  error: null,
  updatedAt: new Date("2026-11-01") as unknown as string,
};

describe("CardHumanSummary", () => {
  it("renders nothing when summary is absent (original-text fallback)", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" summary={null} />
      </CompanyLanguageProvider>,
    );
    expect(html).toBe("");
  });

  it("renders the compact 3-part summary (symptom ≤2 lines / options line / one-sentence interpretation) for a Stage 3 row", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={compactDone} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("에이전트 고용 승인 대기");
    expect(html).toContain("새 에이전트 고용 요청이 결정을 기다립니다");
    expect(html).toContain("선택지:");
    expect(html).toContain("승인(고용 진행) / 거절(중단)");
    expect(html).toContain("사람이 고용을 허락해야 진행되기 때문에 확인이 필요합니다.");
    // 상세 근거는 요약 본문에 나열하지 않고 연결된 이슈 링크 안내만 둔다.
    expect(html).toContain("상세 근거는 이 카드에 연결된 이슈 링크에서 확인하세요.");
    expect(html).not.toContain("결정 필요:");
    expect(html).toContain("다시 해석");
    expect(html).toContain("test-model");
  });

  it("renders the legacy 5-section summary for pre-Stage-3 rows (backward-compatible fallback)", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={legacyDone} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("에이전트 고용 승인 요약");
    expect(html).toContain("결정 필요:");
    expect(html).toContain("승인");
    expect(html).toContain("고용됩니다");
    expect(html).toContain("다시 해석");
  });

  it("does not crash on a malformed summary row (neither compact nor legacy fields)", () => {
    const malformed: HumanSummaryView = {
      ...compactDone,
      summary: { foo: "bar" } as unknown as HumanSummaryView["summary"],
    };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={malformed} />
      </CompanyLanguageProvider>,
    );
    // 블록은 살아 있되(렌더 크래시 없음) 신형 본문은 나오지 않아야 한다. 라벨만 남은 빈 레거시 폴백은 허용.
    expect(html).toContain("쉬운 해석");
    expect(html).not.toContain("선택지:");
    expect(html).not.toContain("에이전트 고용 승인 대기");
  });

  it("shows a failure hint without dumping raw card content", () => {
    const failed: HumanSummaryView = { ...compactDone, status: "failed", summary: null, error: "cli exit=1" };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={failed} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("해석 실패");
    expect(html).toContain("cli exit=1");
    expect(html).not.toContain("에이전트 고용 승인 대기");
  });
});
