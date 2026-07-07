// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HermesOpsRunSummary } from "./HermesOpsRunSummary";

// [목적] HermesOpsRunSummary가 hermes run 식별·요약 렌더와 non-hermus 출력 억제를 올바르게 하는지 검증.
//   advice는 nested resultJson.recoveryAdvice에서만 읽는다(top-level decision 미사용).
describe("HermesOpsRunSummary", () => {
  it("renders nothing for a non-Hermes run (no hermesRunKind)", () => {
    const html = renderToStaticMarkup(
      <HermesOpsRunSummary run={{ resultJson: { result: "x" } }} />,
    );
    expect(html).toBe("");
  });

  it("renders kind + Q + A for a chat run without advice", () => {
    const html = renderToStaticMarkup(
      <HermesOpsRunSummary
        run={{
          resultJson: { hermesRunKind: "chat-sidebar", result: "최종 답변 내용" },
          contextSnapshot: { paperclipHermesChat: { currentMessage: "왜 멈췄어?" } },
        }}
      />,
    );
    expect(html).toContain("Chat · sidebar");
    expect(html).toContain("왜 멈췄어?");
    expect(html).toContain("최종 답변 내용");
    // advice 없으면 Target 라벨 미출력.
    expect(html).not.toContain("Target");
    // [peer check] logRef 없으면 raw-transcript 힌트 미출력.
    expect(html).not.toContain("raw transcript");
  });

  it("renders compact nested recovery advice and the raw-transcript hint", () => {
    const html = renderToStaticMarkup(
      <HermesOpsRunSummary
        run={{
          resultJson: {
            hermesRunKind: "chat-telegram",
            result: "최종 답변",
            recoveryAdvice: {
              missionId: "m1",
              selectedIssueId: null,
              decision: "producer_rework",
              targetIssue: { id: "p1", identifier: "RES-1076", title: "Collect evidence", role: "producer", assigneeAgentId: null },
              targetAction: "rework",
              leafCause: "missing Cloudflare source",
              evidence: [{ kind: "comment", label: "QA on RES-1077", value: "missing Cloudflare" }],
              operatorComment: "재작업 요청입니다.",
              doNot: ["QA PASS 금지"],
              missingEvidence: [],
            },
          },
          contextSnapshot: { paperclipHermesChat: { currentMessage: "blocked?" } },
          logRef: "s3://bucket/log",
        }}
      />,
    );
    expect(html).toContain("Chat · Telegram");
    expect(html).toContain("decision=producer_rework");
    expect(html).toContain("RES-1076");
    expect(html).toContain("missing Cloudflare source");
    expect(html).toContain("재작업 요청입니다.");
    expect(html).toContain("QA PASS 금지");
    expect(html).toContain("raw transcript");
  });

  it("labels monitor runs distinctly", () => {
    const html = renderToStaticMarkup(
      <HermesOpsRunSummary run={{ resultJson: { hermesRunKind: "monitor", result: "sweep done" } }} />,
    );
    expect(html).toContain("Monitor sweep");
  });
});
