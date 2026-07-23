import { describe, expect, it, vi } from "vitest";
import {
  buildHumanOperatorRequestPayload,
  HUMAN_OPERATOR_REQUEST_ACTION,
  materializeHumanOperatorRequestPayload,
  recordHumanOperatorRequestEvent,
} from "../services/missions/human-operator-alert-events.js";

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn((event) => event),
}));

const ownerIssue = {
  id: "owner-issue-1",
  companyId: "company-1",
  missionId: "mission-1",
  originKind: "mission_main_executor_unblock",
  originId: "source-issue-1",
  title: "Recover blocked source",
  identifier: "RES-100",
};

const requestInputComment = {
  id: "comment-1",
  authorAgentId: "owner-agent-1",
  authorUserId: null,
  body: [
    "### Mission owner decision",
    "Decision: request_input",
    "Reason: Browser auth is required.",
    "Next Action: Human operator should reauthorize the session.",
    "Evidence: redirect to login page",
  ].join("\n"),
};

const requestInputDecision = {
  decision: "request_input" as const,
  reason: "Browser auth is required.",
  nextAction: "Human operator should reauthorize the session.",
  evidence: "redirect to login page",
};

const requestInputRecord = {
  eventId: "decision-event-1",
  commentId: "comment-1",
  authorAgentId: "owner-agent-1",
};

describe("human operator alert events", () => {
  it("builds a human request payload from a structured owner decision record", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      record: { ...requestInputRecord, decision: requestInputDecision },
    });

    expect(payload).toMatchObject({
      missionId: "mission-1",
      issueId: "owner-issue-1",
      sourceIssueId: "source-issue-1",
      commentId: "comment-1",
      decisionEventId: "decision-event-1",
      decision: "request_input",
      issueIdentifier: "RES-100",
      actorType: "agent",
      actorId: "owner-agent-1",
    });
    expect(payload?.reason).toContain("Browser auth");
    expect(payload?.nextAction).toContain("reauthorize");
  });
  it("fails closed when a structured decision has no proven record author", () => {
    expect(buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      decision: requestInputDecision,
    })).toBeNull();
  });

  it("ignores non-owner-unblock issues", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: { ...ownerIssue, originKind: "mission_plan_qa" },
      decision: requestInputDecision,
      record: requestInputRecord,
    });

    expect(payload).toBeNull();
  });

  it("does not infer a request from a human operator reportsTo comment", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      comment: {
        id: "comment-human-handoff",
        authorAgentId: "owner-agent-1",
        authorUserId: null,
        body: [
          "## 상태",
          "복구 보류. 안전한 재처리를 위한 원본 소스 파일이 누락되었습니다.",
          "다음 조치: 운영자 또는 상위 오너가 원본 source draft 위치를 확인해야 합니다. reportsTo 대상은 human operator 입니다.",
        ].join("\n"),
      },
    });

    expect(payload).toBeNull();
  });

  it("does not parse a formatted decision comment without a structured decision", () => {
    expect(buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      comment: requestInputComment,
    })).toBeNull();
  });

  it("records and publishes the dedicated live event once per structured decision", async () => {
    const liveEvents = await import("../services/live-events.js");
    const rows: Array<{ id: string; details: Record<string, unknown> }> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
      insert: () => ({
        values: (value: { action: string; details: Record<string, unknown> }) => {
          rows.push({ id: `activity-${rows.length + 1}`, details: value.details });
          expect(value.action).toBe(HUMAN_OPERATOR_REQUEST_ACTION);
          return Promise.resolve();
        },
      }),
    };

    const payload = await recordHumanOperatorRequestEvent(db as never, {
      issue: ownerIssue,
      decision: requestInputDecision,
      record: requestInputRecord,
    });
    const duplicate = await recordHumanOperatorRequestEvent(db as never, {
      issue: ownerIssue,
      decision: requestInputDecision,
      record: requestInputRecord,
    });

    expect(payload?.decision).toBe("request_input");
    expect(duplicate?.decision).toBe("request_input");
    expect(rows).toHaveLength(1);
    expect(liveEvents.publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      type: "mission.human_input_requested",
      payload: expect.objectContaining({ issueId: "owner-issue-1" }),
    }));
    expect(liveEvents.publishLiveEvent).toHaveBeenCalledTimes(1);
  });
  it("persists a terminal system report with its exact workflow transition event id", async () => {
    const rows: Array<{ id: string; details: Record<string, unknown> }> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
      insert: () => ({
        values: (value: { details: Record<string, unknown> }) => {
          rows.push({ id: `activity-${rows.length + 1}`, details: value.details });
          return Promise.resolve();
        },
      }),
    };
    const terminalPayload = {
      missionId: "mission-1",
      issueId: "owner-issue-1",
      decisionEventId: "terminal-transition-event-1",
      decision: "escalate" as const,
      reason: "Automatic continuation is exhausted.",
      actorType: "system" as const,
      actorId: "system",
    };

    const recorded = await materializeHumanOperatorRequestPayload(db as never, terminalPayload, "company-1");
    const duplicate = await materializeHumanOperatorRequestPayload(db as never, terminalPayload, "company-1");

    expect(recorded).toMatchObject({ inserted: true, payload: { decisionEventId: "terminal-transition-event-1" } });
    expect(duplicate).toMatchObject({ inserted: false, payload: { decisionEventId: "terminal-transition-event-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details.decisionEventId).toBe("terminal-transition-event-1");
  });

});
