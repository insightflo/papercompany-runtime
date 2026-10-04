import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ApprovalCard } from "./ApprovalCard";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { CompanyContext } from "../context/CompanyContext";
import { koCompanyContext } from "../test-utils/koCompanyContext";

const approval: Approval = {
  id: "approval-1", companyId: "company-1", type: "hire_agent", status: "pending",
  payload: { name: "Agent-authored 이름", role: "engineer" },
  requestedByAgentId: null, requestedByUserId: "board", requestedByPluginId: null,
  decisionNote: "Original decision note", decidedByUserId: null, decidedAt: null,
  createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"),
};
const card = <ApprovalCard approval={approval} requesterAgent={null} onApprove={() => {}} onReject={() => {}} isPending={false} />;

describe("approval language boundary", () => {
  it("defaults to English without any company provider and retains payload content", () => {
    const html = renderToStaticMarkup(card);
    expect(html).toContain("Hire Agent: Agent-authored 이름");
    expect(html).toContain(">Pending<");
    expect(html).toContain(">Approve<");
    expect(html).toContain("Original decision note");
    expect(html).toContain("engineer");
  });
  it("reads Korean from the selected company and retains agent payload and note", () => {
    const html = renderToStaticMarkup(<CompanyContext.Provider value={koCompanyContext}>{card}</CompanyContext.Provider>);
    expect(html).toContain("에이전트 고용 승인: Agent-authored 이름");
    expect(html).toContain(">대기 중<");
    expect(html).toContain(">승인<");
    expect(html).toContain("결정 메모:");
    expect(html).toContain("Original decision note");
    expect(html).toContain("engineer");
  });
  it("uses Korean chrome under an explicit company language provider", () => {
    const html = renderToStaticMarkup(<CompanyLanguageProvider language="ko">{card}</CompanyLanguageProvider>);
    expect(html).toContain("에이전트 고용 승인: Agent-authored 이름");
    expect(html).toContain(">대기 중<");
    expect(html).toContain(">승인<");
    expect(html).toContain("결정 메모:");
    expect(html).toContain("engineer");
  });
});
