import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanyContext } from "../context/CompanyContext";
import { CompanyLanguageProvider, L, resolveCompanyLanguage, useCompanyLanguage } from "./companyLanguage";
import { humanLabel } from "./humanLabels";

function Consumer() {
  const lang = useCompanyLanguage();
  return <span>{L(lang, { en: "English", ko: "한국어" })}</span>;
}
describe("company language resolution", () => {
  it("defaults to English without providers or selected company", () => {
    expect(renderToStaticMarkup(<Consumer />)).toBe("<span>English</span>");
    expect(resolveCompanyLanguage(null)).toBe("en");
  });
  it("reads selected company and lets an explicit language override take precedence", () => {
    const value = { companies: [], selectedCompanyId: "company", selectedCompany: { id: "company", name: "Company", description: null, status: "active", pauseReason: null, pausedAt: null, issuePrefix: "CO", issueCounter: 0, budgetMonthlyCents: 0, spentMonthlyCents: 0, requireBoardApprovalForNewAgents: false, brandColor: null, logoAssetId: null, logoUrl: null, timezone: null, workProductRoot: null, defaultLanguage: "ko", createdAt: new Date(), updatedAt: new Date() }, selectionSource: "bootstrap", loading: false, error: null,
      setSelectedCompanyId: () => {}, reloadCompanies: async () => {}, createCompany: async () => { throw new Error("unused"); } } as React.ContextType<typeof CompanyContext>;
    expect(renderToStaticMarkup(<CompanyContext.Provider value={value}><Consumer /></CompanyContext.Provider>)).toBe("<span>한국어</span>");
    expect(renderToStaticMarkup(<CompanyContext.Provider value={value}><CompanyLanguageProvider language="en"><Consumer /></CompanyLanguageProvider></CompanyContext.Provider>)).toBe("<span>English</span>");
  });
  it("keeps unknown enums visible and preserves raw mapped values", () => {
    for (const raw of ["future_status", "constructor", "toString", "__proto__"]) {
      expect(humanLabel("ko", "continuationStatus", raw)).toEqual({ label: raw, raw });
    }
    expect(humanLabel("ko", "continuationStatus", "agent_unrunnable")).toEqual({ label: "에이전트 실행 불가", raw: "agent_unrunnable" });
    expect(humanLabel("en", "missionDecisionStatus", "under_review")).toEqual({ label: "Under review", raw: "under_review" });
  });
});
