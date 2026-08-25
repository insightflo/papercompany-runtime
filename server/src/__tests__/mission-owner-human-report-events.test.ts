import { describe, expect, it } from "vitest";
import { missionOwnerHumanReportEvents } from "../services/missions/mission-owner-human-report-events.js";

function decisionInput(overrides: Partial<Parameters<typeof missionOwnerHumanReportEvents>[0]["decisions"]> = {}) {
  return [{
    companyId: "company-1",
    issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f",
    eventId: "13e3e73b-46ca-447b-940d-f9f64e6714fa",
    createdAt: "2026-08-25T00:00:00.000Z",
    authorAgentId: "5e39d835-81fd-4b0f-ab0b-3d7a80f0491f",
    decision: {
      decision: "escalate" as const,
      reason: "The accepted reassign_source_issue event 423304dd-9f5b-4c88-b4c5-7c17d67865ab did not materialize.",
      nextAction: "Assign the source issue to the idle research agent and dispatch its wakeup.",
      evidence: "source=RES-3637 status=blocked",
    },
    ...overrides,
  }];
}

describe("missionOwnerHumanReportEvents summary formatting", () => {
  it("renders a Korean structured summary instead of a joined prose blob", () => {
    const events = missionOwnerHumanReportEvents({
      missionId: "fc67cee7-814e-4663-9c9a-5b2136f6fa4d",
      issueIds: new Set(["c70bc2a9-b34a-4ee5-960d-2dbc1605e01f"]),
      decisions: decisionInput(),
    });

    expect(events).toHaveLength(1);
    const summary = events[0]!.summary;
    const lines = summary.split("\n");
    expect(lines[0]).toMatch(/^무엇이: /);
    expect(lines[0]).toContain("이슈 (c70bc2a9)");
    expect(lines[1]).toMatch(/^왜 막힘: /);
    expect(lines[1]).toContain("did not materialize.");
    expect(lines[1]).toContain("423304dd");
    expect(lines[1]).not.toContain("423304dd-9f5b-4c88-b4c5-7c17d67865ab");
    expect(lines[2]).toMatch(/^운영자 할 일: /);
    expect(lines[2]).toContain("Assign the source issue");
    expect(lines[3]).toMatch(/^근거: /);
    expect(lines[3]).toContain("source=RES-3637");
    // title(영문 라벨)은 유지되되 summary 가 이를 반복하지 않는다(이중 제목 방지).
    expect(events[0]!.title).toBe("Mission blocker escalated");
    expect(summary).not.toContain("Mission blocker escalated:");
  });

  it("keeps the request_input title and attention severity", () => {
    const events = missionOwnerHumanReportEvents({
      missionId: "mission-1",
      issueIds: new Set(["c70bc2a9-b34a-4ee5-960d-2dbc1605e01f"]),
      decisions: [{
        ...decisionInput()[0],
        decision: {
          decision: "request_input" as const,
          reason: "Operator guidance is required before continuing.",
        },
      }],
    });

    expect(events[0]!.title).toBe("Human/operator input requested");
    expect(events[0]!.severity).toBe("attention");
    expect(events[0]!.summary).toContain("왜 막힘: Operator guidance is required before continuing.");
  });

  it("falls back to a Korean default when no fields are present", () => {
    const events = missionOwnerHumanReportEvents({
      missionId: "mission-1",
      issueIds: new Set(["c70bc2a9-b34a-4ee5-960d-2dbc1605e01f"]),
      decisions: [{
        ...decisionInput()[0],
        decision: { decision: "escalate" as const },
      }],
    });

    const lines = events[0]!.summary.split("\n");
    expect(lines[1]).toBe("왜 막힘: (사유 기록 없음)");
    expect(lines[2]).toContain("재시도");
    expect(lines).toHaveLength(3);
  });
});
