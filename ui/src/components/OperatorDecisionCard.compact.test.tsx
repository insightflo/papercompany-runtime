/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { HumanReviewPacket } from "./HumanReviewPacket";
import { OperatorDecisionCard } from "./OperatorDecisionCard";
import { CompanyLanguageProvider } from "../lib/companyLanguage";

vi.mock("../lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

// [사람 카드 축소 Stage 4] symptom 이 있는 신형 패킷 — 서버 카드 빌더(Stage 1)가 만드는 고정 축소 형태.
const compactDecision: OperatorDecisionView = {
  id: "decision-compact",
  companyId: "company-1",
  schemaVersion: 1,
  requestKey: "moi2:1",
  status: "pending",
  priority: "high",
  interactionType: "single_select",
  title: "Owner asks for direction",
  description: "Long markdown body that must not expand on the compact card.",
  sourceType: "mission_owner_human_input",
  sourceId: "event-1",
  sourceContext: { missionId: "mission-1", workflowId: null, workflowRunId: null, artifactRefs: [] },
  definition: {
    options: [
      { id: "approve", label: "Approve", description: "Proceed with the requested next step", facts: [], evidenceRefs: [] },
      { id: "hold", label: "Hold", description: null, facts: [], evidenceRefs: [] },
    ],
    actions: [{ id: "approve", label: "Approve", outcome: "approve", tone: "primary", requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "required", label: "Reason", placeholder: null, maxLength: 100 },
    approvedScope: [],
    forbiddenScope: [],
    humanReview: {
      schemaVersion: "human-review-v1",
      symptom: "미션이 오너 방향 결정을 기다립니다\n오너가 다음 단계 승인을 요청했습니다",
      decisionSubject: "미션 오너의 사람 결정 요청 — 방향 승인 여부",
      evidence: [
        { label: "Owner issue", href: "/issues/owner-1", location: "Issue > body", description: null },
        { label: "External brief", href: "https://example.com/brief", location: "External", description: null },
      ],
      interpretation: "운영자가 방향을 승인하면 오너가 다음 단계를 진행합니다.",
      impact: { ifApproved: "The owner proceeds.", ifRejected: "The handoff returns.", ifWrong: "The wrong step runs." },
      unresolvedFacts: [], questions: [], recommendedNextStep: "Check the linked issue and decide.", requiredReviewer: "human-operator",
    },
  },
  result: null,
  issueId: "owner-1",
  issueIdentifier: null,
  issueTitle: null,
  missionTitle: null,
  continuationMode: "issue_current_assignee",
  requestedBy: { type: "agent", id: "agent-1" },
  resolvedByUserId: null,
  resolvedAt: null,
  cancelledAt: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
  continuation: null,
};

let host: HTMLDivElement;
let root: Root;

async function renderCard(decision: OperatorDecisionView = compactDecision, onResolve = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => {
    root.render(<CompanyLanguageProvider language="en"><OperatorDecisionCard decision={decision} onResolve={onResolve} /></CompanyLanguageProvider>);
  });
  return onResolve;
}

function click(element: Element) {
  act(() => (element as HTMLElement).click());
}

const optionRow = (id: string) => host.querySelector(`[data-operator-decision-option="${id}"]`)!;

describe("OperatorDecisionCard compact human card (Stage 4)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders the fixed compact layout: symptom ≤2줄 → options(1줄 요약) → 해석 1문장 → 근거 링크 칩", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={compactDecision} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    // 증상 블록 — line-clamp-2 로 최대 2줄만 표시한다.
    expect(html).toContain("Symptom");
    expect(html).toContain("미션이 오너 방향 결정을 기다립니다");
    expect(html).toContain("line-clamp-2");
    // 선택지 — 설명이 1줄로 고정된다.
    expect(html).toContain("Proceed with the requested next step");
    expect(html).toContain("line-clamp-1");
    // 쉬운 해석 — 강조된 1문장.
    expect(html).toContain("Plain-language read");
    expect(html).toContain("운영자가 방향을 승인하면 오너가 다음 단계를 진행합니다.");
    // 상세 근거 — 카드 밖 링크 칩만(내부 /issues 링크 + 외부 URL).
    expect(html).toContain("Detailed evidence");
    expect(html).toContain('href="/issues/owner-1"');
    expect(html).toContain('href="https://example.com/brief"');
    // 고정 순서: 증상 → 선택지 → 해석 → 근거 → 결정 액션.
    expect(html.indexOf("미션이 오너 방향 결정을 기다립니다")).toBeLessThan(html.indexOf("Proceed with the requested next step"));
    expect(html.indexOf("Proceed with the requested next step")).toBeLessThan(html.indexOf("운영자가 방향을 승인하면"));
    expect(html.indexOf("운영자가 방향을 승인하면")).toBeLessThan(html.indexOf("Detailed evidence"));
    expect(html.indexOf("Detailed evidence")).toBeLessThan(html.lastIndexOf(">Approve<"));
  });

  it("hides long-form packet sections and the duplicate title on the compact card", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={compactDecision} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    // 장문 패킷 섹션·중복 부제목·description 본문은 펼치지 않는다.
    expect(html).not.toContain("Evidence &amp; source location");
    expect(html).not.toContain("Current interpretation");
    expect(html).not.toContain("Next step");
    expect(html).not.toContain("Owner asks for direction"); // decisionSubject 로 대체한 중복 title 부제목
    expect(html).not.toContain("Long markdown body");
    // location/description 산문도 펼치지 않는다(칩 라벨만).
    expect(html).not.toContain("Issue &gt; body");
  });

  it("keeps the legacy packet rendering for cards without symptom", () => {
    const legacy: OperatorDecisionView = {
      ...compactDecision,
      definition: { ...compactDecision.definition, humanReview: { ...compactDecision.definition.humanReview!, symptom: null } },
    };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={legacy} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    // 구형 패킷은 기존 렌더링(주제/현재 해석/원본 위치)을 그대로 유지한다.
    expect(html).toContain("What is being decided?");
    expect(html).toContain("Current interpretation");
    expect(html).toContain("Evidence &amp; source location");
    expect(html).toContain("Source location");
    expect(html).toContain("Owner asks for direction"); // 부제목 복원
    // 옵션 설명은 1줄 고정 없이 원본 그대로.
    expect(html).not.toContain("line-clamp-1");
  });

  it("preserves selection, required comment, and resolve submission on the compact card", async () => {
    const onResolve = await renderCard();
    // 선택 없이 제출하면 안내가 뜨고 제출되지 않는다.
    click([...host.querySelectorAll("button")].find((button) => button.textContent === "Approve")!);
    expect(onResolve).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Select");
    // 선택 + 필수 코멘트 후 제출 — 라디오 인터랙션·resolve 계약은 그대로다.
    click(optionRow("approve"));
    expect(optionRow("approve").getAttribute("aria-checked")).toBe("true");
    const comment = host.querySelector("textarea")!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(comment, "  방향 승인  ");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => click([...host.querySelectorAll("button")].find((button) => button.textContent === "Approve")!));
    expect(onResolve).toHaveBeenCalledWith("decision-compact", {
      actionId: "approve", selectedOptionIds: ["approve"], comment: "방향 승인",
    });
  });

  it("renders the standalone compact packet branch for symptom packets", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><HumanReviewPacket packet={compactDecision.definition.humanReview!} variant="full" /></CompanyLanguageProvider>,
    );
    // HumanReviewPacket 본체도 신형 패킷을 만나면 고정 축소 레이아웃만 표시한다(하위호환 게이트: symptom 유무).
    expect(html).toContain('data-packet-layout="compact-symptom"');
    expect(html).toContain("Symptom");
    expect(html).toContain("Plain-language read");
    expect(html).toContain("Detailed evidence");
    expect(html).not.toContain("If approved");
    expect(html).not.toContain("Next step");
  });

  // [사람 카드 UI 중복 정리 08:15] 아래 3건 — 신형 축소 카드의 '쉬운 해석 (AI)' 패널 숨김·선택지 문구 1회 노출 회귀 방지.
  const doneSummary: import("../api/approvals").HumanSummaryView = {
    status: "done", adapterType: "pi_local", model: "m1",
    summary: {
      oneLine: "미션 방향 요청 해석 한 줄",
      whatHappening: "미션이 진행을 멈추고 운영자 방향을 기다리고 있습니다.",
      decisionNeeded: "운영자가 방향을 선택해야 합니다.",
      options: [], cautions: ["선택만으로 실행되지 않습니다."],
    },
    error: null, updatedAt: "2026-11-11T10:00:00.000Z",
  };

  it("hides the AI easy-summary panel on compact cards even when the server attached one", () => {
    const withSummary = { ...compactDecision, humanSummary: doneSummary } as OperatorDecisionView & { humanSummary: typeof doneSummary };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={withSummary} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    // 본문에 이미 축소 '쉬운 해석'이 있으므로 '쉬운 해석 (AI)' 패널은 이중 노출하지 않는다.
    expect(html).not.toContain("Easy summary (AI)");
    expect(html).toContain("Plain-language read");
  });

  it("keeps the AI easy-summary panel on legacy cards without symptom", () => {
    const legacy = {
      ...compactDecision,
      definition: { ...compactDecision.definition, humanReview: { ...compactDecision.definition.humanReview!, symptom: null } },
      humanSummary: doneSummary,
    } as OperatorDecisionView & { humanSummary: typeof doneSummary };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={legacy} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    expect(html).toContain("Easy summary (AI)");
    expect(html).toContain("미션 방향 요청 해석 한 줄");
  });

  it("replaces the request_input stage-1 template interpretation with a direction-only sentence and shows options once", () => {
    const templated: OperatorDecisionView = {
      ...compactDecision,
      definition: {
        ...compactDecision.definition,
        options: [
          { id: "approve", label: "Approve", description: "요청된 다음 단계를 승인합니다", facts: [], evidenceRefs: [] },
          { id: "hold", label: "Hold", description: null, facts: [], evidenceRefs: [] },
        ],
        humanReview: {
          ...compactDecision.definition.humanReview!,
          interpretation: '사람 결정(입력·승인 요청(request_input)) 요청 — 다음 단계로 "(A) 즉시 한정 재시도 1회 (B) 모델 교체 (C) 보류"의 승인 여부를 판단해 주세요.',
          recommendedNextStep: "(A) 즉시 한정 재시도 1회 (B) 모델 교체 (C) 보류",
        },
      },
    };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={templated} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    // 쉬운 해석은 방향·이유 1문장만 — 서버 템플릿·선택지 나열을 반복하지 않는다.
    expect(html).toContain("자동으로 판단할 수 없는 사항이라 운영자가 진행 방향을 정해야 다음 단계로 넘어갈 수 있습니다.");
    expect(html).not.toContain("사람 결정(입력·승인");
    expect(html).not.toContain("승인 여부를 판단해 주세요");
    // 선택지 나열은 '선택지' 영역(서버 기본 승인 설명의 1줄 다음 단계 요약)에 딱 1회만 나온다.
    expect(html).toContain("요청된 다음 단계: (A) 즉시 한정 재시도 1회 (B) 모델 교체 (C) 보류");
    expect(html.split("즉시 한정 재시도").length - 1).toBe(1);
  });

  it("replaces the escalate stage-1 template interpretation with the escalation direction sentence", () => {
    const escalated: OperatorDecisionView = {
      ...compactDecision,
      definition: {
        ...compactDecision.definition,
        options: [
          { id: "approve", label: "Approve", description: "요청된 다음 단계를 승인합니다", facts: [], evidenceRefs: [] },
          { id: "hold", label: "Hold", description: null, facts: [], evidenceRefs: [] },
        ],
        humanReview: {
          ...compactDecision.definition.humanReview!,
          decisionSubject: "미션 오너의 사람 결정 요청 — 에스컬레이션(escalate) 승인 여부",
          interpretation: "사람 결정(에스컬레이션(escalate)) 요청 — 연결된 이슈의 근거로 승인·보류·반려를 판단해 주세요.",
          recommendedNextStep: "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.",
        },
      },
    };
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en"><OperatorDecisionCard decision={escalated} onResolve={vi.fn()} /></CompanyLanguageProvider>,
    );
    expect(html).toContain("자동 진행이 막혀 운영자가 복구 방향을 정해야 미션을 계속 진행할 수 있습니다.");
    expect(html).not.toContain("연결된 이슈의 근거로");
    expect(html).not.toContain("승인·보류·반려");
    // recommendedNextStep 가 기본 폴백 문구면 선택지 설명을 바꾸지 않는다(원본 승인 설명 유지).
    expect(html).toContain("요청된 다음 단계를 승인합니다");
  });
});
