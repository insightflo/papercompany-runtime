import { describe, expect, it } from "vitest";
import {
  classifyRecoveryRole,
  resolveMissionRecoveryAdvice,
  type CommentForAdvice,
  type IssueForAdvice,
} from "../services/missions/mission-recovery-advice.js";

// [목적] resolveMissionRecoveryAdvice(pure)가 RES-1076/1077/1075 형태 케이스에서
//   "QA REQUEST_CHANGES → producer rework"를 leaf cause와 함께 올바르게 처방하는지 검증.
//   DB loader(getMissionRecoveryAdvice)는 얇은 쿼리 레이어라 pure 분기로 커버.

const T0 = new Date("2026-07-07T00:00:00Z");
const T1 = new Date("2026-07-07T01:00:00Z");
const T2 = new Date("2026-07-07T02:00:00Z");

function makeProducer(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "p-1076",
    identifier: "RES-1076",
    title: "Collect bounded TechCrunch AI evidence",
    status: "done",
    originKind: "workflow_execution",
    originId: null,
    assigneeAgentId: "agent-producer",
    updatedAt: T0,
    ...overrides,
  };
}

function makeQa(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "q-1077",
    identifier: "RES-1077",
    title: "Audit source coverage and confidence",
    status: "done",
    // plan-level QA originKind. QA signal 스캔은 이 originKind의 이슈로 제한된다.
    originKind: "mission_plan_qa",
    originId: "p-1076",
    assigneeAgentId: "agent-qa",
    updatedAt: T1,
    ...overrides,
  };
}

function makeOversight(overrides: Partial<IssueForAdvice> = {}): IssueForAdvice {
  return {
    id: "o-1075",
    identifier: "RES-1075",
    title: "mission owner oversight",
    status: "todo",
    originKind: "mission_main_executor_oversight",
    originId: null,
    assigneeAgentId: null,
    updatedAt: T0,
    ...overrides,
  };
}

function requestChangesComment(overrides: Partial<CommentForAdvice> = {}): CommentForAdvice {
  return {
    id: "c-1",
    issueId: "q-1077",
    body: "REQUEST_CHANGES: missing TechCrunch AI category sources including Cloudflare, Gemini Spark, and Meta Pocket.",
    createdAt: T1,
    ...overrides,
  };
}

describe("classifyRecoveryRole", () => {
  it("maps originKind to producer/qa/oversight/planning", () => {
    expect(classifyRecoveryRole("mission_plan_qa")).toBe("qa");
    expect(classifyRecoveryRole("mission_main_executor_oversight")).toBe("oversight");
    expect(classifyRecoveryRole("mission_main_executor_unblock")).toBe("oversight");
    expect(classifyRecoveryRole("mission_main_executor_plan")).toBe("planning");
    expect(classifyRecoveryRole("workflow_execution")).toBe("producer");
    expect(classifyRecoveryRole("manual")).toBe("producer");
  });
});

describe("resolveMissionRecoveryAdvice", () => {
  it("QA REQUEST_CHANGES + producer not yet reworked → producer_rework with leaf cause + paste-ready comment", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer(), makeQa(), makeOversight()],
      comments: [requestChangesComment()],
      runs: [],
    });

    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.id).toBe("p-1076");
    expect(advice.targetIssue?.identifier).toBe("RES-1076");
    expect(advice.targetAction).toBe("rework");
    // [주의] QA가 지적한 leaf cause가 REQUEST_CHANGES 요약에서 추출돼야(peer 요구: leaf cause).
    expect(advice.leafCause).toContain("Cloudflare");
    expect(advice.leafCause).toContain("Meta Pocket");
    expect(advice.operatorComment).toBeTruthy();
    expect(advice.operatorComment).toContain("재작업");
    expect(advice.operatorComment).toContain("RES-1076");
    // doNot에 denylist 안내가 있어야(brief·guard operational 일치).
    expect(advice.doNot.some((d) => d.includes("hermes_ops_mutation_forbidden"))).toBe(true);
  });

  it("producer reworked AFTER QA request → qa_recheck targeting the QA issue", () => {
    // producer updatedAt T2 > QA 요청 T1 → producer가 이미 손댐 → QA 재검.
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ updatedAt: T2 }), makeQa(), makeOversight()],
      comments: [requestChangesComment()],
      runs: [],
    });

    expect(advice.decision).toBe("qa_recheck");
    expect(advice.targetIssue?.id).toBe("q-1077");
    expect(advice.targetAction).toBe("qa_recheck");
    expect(advice.operatorComment).toContain("QA 재검");
  });

  it("QA originId that resolves to no known issue → supervision_run with missingEvidence (no fabricated producer)", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeQa({ originId: "ghost-producer-id" }), makeOversight()],
      comments: [requestChangesComment()],
      runs: [],
    });

    expect(advice.decision).toBe("supervision_run");
    expect(advice.targetAction).toBe("supervision_run");
    expect(advice.missingEvidence.length).toBeGreaterThan(0);
    expect(advice.operatorComment).toBeNull();
  });

  it("no REQUEST_CHANGES + stuck issue with no active run → supervision_run", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "in_progress", originId: null }), makeOversight()],
      comments: [],
      runs: [],
    });

    expect(advice.decision).toBe("supervision_run");
    expect(advice.targetIssue?.id).toBe("p-1076");
    expect(advice.leafCause).toContain("활성 heartbeat 런이 없습니다");
  });

  it("no REQUEST_CHANGES + no stuck issue → human_operator (does not fabricate a verdict)", () => {
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "done" }), makeOversight({ status: "done" })],
      comments: [],
      runs: [],
    });

    expect(advice.decision).toBe("human_operator");
    expect(advice.targetIssue).toBeNull();
    expect(advice.missingEvidence.length).toBeGreaterThan(0);
  });

  // [peer review fix — 회귀 가드] producer/oversight/unblock 댓글에 REQUEST_CHANGES가 있어도
  //   QA signal로 오판하면 안 된다. QA-role 이슈(mission_plan_qa)에서만 판정.
  it("REQUEST_CHANGES on a non-QA (producer) issue is ignored — never fabricates producer_rework", () => {
    const producerComment: CommentForAdvice = {
      id: "c-prod",
      issueId: "p-1076",
      body: "REQUEST_CHANGES: 이 producer 댓글의 문자열은 QA verdict로 취급되면 안 됩니다.",
      createdAt: T1,
    };
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "in_progress", originId: null }), makeOversight()],
      comments: [producerComment],
      runs: [],
    });

    expect(advice.decision).not.toBe("producer_rework");
    // producer 가 in_progress 인데 활성 런이 없으므로 supervision_run으로 fall-through.
    expect(advice.decision).toBe("supervision_run");
  });

  it("REQUEST_CHANGES on an oversight/unblock issue is ignored too", () => {
    const oversightComment: CommentForAdvice = {
      id: "c-oversight",
      issueId: "o-1075",
      body: "REQUEST_CHANGES: oversight 메모 — QA verdict 아님.",
      createdAt: T1,
    };
    const advice = resolveMissionRecoveryAdvice({
      missionId: "m-1",
      issues: [makeProducer({ status: "done" }), makeOversight({ status: "todo" })],
      comments: [oversightComment],
      runs: [],
    });

    expect(advice.decision).not.toBe("producer_rework");
    // oversight 가 todo(활성)인데 활성 런 없음 → supervision_run.
    expect(advice.decision).toBe("supervision_run");
  });
});
