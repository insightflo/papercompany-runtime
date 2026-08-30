import { describe, expect, it } from "vitest";
import {
  buildMissionOwnerUnblockDescription,
  buildRetrySourceIssueComment,
  buildRetrySourceIssueWakeupDispatchedComment,
  buildRetrySourceIssueWakeupResultComment,
  buildStaleSourceIssueWakeupDispatchedComment,
  buildValidatorRetryEvidenceComment,
  extractLatestMissionOwnerDecision,
  isTerminalIssueStatus,
  summarizeOwnerDecisionNotApplied,
} from "../services/missions/mission-owner-recovery-comments.js";

describe("mission owner recovery comments", () => {
  it("extracts latest decision and formats owner action comments with markers", () => {
    const latest = extractLatestMissionOwnerDecision([
      "### Mission owner decision\nDecision: request_input\nSource issue: SRC-1\nReason: earlier",
      "### Mission owner decision\nDecision: retry_source_issue\nSource issue: SRC-2\nReason: latest",
    ]);

    expect(latest).toEqual(expect.objectContaining({
      decision: "retry_source_issue",
      sourceIssueRef: "SRC-2",
      reason: "latest",
    }));

    const retryComment = buildRetrySourceIssueComment({
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      decisionReason: "owner approved retry",
    });
    expect(retryComment).not.toContain("mission-owner-decision-applied");
    expect(retryComment).toContain("Decision: retry_source_issue");
    expect(retryComment).toContain("owner approved retry");
    expect(retryComment).not.toContain("moved the source issue back to todo");
  });
  it("bundles source title+description, active workProduct url/externalId/metadata path, and REQUEST_CHANGES", () => {
    const comment = buildRetrySourceIssueComment({
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      decisionReason: "owner approved retry",
      sourceTitle: "Distinctive source title",
      sourceInstruction: "Distinctive source description body.",
      activeWorkProducts: [
        { title: "Active note", type: "local_file", provider: "local_file", url: "https://example.test/a.md", externalId: "/artifacts/a.md", metadata: { path: "/vault/a.md" } },
        { title: "Dup path product", type: "preview_url", provider: "web", url: null, externalId: "/same.md", metadata: { path: "/same.md" } },
      ],
      requestChangesSummary: "REQUEST_CHANGES: distinctive feedback",
    });
    // title + description
    expect(comment).toContain("Original source issue instruction:");
    expect(comment).toContain("Title: Distinctive source title");
    expect(comment).toContain("Distinctive source description body.");
    // url + externalId + distinct metadata path
    expect(comment).toContain("url=https://example.test/a.md");
    expect(comment).toContain("externalId=/artifacts/a.md");
    expect(comment).toContain("path=/vault/a.md");
    // metadata path deduped when it equals externalId (no duplicate path= token)
    expect(comment).toContain("externalId=/same.md");
    expect(comment).not.toContain("path=/same.md");
    // REQUEST_CHANGES feedback
    expect(comment).toContain("Latest REQUEST_CHANGES summary:");
    expect(comment).toContain("REQUEST_CHANGES: distinctive feedback");
    // shows count of active products
    expect(comment).toContain("showing 2");
  });

  it("formats wakeup and validator recovery comments", () => {
    const wakeup = buildRetrySourceIssueWakeupDispatchedComment({
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      targetAgentId: "agent-1",
      idempotencyKey: "key-1",
    });
    expect(wakeup).toContain("mission-owner-decision-wakeup-dispatched");
    expect(wakeup).toContain("mission-owner-decision-applied");
    expect(wakeup).toContain("Target agent: agent-1");
    expect(wakeup).toContain("Idempotency key: key-1");

    const staleWakeup = buildStaleSourceIssueWakeupDispatchedComment({
      missionId: "mission-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      failedRunId: "run-1",
      failedRunStatus: "timed_out",
      targetAgentId: "agent-1",
      idempotencyKey: "stale-key-1",
    });
    expect(staleWakeup).toContain("mission-stale-source-wakeup-dispatched");
    expect(staleWakeup).toContain("Terminal heartbeat run: run-1 status=timed_out");

    const validatorEvidence = buildValidatorRetryEvidenceComment({
      sourceLabel: "SRC-1",
      childLabel: "CHILD-1",
      evidenceLines: ["artifact repaired", "tests passed"],
    });
    expect(validatorEvidence).toContain("### Validator retry evidence");
    expect(validatorEvidence).toContain("- artifact repaired");
    expect(validatorEvidence).toContain("- tests passed");
  });

  it.each(["not_requested", "failed", "skipped_no_assignee"] as const)(
    "does not render %s as applied or dispatched",
    (status) => {
      const result = buildRetrySourceIssueWakeupResultComment({
        status,
        missionId: "mission-1",
        ownerActionIssueId: "owner-1",
        ownerActionLabel: "OWN-1",
        sourceIssueId: "source-1",
        sourceLabel: "SRC-1",
        targetAgentId: "agent-1",
        idempotencyKey: "key-1",
      });
      expect(result).not.toContain("mission-owner-decision-applied");
      expect(result).not.toContain("mission-owner-decision-wakeup-dispatched");
    },
  );

  it("surfaces the fail-closed validation reason on not_requested comments and omits it when absent", () => {
    const withReason = buildRetrySourceIssueWakeupResultComment({
      status: "not_requested",
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      targetAgentId: "agent-1",
      idempotencyKey: "key-1",
      detailReason: "cap_override_no_marker",
    });
    expect(withReason).toContain("Queue result: not_requested");
    expect(withReason).toContain("Validation detail: cap_override_no_marker");

    const withoutReason = buildRetrySourceIssueWakeupResultComment({
      status: "not_requested",
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      targetAgentId: "agent-1",
      idempotencyKey: "key-1",
    });
    expect(withoutReason).not.toContain("Validation detail:");
  });

  it("formats unblock descriptions and conservative status summaries", () => {
    const description = buildMissionOwnerUnblockDescription(
      { id: "mission-1", title: "Mission" },
      {
        id: "source-1",
        identifier: "SRC-1",
        title: "Blocked source",
        status: "blocked",
        assigneeAgentId: "worker-1",
      },
      {
        governanceEvidence: ["  blocker evidence  ", ""],
        missionExecutionDigest: [
          "Mission description: Daily research workflow",
          "Workflow run: tech-ai-news status=failed",
          "Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped",
        ],
      },
    );

    expect(description).toContain("mission-owner-action");
    expect(description).toContain("Original assignee agent: worker-1");
    expect(description).toContain("Mission execution digest:");
    expect(description).toContain("- Mission description: Daily research workflow");
    expect(description).toContain("- Workflow run: tech-ai-news status=failed");
    expect(description).toContain("- Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped");
    expect(description).toContain("Main executor brief:");
    expect(description).toContain("- You own mission execution. Your goal is to complete the mission, not merely classify the alert.");
    expect(description).toContain("Mission goal: Mission");
    expect(description).toContain("Current situation: Source issue SRC-1");
    expect(description).toContain("Mission execution loop:");
    expect(description).toContain("- Choose and perform the action that best advances the mission: instruct or wake agents, request fixes, retry/resume bounded work, request/re-run tool steps, revalidate outputs, replan, escalate, or report impossible completion with evidence.");
    expect(description).toContain("Escalation/reporting line:");
    expect(description).toContain("Use the existing mission-owner decision path");
    expect(description).toContain("name the next assignee/owner `reportsTo` target");
    expect(description).toContain("The human operator is the final receiver for unresolved mission blockers.");
    expect(description).toContain("Oversight signal boundary:");
    expect(description).toContain("Oversight is not the recovery decision-maker.");
    expect(description).toContain("Do not depend on normalized decision labels as the primary control path");
    expect(description).toContain("Main executor role:");
    expect(description).toContain("Decision authority (REQUIRED control path): submit your decision through the structured API, not a comment:");
    expect(description).toContain("owner-recovery/decision");
    expect(description).toContain("- retry_source_issue");

    expect(isTerminalIssueStatus("done")).toBe(true);
    expect(isTerminalIssueStatus("cancelled")).toBe(true);
    expect(isTerminalIssueStatus("blocked")).toBe(false);
    expect(summarizeOwnerDecisionNotApplied({
      ownerActionLabel: "OWN-1",
      sourceLabel: "SRC-1",
      reason: "source already terminal",
    })).toBe("owner_action_decision_not_applied: OWN-1 retry_source_issue source=SRC-1 — source already terminal");
  });
  it("localizes user-visible prose to Korean while leaving control fields English", () => {
    const koDescription = buildMissionOwnerUnblockDescription(
      { id: "mission-1", title: "Mission" },
      {
        id: "source-1",
        identifier: "SRC-1",
        title: "Blocked source",
        status: "blocked",
        assigneeAgentId: "worker-1",
      },
      { language: "ko" },
    );
    // Prose is localized...
    expect(koDescription).toContain("오버사이트로부터 미션 오너 신호");
    expect(koDescription).toContain("이 오너 액션 템플릿에서는 사용할 수 없습니다.");
    // ...but machine-readable markers, field labels, decision codes and API paths stay English.
    expect(koDescription).toContain("<!-- mission-owner-action:");
    expect(koDescription).toContain("Source issue identifier: SRC-1");
    expect(koDescription).toContain("POST /api/issues/{this owner-action issue id}/owner-recovery/decision");
    expect(koDescription).toContain("- retry_source_issue");
    expect(koDescription).not.toContain("Mission-owner signal from oversight");

    const koRetry = buildRetrySourceIssueComment({
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      requestChangesSummary: "REQUEST_CHANGES: distinctive feedback",
      activeWorkProducts: [
        { title: "Note", type: "local_file", provider: "local_file", url: null, externalId: null, metadata: null },
      ],
      language: "ko",
    });
    expect(koRetry).toContain("### 미션 오너 재시도 요청");
    expect(koRetry).toContain("이 소스 이슈의 활성 워크프로덕트 (1개 표시):");
    expect(koRetry).toContain("Decision: retry_source_issue");
    expect(koRetry).toContain("Owner-action issue: OWN-1 (owner-1)");
    expect(koRetry).not.toContain("### Mission owner retry requested");
    // Machine-consumed label "Latest REQUEST_CHANGES summary:" must stay exactly
    // English even in ko output because supervision.ts dedup matches it verbatim.
    expect(koRetry).toContain("Latest REQUEST_CHANGES summary:");
    expect(koRetry).not.toContain("최신 REQUEST_CHANGES 요약:");
    expect(koRetry).toContain("REQUEST_CHANGES: distinctive feedback");

    // English default still produces the original strings when no language is supplied.
    const enRetry = buildRetrySourceIssueComment({
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
    });
    expect(enRetry).toContain("### Mission owner retry requested");
    expect(enRetry).toContain("Owner requested source issue retry.");
  });
});

// [관련 사고 패턴 방아쇠] 오너 언블록 서술에 카드 요약 라인(제목+id)만 주입되는지.
//   본문(symptoms/rootCause) 주입 금지 — 설계 계약(변경 3).
describe("owner unblock description related knowledge patterns section", () => {
  const mission = { id: "mission-1", title: "저녁 미션 QA 무발사" };
  const blockedIssue = {
    id: "source-1",
    identifier: "SRC-1",
    title: "QA 스텝 pending 지속",
    status: "blocked",
    assigneeAgentId: "worker-1",
  };

  it("renders title + card id summary lines and the adoption loop trigger", () => {
    const description = buildMissionOwnerUnblockDescription(mission, blockedIssue, {
      relatedKnowledgePatterns: [
        { id: "card-1", title: "구조 게이트 토큰 불일치로 QA 스텝 무발사" },
      ],
    });

    expect(description).toContain("Related incident patterns (1)");
    expect(description).toContain("- 구조 게이트 토큰 불일치로 QA 스텝 무발사 (card id: card-1)");
    expect(description).toContain("GET /api/companies/{companyId}/knowledge-patterns?q=");
    expect(description).toContain("self-improvement-adoptions/dry-run");
    expect(description).toContain("Do not hand-edit skill markdown.");
    // 본문 주입 금지 불변식 — 카드 symptoms/rootCause/whatWorked 내용은 요청하지 않는 한 없어야 한다.
    expect(description).not.toContain("이중완료");
    expect(description).not.toContain("런 running 유지");
    expect(description).not.toContain("whatWorked:");
  });

  it("renders the ruled-out alternatives guard line in the diagnosis checklist", () => {
    const description = buildMissionOwnerUnblockDescription(mission, blockedIssue, {});
    expect(description).toContain("considered and RULED OUT with evidence");
    expect(description).toContain("unanimous agreement without an explicit exclusion list");
  });

  it("omits the section entirely when no related patterns are provided", () => {
    const description = buildMissionOwnerUnblockDescription(mission, blockedIssue, {});
    expect(description).not.toContain("Related incident patterns");
    // 섹션 전용 트리거 문구(기본 체크리스트 줄에는 없는 안내)도 함께 없어야 한다.
    expect(description).not.toContain("prior structural failures in this company that may match this mission");
  });

  it("caps at 3 patterns and drops malformed entries", () => {
    const description = buildMissionOwnerUnblockDescription(mission, blockedIssue, {
      relatedKnowledgePatterns: [
        { id: "card-1", title: "하나" },
        { id: "card-2", title: "둘" },
        { id: "card-3", title: "셋" },
        { id: "card-4", title: "넷" },
        { id: "card-", title: "빈 id" },
        { id: "card-5", title: "  " },
      ],
    });
    expect(description).toContain("Related incident patterns (3)");
    expect(description).toContain("(card id: card-1)");
    expect(description).toContain("(card id: card-3)");
    expect(description).not.toContain("card-4");
    expect(description).not.toContain("card-5");
  });
});
