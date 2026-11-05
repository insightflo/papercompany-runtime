import type { heartbeatRuns, missions, issues } from "@paperclipai/db";
import { buildMainExecutorBrief } from "./missions/mission-owner-recovery-comments.js";
import { runText } from "./heartbeat-run-presentation.js";

export type RequestChangesVerdict = {
  excerpt: string;
};

export function buildRequestChangesValidationGateComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  verdict: RequestChangesVerdict;
}) {
  return [
    "## Mission validation gate: REQUEST_CHANGES",
    `- 실행 runId: \`${input.run.id}\``,
    "- 감지: validator/QA run은 succeeded로 종료됐지만 산출물 verdict가 `REQUEST_CHANGES`입니다.",
    "- 조치: delivery를 통과시키지 않고 source issue를 `blocked`로 전이합니다.",
    "- follow-up: mission owner unblock issue를 생성/재사용하고 owner agent를 wakeup합니다.",
    "",
    "### Verdict excerpt",
    "```text",
    input.verdict.excerpt || "REQUEST_CHANGES",
    "```",
  ].join("\n");
}

export function buildMissingWorkflowValidationVerdictGateComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
}) {
  return [
    runText(input.run, "## Completion blocked: workflow_validation_verdict_missing\n실행은 끝났지만 공식 검증 결과가 없어 완료를 보류했습니다. 다음 행동: Workflow API로 구조화된 검증 결과를 제출해 주세요. 댓글은 검증 결과를 대신할 수 없습니다.", "## Completion blocked: workflow_validation_verdict_missing\nThe run ended, but an official validation result is missing. Next action: submit the structured verdict through the Workflow API; a comment is not a verdict."),
    `- 실행 runId: \`${input.run.id}\``,
    "- Reason: this workflow QA/validator issue cannot be marked done until the official workflow_validation_verdict ledger contains PASS or REQUEST_CHANGES.",
    "- Required evidence: a workflow_transition_events row with eventType=workflow_validation_verdict for this issue.",
    "- If the artifact cannot be judged with the evidence available, submit the official INSUFFICIENT_EVIDENCE verdict with the missing evidence listed in `reason` instead of leaving no verdict.",
  ].join("\n");
}

export function buildInsufficientEvidenceWorkflowVerdictGateComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  reason: string | null;
}) {
  const reasonText = typeof input.reason === "string" && input.reason.trim().length > 0
    ? input.reason.trim().slice(0, 2000)
    : null;
  return [
    runText(input.run, "## Completion blocked: workflow_validation_insufficient_evidence\n검증에 필요한 근거가 부족해 완료를 보류했습니다. 재작업 반려는 아닙니다. 다음 행동: 아래 부족한 근거를 제출하고 새 공식 검증 결과를 받아 주세요.", "## Completion blocked: workflow_validation_insufficient_evidence\nThe official review needs more evidence; completion is on hold, not rejected for rework. Next action: provide the missing evidence below and obtain a new official verdict."),
    `- 실행 runId: \`${input.run.id}\``,
    "- Reason: the QA validator submitted an official INSUFFICIENT_EVIDENCE verdict — the current artifacts cannot be judged with the evidence available.",
    "- This is NOT a REQUEST_CHANGES rework verdict: no producer rework iteration or QA cap is consumed by this block.",
    "- Completion requires a follow-up official PASS or REQUEST_CHANGES verdict after the missing evidence below is provided.",
    reasonText
      ? `- Missing evidence requested by the validator:\n\`\`\`text\n${reasonText}\n\`\`\``
      : "- Missing evidence: the validator did not include a reason in the verdict payload.",
  ].join("\n");
}

export function buildRequestChangesOwnerActionDescription(input: {
  mission: Pick<typeof missions.$inferSelect, "title">;
  sourceIssue: Pick<typeof issues.$inferSelect, "id" | "identifier" | "title">;
  run: typeof heartbeatRuns.$inferSelect;
  verdict: RequestChangesVerdict;
  missionExecutionDigest?: string[];
}) {
  const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  const missionExecutionDigest = (input.missionExecutionDigest ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [
    "Mission-owner signal from validation gate. Automation has not selected a recovery action.",
    "",
    `Source issue: ${sourceLabel} — ${input.sourceIssue.title}`,
    `Source runId: ${input.run.id}`,
    "",
    "Signal:",
    "- kind: validation_request_changes",
    "- local hint only; the raw validation excerpt is preserved below",
    "",
    missionExecutionDigest.length > 0
      ? ["Mission execution digest:", ...missionExecutionDigest.map((line) => `- ${line}`)].join("\n")
      : "Mission execution digest: unavailable for this owner action template.",
    "",
    buildMainExecutorBrief({
      missionGoal: input.mission.title,
      currentSituation: `Source issue ${sourceLabel} produced REQUEST_CHANGES after run ${input.run.id}; downstream delivery remains gated until owner judgement.`,
    }),
    "",
    "### Validation excerpt",
    "```text",
    input.verdict.excerpt || "REQUEST_CHANGES",
    "```",
  ].join("\n");
}
