import { describe, expect, it } from "vitest";
import { buildTerminalMissionHumanOperatorComment } from "../services/missions/terminal-mission-human-operator-alert.js";
import { buildWorkflowReworkContract, renderWorkflowReworkComment } from "../services/workflow/control-flow/rework-contract.js";
import { buildPlanQaResultComment, buildAdoptionNotification, buildRecoveryDraft, buildTerminalCloseoutComment } from "../services/missions/system-comment-display.js";

const evidence = "REQUEST_CHANGES: fix https://example.test/a?id=1";
describe("missing system producer display paths", () => {
  it.each(["ko", "en"] as const)("PLAN-QA %s preserves verdict but does not claim final approval", (language) => {
    const pass = buildPlanQaResultComment({ language, verdict: "pass", diagnostics: [], decisionHash: "hash-1" });
    expect(pass).toContain("PASS");
    expect(pass).toContain("hash-1");
    expect(pass).toContain(language === "ko" ? "최종 승인" : "final approval");
    const rework = buildPlanQaResultComment({ language, verdict: "request_changes", diagnostics: [{ message: evidence }], decisionHash: "hash-1" });
    expect(rework).toContain(evidence);
    expect(rework).toContain(language === "ko" ? "다음 행동" : "Next action");
  });
  it.each(["ko", "en"] as const)("terminal report %s retains legacy headings and bounded evidence", (language) => {
    const body = buildTerminalMissionHumanOperatorComment({ language, issueId: "owner-1", issueIdentifier: "OWN-1", missionTitle: "mission", sourceIssueIdentifier: "SRC-1", failedRuns: [{ id: "run-1", status: "failed", errorCode: "raw-code" }] });
    for (const field of ["### Mission owner decision", "Decision: escalate", "Source issue: SRC-1", "Evidence:", "raw-code", "continuation=none"]) expect(body).toContain(field);
    expect(body).toContain(language === "ko" ? "자동으로 계속할 수 없습니다" : "cannot continue automatically");
  });
  it("Korean rework localizes wrapper without modifying contract, feedback, or references", () => {
    const contract = buildWorkflowReworkContract({ producerStepId: "producer-1", qaFeedbacks: [{ qaStepId: "qa-1", qaIssueId: "QA-1", feedback: evidence }], currentIteration: 0, maxIterations: 2, dependencyArtifacts: "/tmp/source.json", producerIssueInstruction: "raw task", producerWorkProducts: [{ title: "raw title", ref: "/tmp/output.json" }] });
    const before = JSON.stringify(contract);
    const body = renderWorkflowReworkComment(contract, "ko");
    expect(body).toContain("재작업을 요청했습니다");
    for (const raw of [evidence, "producer-1", "QA-1", "raw task", "/tmp/source.json", "/tmp/output.json"]) expect(body).toContain(raw);
    expect(JSON.stringify(contract)).toBe(before);
  });
  it.each(["ko", "en"] as const)("adoption and drafts %s preserve evidence and distinguish display from execution", (language) => {
    const adoption = buildAdoptionNotification({ language, resolvedRef: "skill://raw", operation: "replace", section: "raw section", gateOwner: "gate-1", candidateHash: "candidate-1", contentHashBefore: "before-1", contentHashAfter: "after-1", producerAgentId: "agent-1" });
    for (const raw of ["skill://raw", "gate-1", "candidate-1", "before-1", "after-1", "agent-1"]) expect(adoption).toContain(raw);
    const draft = buildRecoveryDraft({ language, kind: "producer_rework", producerLabel: "SRC-1", qaLabel: "QA-1", leafCause: evidence });
    expect(draft).toContain(evidence);
    expect(draft).toContain(language === "ko" ? "실행 요청은 아직" : "not dispatched");
    const closeout = buildTerminalCloseoutComment({ language, sourceIssueId: "SRC-1", sourceStatus: "done" });
    expect(closeout).toContain("SRC-1");
    expect(closeout).toContain(language === "ko" ? "새 실행" : "another run");
  });
});
