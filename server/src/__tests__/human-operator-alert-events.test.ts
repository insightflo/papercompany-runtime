import { describe, expect, it, vi } from "vitest";
import {
  buildHumanOperatorRequestPayload,
  HUMAN_OPERATOR_REQUEST_ACTION,
  recordHumanOperatorRequestEvent,
} from "../services/missions/human-operator-alert-events.js";
import { buildTerminalMissionHumanOperatorComment } from "../services/missions/terminal-mission-human-operator-alert.js";

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

describe("human operator alert events", () => {
  it("builds a human request payload from owner unblock request_input comments", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      comment: requestInputComment,
    });

    expect(payload).toMatchObject({
      missionId: "mission-1",
      issueId: "owner-issue-1",
      sourceIssueId: "source-issue-1",
      commentId: "comment-1",
      decision: "request_input",
      issueIdentifier: "RES-100",
      actorType: "agent",
      actorId: "owner-agent-1",
    });
    expect(payload?.reason).toContain("Browser auth");
    expect(payload?.nextAction).toContain("reauthorize");
  });

  it("ignores non-owner-unblock issues", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: { ...ownerIssue, originKind: "mission_plan_qa" },
      comment: requestInputComment,
    });

    expect(payload).toBeNull();
  });

  it("builds a human request payload from explicit natural-language operator handoff", () => {
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

    expect(payload).toMatchObject({
      missionId: "mission-1",
      issueId: "owner-issue-1",
      commentId: "comment-human-handoff",
      decision: "request_input",
      reason: "Owner action comment names human operator as the handoff target.",
    });
    expect(payload?.nextAction).toContain("운영자 또는 상위 오너");
  });

  it("does not infer a request when human operator handoff is negated", () => {
    const payload = buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      comment: {
        id: "comment-negated",
        authorAgentId: "owner-agent-1",
        authorUserId: null,
        body: "No human operator input is required; retry is safe.",
      },
    });

    expect(payload).toBeNull();
  });

  it("records and publishes the dedicated live event once per comment", async () => {
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
      comment: requestInputComment,
    });
    const duplicate = await recordHumanOperatorRequestEvent(db as never, {
      issue: ownerIssue,
      comment: requestInputComment,
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

  it("routes the terminal-mission report comment through the same escalate payload path", () => {
    const body = buildTerminalMissionHumanOperatorComment({
      issueId: ownerIssue.id,
      issueIdentifier: ownerIssue.identifier,
      missionTitle: "Terminal failure mission",
      sourceIssueIdentifier: "RES-42",
      failedRuns: [{ id: "run-1", status: "timed_out", errorCode: "execution_stale_timeout" }],
    });

    // evidence must be bounded and must never carry raw stderr / JSON / secrets
    expect(body).not.toContain("stderr");
    expect(body).not.toContain("{");
    expect(body).not.toContain("SECRET");
    expect(body).toContain("Decision: escalate");

    const payload = buildHumanOperatorRequestPayload({
      issue: ownerIssue,
      comment: { id: "terminal-report-comment", authorAgentId: null, authorUserId: null, body },
    });

    expect(payload).toMatchObject({
      missionId: "mission-1",
      issueId: "owner-issue-1",
      sourceIssueId: "source-issue-1",
      commentId: "terminal-report-comment",
      decision: "escalate",
      actorType: "system",
    });
    expect(payload?.reason).toContain("cannot continue automatically");
    expect(payload?.evidence).toContain("continuation=none");
    expect(payload?.evidence).toContain("timed_out");
  });
});
