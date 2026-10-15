// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import {
  cancellationReasonLabel,
  OperatorDecisionActivity,
  operatorDecisionStageLabel,
  requesterOutcomeStatusLabel,
} from "./OperatorDecisionActivity";

function event(action: string, details: Record<string, unknown>): ActivityEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    actorType: "user",
    actorId: "board",
    action,
    entityType: "operator_decision",
    entityId: "decision-1",
    agentId: null,
    runId: null,
    details,
    createdAt: new Date("2026-07-29T10:00:00Z"),
  };
}

describe("operator decision status labels", () => {
  it("maps card round-trip stages to approved Korean labels", () => {
    expect(operatorDecisionStageLabel("ko", "pending")).toBe("선택 대기");
    expect(operatorDecisionStageLabel("ko", "dispatching")).toBe("선택 전달 중");
    expect(operatorDecisionStageLabel("ko", "queued")).toBe("요청자 전달 대기");
    expect(operatorDecisionStageLabel("ko", "deferred")).toBe("요청자 전달 대기");
    expect(operatorDecisionStageLabel("ko", "running")).toBe("진행 중");
    expect(operatorDecisionStageLabel("ko", "blocked")).toBe("전달 실패 · 조치 필요");
    expect(operatorDecisionStageLabel("ko", "exhausted")).toBe("전달 실패 · 조치 필요");
  });

  it("keeps existing meanings for terminal statuses", () => {
    expect(operatorDecisionStageLabel("ko", "completed")).toBe("완료");
    expect(operatorDecisionStageLabel("ko", "skipped")).toBe("건너뜀");
    expect(operatorDecisionStageLabel("ko", "issue_terminal")).toBe("이슈 종결");
    expect(operatorDecisionStageLabel("ko", "cancelled")).toBe("취소됨");
    expect(operatorDecisionStageLabel("ko", "agent_unrunnable")).toBe("에이전트 실행 불가");
  });

  it("maps requester outcome statuses to approved Korean labels", () => {
    expect(requesterOutcomeStatusLabel("ko", "acknowledged")).toBe("요청자 확인");
    expect(requesterOutcomeStatusLabel("ko", "in_progress")).toBe("진행 중");
    expect(requesterOutcomeStatusLabel("ko", "completed")).toBe("처리 완료");
    expect(requesterOutcomeStatusLabel("ko", "failed")).toBe("요청자 실행 실패");
    expect(requesterOutcomeStatusLabel("ko", "not_applied")).toBe("선택 미적용(상황 변경)");
  });

  it("maps target_changed cancellation and keeps other reasons raw", () => {
    expect(cancellationReasonLabel("ko", "target_changed")).toBe("상황 변경됨 · 선택 미적용");
    expect(cancellationReasonLabel("ko", "manual_override")).toBe("manual_override");
  });
});

describe("OperatorDecisionActivity requester outcome display", () => {
  it("shows Korean requester outcome label with raw reason for outcome_reported", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.outcome_reported", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          requesterAgentId: "agent-1",
          status: "failed",
          reason: "requester_unavailable",
          detail: "verbose free-text detail",
          reportedAt: "2026-07-29T10:05:00Z",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("요청자 결과 회신됨");
    expect(html).toContain("요청자 실행 실패");
    expect(html).toContain("requester_unavailable");
  });

  it("shows completed outcome label when requester finished the work", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.outcome_reported", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          requesterAgentId: "agent-1",
          status: "completed",
          reportedAt: "2026-07-29T10:05:00Z",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("처리 완료");
  });

  it("shows the Korean cancellation phrase for target_changed", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.cancelled", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          cancelledByActorType: "user",
          cancelledByActorId: "operator-sweep",
          cancelledAt: "2026-07-29T10:05:00Z",
          reason: "target_changed",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("결정 카드 취소됨");
    expect(html).toContain("상황 변경됨 · 선택 미적용");
    expect(html).toContain("operator-sweep");
  });

  it("shows raw text for non-target cancellation reasons", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.cancelled", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          cancelledByActorType: "user",
          cancelledByActorId: "board",
          cancelledAt: "2026-07-29T10:05:00Z",
          reason: "superseded_by_new_card",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("superseded_by_new_card");
    expect(html).not.toContain("상황 변경됨");
  });

  it("uses the round-trip stage label for continuation effective status", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.continuation_blocked", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          continuationId: "continuation-1",
          generation: 1,
          attempt: 2,
          targetAgentId: "agent-1",
          wakeupRequestId: null,
          effectiveStatus: "blocked",
          errorCode: "requester_unavailable",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("전달 실패 · 조치 필요");
    expect(html).toContain("requester_unavailable");
    expect(html).toContain("재시도 회차 1");
  });

  it("labels running continuations as in progress", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <OperatorDecisionActivity event={event("operator_decision.continuation_accepted", {
          schemaVersion: 1,
          operatorDecisionId: "decision-1",
          continuationId: "continuation-1",
          generation: 1,
          attempt: 1,
          effectiveStatus: "running",
        })} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("진행 중");
  });
});

describe("OperatorDecisionActivity", () => {
  it("projects only the exact structured resolved fields", () => {
    const html = renderToStaticMarkup(<OperatorDecisionActivity event={event("operator_decision.resolved", {
      schemaVersion: 1,
      operatorDecisionId: "decision-1",
      actionId: "choose",
      outcome: "submit",
      selectedOptionIds: ["candidate-1"],
      commentPresent: true,
      resolvedByUserId: "board",
      resolvedAt: "2026-07-29T10:00:00Z",
      issueId: "issue-1",
      continuationId: "continuation-1",
      comment: "secret raw comment",
      errorSummary: "private adapter error",
      sourcePayload: "unrestricted",
    })} />);
    expect(html).toContain("choose");
    expect(html).toContain("submit");
    expect(html).toContain("candidate-1");
    expect(html).toContain("Comment provided");
    expect(html).not.toContain("secret raw comment");
    expect(html).not.toContain("private adapter error");
    expect(html).not.toContain("unrestricted");
  });

  it("renders continuation effective status and safe error code", () => {
    const html = renderToStaticMarkup(<OperatorDecisionActivity event={event("operator_decision.continuation_blocked", {
      schemaVersion: 1,
      operatorDecisionId: "decision-1",
      continuationId: "continuation-1",
      generation: 1,
      attempt: 2,
      targetAgentId: "agent-1",
      wakeupRequestId: null,
      effectiveStatus: "blocked",
      errorCode: "issue_unassigned",
    })} />);
    expect(html).toContain("Continuation blocked");
    expect(html).toContain("issue_unassigned");
    expect(html).toContain("Generation 1");
    expect(html).toContain("attempt 2");
  });
});
