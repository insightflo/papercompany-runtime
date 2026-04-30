import { describe, expect, it } from "vitest";
import { maintenanceDecisionService } from "../services/maintenance/decision-service.js";

const baseIssue = {
  id: "issue-1",
  title: "Printer kiosk problem",
  description: "",
  status: "todo",
};

describe("maintenanceDecisionService.evaluateIssue", () => {
  it("requests missing input when affected system, symptom, and time window are absent", () => {
    const result = maintenanceDecisionService.evaluateIssue({
      issue: {
        ...baseIssue,
        title: "장애 확인 요청",
        description: "처리 부탁드립니다.",
      },
    });

    expect(result.recommendedNextAction).toBe("request_missing_input");
    expect(result.suggestedStatus).toBe("blocked");
    expect(result.requiredInputs).toEqual(["affectedSystem", "symptom", "timeWindow"]);
    expect(result.matchedRules.map((rule) => rule.action)).toContain("request_missing_input");
  });

  it("escalates incidents when the issue explicitly describes customer impact or outage", () => {
    const result = maintenanceDecisionService.evaluateIssue({
      issue: {
        ...baseIssue,
        title: "고객 결제 서비스 장애",
        description: "전체 매장에서 고객 결제가 불가한 outage 상황입니다. 즉시 확인 필요.",
      },
    });

    expect(result.recommendedNextAction).toBe("escalate_incident");
    expect(result.suggestedStatus).toBe("in_progress");
    expect(result.matchedRules.map((rule) => rule.action)).toContain("escalate_incident");
  });

  it("recommends vendor handoff when an external or vendor dependency is explicit", () => {
    const result = maintenanceDecisionService.evaluateIssue({
      issue: {
        ...baseIssue,
        title: "PG사 응답 오류",
        description: "외부 벤더 API timeout이 반복됩니다. 벤더 확인 및 전달 자료가 필요합니다.",
      },
    });

    expect(result.recommendedNextAction).toBe("vendor_handoff");
    expect(result.handoffTarget).toBe("vendor");
    expect(result.matchedRules.map((rule) => rule.action)).toContain("vendor_handoff");
  });

  it("warns to verify before close when done is attempted without evidence", () => {
    const result = maintenanceDecisionService.evaluateIssue({
      issue: {
        ...baseIssue,
        title: "프린터 용지 걸림 조치 완료",
        description: "프린터 용지 걸림을 조치했습니다.",
        status: "done",
      },
    });

    expect(result.recommendedNextAction).toBe("verify_and_close");
    expect(result.suggestedStatus).toBe("in_review");
    expect(result.warnings).toContain("completion_evidence_missing");
    expect(result.matchedRules.map((rule) => rule.action)).toContain("verify_and_close");
  });
});
