import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardHumanSummary } from "./CardHumanSummary";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import type { HumanSummaryView } from "@/api/approvals";

/** [휴먼카드 해석 블록] 표시 전용 계약: done 렌더링, pending/failed 상태, 없으면 원문 폴백(랜더 없음). */

const doneSummary: HumanSummaryView = {
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

  it("renders the beginner summary fields for a done summary", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={doneSummary} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("에이전트 고용 승인 요약");
    expect(html).toContain("결정 필요:");
    expect(html).toContain("승인");
    expect(html).toContain("고용됩니다");
    expect(html).toContain("다시 해석");
    expect(html).toContain("test-model");
  });

  it("shows a failure hint without dumping raw card content", () => {
    const failed: HumanSummaryView = { ...doneSummary, status: "failed", summary: null, error: "cli exit=1" };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <CardHumanSummary approvalId="a1" companyId="c1" summary={failed} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("해석 실패");
    expect(html).toContain("cli exit=1");
    expect(html).not.toContain("에이전트 고용 승인 요약");
  });
});
