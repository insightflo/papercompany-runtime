/** @vitest-environment jsdom */
// [카드 표시 결함 2026-11-13] 실화 카드 RES-11302(matter-js) 회귀 방지 —
//   구조화 복구 '검증 메모'(재시작 범위·근거 미확인 정책 문구)는 전제 안내 블록에만 표시하고
//   ① '현재 해석' ② '다음 단계' ③ '결정 사유' 칸에서 배제한다(빈 사유 허용, "." 미리채움 없음).
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
const VERIFY_MEMO = "재시작 옵션의 범위와 근거가 현재 확인되지 않았습니다. 추천 표시만으로 전체 수집이나 처음부터 재시작할 권한을 입증하지 않습니다. 이미 수행한 작업을 보존하고 기존 오너·정책 검토 경로를 사용하세요.";
const MISSING_EVIDENCE = "오너가 제출 근거 텍스트를 남기지 않았습니다 — 이슈 본문에서 직접 확인이 필요합니다.";

// RES-11302 실화 형태 — 서버 투영 후: 해석·다음 단계는 요청자 원문 그대로, 검증 메모는
// unresolvedFacts(전제 안내)에만, '결정 사유'는 필수 → 선택으로 완화된 비축소 카드.
const verifiedDecision: OperatorDecisionView = {
  id: "decision-verifyfix",
  companyId: "company-1",
  schemaVersion: 1,
  requestKey: "moi2:1",
  status: "pending",
  priority: "high",
  interactionType: "single_select",
  title: "사람 결정 승인 요청 — 에스컬레이션(escalate)",
  description: "Long markdown body that must not expand.",
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
    comment: { mode: "optional", label: "결정 사유", placeholder: "승인·보류·반려 사유를 남겨 주세요", maxLength: 400 },
    approvedScope: [],
    forbiddenScope: [],
    humanReview: {
      schemaVersion: "human-review-v1",
      symptom: null, // 구형(비축소) 패킷 — symptom 이 없는 저장 카드
      decisionSubject: "미션 오너의 사람 결정 요청 — 에스컬레이션(escalate) 승인 여부",
      evidence: [
        { label: "오너 결정 요청(owner-action 이슈)", href: "/issues/owner-1", location: "RES-11302", description: null },
      ],
      interpretation: "자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면 미션 오너가 선택한 경로로 복구를 이어갑니다.",
      impact: { ifApproved: "승인하면 진행합니다", ifRejected: "반려하면 되돌아갑니다", ifWrong: "잘못된 단계가 실행됩니다" },
      unresolvedFacts: [MISSING_EVIDENCE, VERIFY_MEMO],
      questions: [],
      recommendedNextStep: "이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.",
      requiredReviewer: "human-operator",
    },
  },
  result: null,
  issueId: "owner-1",
  issueIdentifier: "RES-11302",
  issueTitle: "[OVERSIGHT] service-onboarding",
  missionTitle: null,
  continuationMode: "issue_current_assignee",
  requestedBy: { type: "agent", id: "agent-1" },
  resolvedByUserId: null,
  resolvedAt: null,
  cancelledAt: null,
  createdAt: "2026-11-13T12:00:00.000Z",
  updatedAt: "2026-11-13T12:00:00.000Z",
  continuation: null,
};

let host: HTMLDivElement;
let root: Root;

async function renderCard(decision: OperatorDecisionView = verifiedDecision, onResolve = vi.fn().mockResolvedValue(undefined)) {
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

describe("OperatorDecisionCard — 검증 메모 분리(RES-11302 회귀)", () => {
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

  it("검증 메모는 전제 안내 블록에만 나오고 '현재 해석'·'다음 단계'는 요청자 원문 그대로다", () => {
    const html = render(verifiedDecision);
    // ① '현재 해석' — 요청자 원문 그대로, 라벨·경고 문구가 섞이지 않는다.
    expect(html).toContain("현재 해석");
    expect(html).toContain("자동 복구가 멈춘 상태라, 아래 선택지에서 진행 방향을 고르면");
    // ② '다음 단계' — 요청자 원문 그대로.
    expect(html).toContain("다음 단계");
    expect(html).toContain("이슈 본문의 요청 근거를 확인한 뒤 승인·보류·반려 중 하나를 선택해 주세요.");
    // 오버레이 라벨·검증 메모 문구는 해석/다음 단계 영역에 나오지 않는다.
    expect(html).not.toContain("요청자가 제공한 설명");
    expect(html).not.toContain("요청자가 제시한 다음 단계");
    // 검증 메모는 전제 안내 블록에서만 보이고, 근거 미제출 폴백 문구는 안내에서 걸러진다.
    expect(html).toContain('data-testid="human-review-prerequisite-notice"');
    expect(html).toContain("재시작 옵션의 범위와 근거가 현재 확인되지 않았습니다");
    expect(html).not.toContain(MISSING_EVIDENCE);
    // 전제 안내는 '현재 해석'보다 앞(선택 전 확인)에 둔다.
    expect(html.indexOf("human-review-prerequisite-notice")).toBeLessThan(html.indexOf("현재 해석"));
  });

  it("전제 안내 블록에는 검증 메모만 보인다(근거 미제출 폴백 제외)", async () => {
    await renderCard();
    const notice = host.querySelector('[data-testid="human-review-prerequisite-notice"]');
    expect(notice?.textContent).toContain("재시작 옵션의 범위와 근거가 현재 확인되지 않았습니다");
    expect(notice?.textContent).not.toContain("오너가 제출 근거 텍스트를 남기지 않았습니다");
    // '현재 해석' 본문에 검증 메모가 섞이지 않는다 — 패킷 전체에서 메모 문구는 안내 블록 1회만.
    const packet = host.querySelector('[data-testid="human-review-packet"]')!;
    expect(packet.textContent!.split("입증하지 않습니다").length - 1).toBe(1);
  });

  it("'결정 사유' 칸은 비어 있고 미리채움 없이 빈 값으로 제출할 수 있다", async () => {
    const onResolve = await renderCard();
    const textarea = host.querySelector("textarea")!;
    // ③ 사유 칸 미리채움 금지 — 빈 값, 필수 표시 없음.
    expect(textarea.value).toBe("");
    expect(textarea.required).toBe(false);
    click(optionRow(RESTART_ID)!);
    await act(async () => click(actionButton("승인")));
    expect(onResolve).toHaveBeenCalledWith("decision-verifyfix", {
      actionId: "approve", selectedOptionIds: [RESTART_ID], comment: null,
    });
  });

  it("검증 메모가 없는 기존 카드는 안내 블록 없이 기존 렌더링을 유지한다(회귀)", () => {
    const plain: OperatorDecisionView = {
      ...verifiedDecision,
      definition: {
        ...verifiedDecision.definition,
        comment: { mode: "required", label: "결정 사유", placeholder: null, maxLength: 400 },
        humanReview: { ...verifiedDecision.definition.humanReview!, unresolvedFacts: [MISSING_EVIDENCE] },
      },
    };
    const html = render(plain);
    expect(html).not.toContain("human-review-prerequisite-notice");
    expect(html).toContain("현재 해석");
    expect(html).toContain("자동 복구가 멈춘 상태라");
  });
});
