/** @vitest-environment jsdom */
// [카드 UX 핫픽스 2026-11-13] 실제 카드 7cf2aaf7 회귀 방지 —
//   ① 해석 파생 실패·빈 해석이면 최소 폴백 문장 + '쉬운 해석 (AI)' 패널 복귀
//   ② 저장된 영어 증상도 한국어 완결로 정규화해 표시(원문은 근거 링크)
//   ③ 재시작 등 실제 행동 옵션만 주 선택지 — 승인/보류/반려 형식 옵션은 액션 버튼이 담당.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { OperatorDecisionCard } from "./OperatorDecisionCard";
import { CompanyLanguageProvider } from "../lib/companyLanguage";

vi.mock("../lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

const RESTART_ID = "restart-workflow-from-start";

// 7cf2aaf7 형태 — 재시작 옵션 + 승인/보류/반려 형식 옵션·액션이 공존하는 기본 정의 카드.
const overlapDecision: OperatorDecisionView = {
  id: "decision-overlap",
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
  sourceContext: { missionId: "mission-1", workflowId: null, workflowRunId: "run-1", artifactRefs: [] },
  definition: {
    options: [
      { id: RESTART_ID, label: "처음부터 새 실행 시작", description: "실패한 실행을 처음부터 다시 시작합니다", facts: [], evidenceRefs: [] },
      { id: "approve", label: "승인", description: "요청된 다음 단계를 승인합니다", facts: [], evidenceRefs: [] },
      { id: "hold", label: "보류", description: null, facts: [], evidenceRefs: [] },
      { id: "reject", label: "반려", description: null, facts: [], evidenceRefs: [] },
    ],
    actions: [
      { id: "approve", label: "승인", outcome: "approve", tone: "primary", requiresSelection: true },
      { id: "hold", label: "보류", outcome: "hold", tone: "neutral", requiresSelection: true },
      { id: "reject", label: "반려", outcome: "reject", tone: "danger", requiresSelection: true },
    ],
    selection: { min: 1, max: 1 },
    comment: { mode: "required", label: "메모", placeholder: null, maxLength: 400 },
    approvedScope: [],
    forbiddenScope: [],
    humanReview: {
      schemaVersion: "human-review-v1",
      symptom: "자동 복구가 12시간 멈췄습니다\n오너가 운영자 결정을 요청했습니다",
      decisionSubject: "미션 오너의 사람 결정 요청 — 에스컬레이션(escalate) 승인 여부",
      evidence: [
        { label: "Owner issue", href: "/issues/owner-1", location: "Issue > body", description: null },
      ],
      interpretation: "자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면 미션 오너가 선택한 경로로 복구를 이어갑니다.",
      impact: { ifApproved: "승인하면 진행합니다", ifRejected: "반려하면 되돌아갑니다", ifWrong: "잘못된 단계가 실행됩니다" },
      unresolvedFacts: [], questions: [], recommendedNextStep: "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.", requiredReviewer: "human-operator",
    },
  },
  result: null,
  issueId: "owner-1",
  issueIdentifier: "RES-11217",
  issueTitle: "concept-radar stuck",
  missionTitle: null,
  continuationMode: "issue_current_assignee",
  requestedBy: { type: "agent", id: "agent-1" },
  resolvedByUserId: null,
  resolvedAt: null,
  cancelledAt: null,
  createdAt: "2026-11-12T22:36:00.000Z",
  updatedAt: "2026-11-12T22:36:00.000Z",
  continuation: null,
};

const doneSummary: import("../api/approvals").HumanSummaryView = {
  status: "done", adapterType: "pi_local", model: "m1",
  summary: {
    oneLine: "미션 방향 요청 해석 한 줄",
    whatHappening: "미션이 진행을 멈추고 운영자 방향을 기다리고 있습니다.",
    decisionNeeded: "운영자가 방향을 선택해야 합니다.",
    options: [], cautions: [],
  },
  error: null, updatedAt: "2026-11-12T22:40:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

async function renderCard(decision: OperatorDecisionView, onResolve = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => {
    root.render(<CompanyLanguageProvider language="ko"><OperatorDecisionCard decision={decision} onResolve={onResolve} /></CompanyLanguageProvider>);
  });
  return onResolve;
}

function render(decision: OperatorDecisionView) {
  return renderToStaticMarkup(
    <CompanyLanguageProvider language="ko"><OperatorDecisionCard decision={decision} onResolve={vi.fn()} /></CompanyLanguageProvider>,
  );
}

function click(element: Element) {
  act(() => (element as HTMLElement).click());
}

const optionRow = (id: string) => host.querySelector(`[data-operator-decision-option="${id}"]`);
const actionButton = (label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;
function typeComment(value: string) {
  const comment = host.querySelector("textarea")!;
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(comment, value);
    comment.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("OperatorDecisionCard hotfix — 선택지 겹침(7cf2aaf7 회귀)", () => {
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

  it("주 선택지에는 실제 행동 옵션(재시작)만 표시하고 승인/보류/반려 형식 옵션은 나열하지 않는다", () => {
    const html = render(overlapDecision);
    // 실제 행동 옵션만 1개 표시 — 형식 옵션은 행으로 나오지 않는다.
    expect(html).toContain(`data-operator-decision-option="${RESTART_ID}"`);
    expect(html).not.toContain('data-operator-decision-option="approve"');
    expect(html).not.toContain('data-operator-decision-option="hold"');
    expect(html).not.toContain('data-operator-decision-option="reject"');
    // 형식 옵션은 액션 버튼으로는 여전히 존재한다(별도 보조 액션).
    expect(html).toContain(">승인<");
    expect(html).toContain(">보류<");
    expect(html).toContain(">반려<");
  });

  it("재시작 선택 + 승인 버튼은 approve + [재시작] 을 제출한다(직접 재시작 계약 유지)", async () => {
    const onResolve = await renderCard(overlapDecision);
    click(optionRow(RESTART_ID)!);
    typeComment("확인 후 재시작");
    await act(async () => click(actionButton("승인")));
    expect(onResolve).toHaveBeenCalledWith("decision-overlap", {
      actionId: "approve", selectedOptionIds: [RESTART_ID], comment: "확인 후 재시작",
    });
  });

  it("보류·반려 버튼은 선택 없이 눌러도 동일 id 형식 옵션을 자동 선택해 제출한다", async () => {
    const onResolve = await renderCard(overlapDecision);
    typeComment("내일 크론 결과를 본다");
    await act(async () => click(actionButton("보류")));
    expect(onResolve).toHaveBeenCalledWith("decision-overlap", {
      actionId: "hold", selectedOptionIds: ["hold"], comment: "내일 크론 결과를 본다",
    });
  });

  it("승인 버튼만 눌러도 '승인' 형식 옵션을 자동 선택해 제출한다(클래식 승인 계약)", async () => {
    const onResolve = await renderCard(overlapDecision);
    typeComment("다음 단계 진행");
    await act(async () => click(actionButton("승인")));
    expect(onResolve).toHaveBeenCalledWith("decision-overlap", {
      actionId: "approve", selectedOptionIds: ["approve"], comment: "다음 단계 진행",
    });
  });

  it("형식 옵션이 실제 옵션 없이만 있는 카드는 기존 목록을 유지한다(회귀 없음)", () => {
    const formatOnly: OperatorDecisionView = {
      ...overlapDecision,
      definition: {
        ...overlapDecision.definition,
        options: overlapDecision.definition.options.slice(1), // approve/hold/reject 만
      },
    };
    const html = render(formatOnly);
    expect(html).toContain('data-operator-decision-option="approve"');
    expect(html).toContain('data-operator-decision-option="hold"');
    expect(html).toContain('data-operator-decision-option="reject"');
  });
});

describe("OperatorDecisionCard hotfix — 해석 비면 금지·AI 패널 조건부", () => {
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

  it("실제 해석 문장이 있으면 AI 패널을 숨기고 해석을 표시한다", () => {
    const withSummary = { ...overlapDecision, humanSummary: doneSummary } as OperatorDecisionView;
    const html = render(withSummary);
    expect(html).toContain("자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면");
    expect(html).not.toContain("Easy summary");
    expect(html).not.toContain("쉬운 해석 (AI)");
  });

  it("해석이 빈 문자열이면 최소 폴백 문장을 표시하고 AI 패널을 다시 노출한다", () => {
    const empty: OperatorDecisionView = {
      ...overlapDecision,
      humanSummary: doneSummary,
      definition: {
        ...overlapDecision.definition,
        humanReview: { ...overlapDecision.definition.humanReview!, interpretation: "   " },
      },
    } as OperatorDecisionView;
    const html = render(empty);
    // '무엇이 막혔고 무엇을 고르면 어떻게 되는지' 최소 폴백 문장 — 해석 칸이 비지 않는다.
    expect(html).toContain("자동 진행이 멈춰 사람의 방향 선택이 필요합니다");
    expect(html).toContain("쉬운 해석 (AI)");
  });

  it("권고 오버레이 해석(라벨+문장+경고 단락)은 첫 문장을 그대로 보여주고 경고를 연하게 표시한다", () => {
    const overlaid: OperatorDecisionView = {
      ...overlapDecision,
      definition: {
        ...overlapDecision.definition,
        humanReview: {
          ...overlapDecision.definition.humanReview!,
          interpretation:
            "요청자가 제공한 설명(비권위적이며 실행 권한을 부여하지 않습니다): 자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면 미션 오너가 선택한 경로로 복구를 이어갑니다.\n\n재시작 옵션의 범위와 근거가 현재 확인되지 않았습니다. 추천 표시만으로 전체 수집이나 처음부터 재시작할 권한을 입증하지 않습니다. 이미 수행한 작업을 보존하고 기존 오너·정책 검토 경로를 사용하세요.",
        },
      },
    };
    const html = render(overlaid);
    // 첫 줄(라벨+실제 해석 문장)이 통째로 보인다 — 라벨만 덩그러니 뜨지 않는다.
    expect(html).toContain("자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면");
    // 권고 경고는 안내로 계속 보인다.
    expect(html).toContain('data-testid="human-review-interpretation-notice"');
    expect(html).toContain("입증하지 않습니다");
  });
});

describe("OperatorDecisionCard hotfix — 증상 한국어 완결", () => {
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

  it("구 저장 카드의 영어 증상도 잘린 채 보여주지 않고 한국어 상태+근거 안내로 정규화한다", () => {
    const englishSymptom: OperatorDecisionView = {
      ...overlapDecision,
      definition: {
        ...overlapDecision.definition,
        humanReview: {
          ...overlapDecision.definition.humanReview!,
          symptom: "Auto-recovery has been stuck for over 12 hours. Operator decis",
        },
      },
    };
    const html = render(englishSymptom);
    // 영어 원문의 잘린 조각이 표시되지 않는다.
    expect(html).not.toContain("Auto-recovery");
    expect(html).not.toContain("Operator decis");
    expect(html).toContain("미션 진행이 멈춰 오너가 사람의 방향 결정을 요청했습니다");
    expect(html).toContain("이슈 링크 본문에서 확인해 주세요");
    // 원문 확인 경로(근거 링크)는 여전히 존재한다.
    expect(html).toContain('href="/issues/owner-1"');
  });

  it("한국어 증상은 기존처럼 그대로 표시된다(회귀 없음)", () => {
    const html = render(overlapDecision);
    expect(html).toContain("자동 복구가 12시간 멈췄습니다");
    expect(html).toContain("오너가 운영자 결정을 요청했습니다");
  });
});
