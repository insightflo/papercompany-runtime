import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResumePreview, ResumeRequestView } from "@paperclipai/shared/types/workflow-resume";
import { MissionResumePreviewReport } from "./MissionResumePreviewReport";
import { MissionResumeRequestStatus } from "./MissionResumeRequestStatus";

function preview(blocker: string, approvals: ResumePreview["approvals"]): ResumePreview {
  return { schemaVersion: 1, companyId: "company", missionId: "mission", workflowRunId: "run",
    startStepId: "step", eligible: false, blockers: [{ code: blocker, message: "Blocked" }],
    affected: [], preserved: [], evidence: [], generation: "possible", budget: "unknown",
    approvals, snapshotToken: null, expiresAt: null };
}

describe("resume public display semantics", () => {
  it.each(["external_effect_unknown", "historical_definition_unproven", "unsupported_graph"])(
    "%s does not promise approval-free work; known approval count takes precedence", (code) => {
      const render = (approvals: ResumePreview["approvals"]) => renderToStaticMarkup(createElement(
        MissionResumePreviewReport, { preview: preview(code, approvals), expired: false }));
      expect(render([])).toContain("필수 승인: 확정할 수 없음");
      expect(render([{ stepId: "step", required: true }])).toContain("필수 승인: 1개 단계에 필요");
    },
  );
  it("a known budget block does not invent unknown approvals", () => {
    const html = renderToStaticMarkup(createElement(MissionResumePreviewReport, {
      preview: preview("budget_exceeded", []), expired: false,
    }));
    expect(html).toContain("필수 승인: 없음");
  });

  it.each([
    ["pending_delivery", "실행기 전달 대기"], ["accepted", "실행기 전달 완료"],
    ["blocked", "차단됨"], ["cancelled", "취소됨"],
  ] as const)("canonical request %s renders without claiming work completion", (state, label) => {
    const requestView: ResumeRequestView = { id: "request", workflowRunId: "run", startStepId: "step",
      state, acceptanceId: state === "accepted" ? "durable-acceptance" : null, code: null,
      createdAt: "2026-01-01T00:00:00.000Z" };
    const html = renderToStaticMarkup(createElement(MissionResumeRequestStatus, {
      requestView, applyError: null, canRetry: false, onRetry: () => {}, requestLoading: false, requestError: null,
    }));
    expect(html).toContain(label);
    expect(html).not.toContain("실행 완료");
    if (state === "accepted") expect(html).toContain("재개 요청이 실행기에 전달되었습니다");
  });
});
