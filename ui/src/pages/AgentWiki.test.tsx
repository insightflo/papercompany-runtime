/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// [사고→패턴 카드 화면 노출] 기존 Agent 자가학습 Wiki 페이지에 카드 섹션이 뜨는지,
//   "자동 주입되는 자가학습 교훈"과 "주입 없는 큐레이션 카드"의 층 구분이 드러나는지.
//   정적 마크업 렌더로 검증(레포 규약) — 클릭 확장은 초기 마크업에 detail이 없음으로 확인.
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "knowledge-patterns") {
      return {
        data: {
          patterns: [{
            id: "card-1",
            companyId: "company-1",
            kind: "failure_mode",
            title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
            summary: "이중완료가 게이트 토큰과 영구 불일치를 만든다.",
            evidence: [{ type: "workflow_run", id: "38fb7ef5", note: "PR #156" }],
            symptoms: "런 running 유지 + QA 스텝 pending 지속",
            rootCause: "이중완료가 completedAt을 재스탬프",
            whatWorked: "게이트 CAS 재큐 + 재검증",
            scopeTags: ["workflow", "structural-gate"],
            source: "mission_owner_compile",
            createdByAgentId: null,
            supersededById: null,
            createdAt: "2026-08-29T12:00:00.000Z",
          }],
        },
        isLoading: false,
        isError: false,
        error: null,
      };
    }
    return {
      data: {
        entries: [],
        timeseries: [],
        summary: { totalEntries: 0, activeEntries: 0, resolvedEntries: 0, totalHits: 0 },
      },
      isLoading: false,
      isError: false,
      error: null,
    };
  },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));

import { AgentWiki } from "./AgentWiki";

describe("AgentWiki pattern cards section", () => {
  const markup = renderToStaticMarkup(<AgentWiki />);

  it("renders curated pattern cards with kind, title, tags, and owner-compiled source", () => {
    expect(markup).toContain("사고→패턴 카드 (1)");
    expect(markup).toContain("구조 게이트 토큰 불일치로 QA 스텝 무발사");
    expect(markup).toContain("#workflow #structural-gate");
    expect(markup).toContain("오너 컴파일");
    expect(markup).toContain("failure_mode");
  });

  it("keeps the layer distinction visible: curated cards are not auto-injected", () => {
    expect(markup).toContain("실행 프롬프트에 주입되지 않고");
    expect(markup).toContain("자동 주입");
  });

  it("collapses card detail by default (symptoms/rootCause not in initial markup)", () => {
    expect(markup).not.toContain("이중완료가 completedAt을 재스탬프");
    expect(markup).not.toContain("런 running 유지 + QA 스텝 pending 지속");
    expect(markup).not.toContain("workflow_run:38fb7ef5");
  });
});
