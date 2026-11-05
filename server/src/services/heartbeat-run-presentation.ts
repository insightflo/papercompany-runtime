import type { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { readNonEmptyString, resolveAdapterFallbackAttempt } from "./heartbeat-run-context.js";
import type { NoProgressAssessment } from "./heartbeat-no-progress.js";
import type { HeartbeatFailureClassification } from "./heartbeat-failure-classification.js";

export const MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS = 12 * 1024;

export const runText = (run: typeof heartbeatRuns.$inferSelect, ko: string, en: string) => parseObject(run.contextSnapshot).paperclipUserFacingLanguage === "ko" ? ko : en;
export function buildMissionChildRunOutputComment(run: typeof heartbeatRuns.$inferSelect) {
  const stdout = (run.stdoutExcerpt ?? "").trim();
  const stderr = (run.stderrExcerpt ?? "").trim();
  const output = [stdout, stderr ? `stderr:\n${stderr}` : ""]
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();
  const excerpt =
    output.length > MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS
      ? `${output.slice(output.length - MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS)}`
      : output;
  return [
    "## 자동 캡처: delegated run output",
    runText(run, `- 실행 기록(runId): \`${run.id}\``, `- Run record (runId): \`${run.id}\``),
    runText(run, "- 이유: 위임 업무 실행은 성공(succeeded)으로 종료됐지만 업무 마감 기록이 없었습니다.", "- Reason: the delegated run succeeded, but the issue had no closeout record."),
    runText(run, "- 처리: 실행 출력 원문을 아래에 보존하고 업무를 완료(done) 상태로 변경합니다. 필요한 근거는 아래 기록에서 확인해 주세요.", "- Action: preserve the raw output below and mark the issue done. Review the captured evidence below."),
    "",
    "### Captured output",
    "```text",
    excerpt || "(no stdout/stderr excerpt captured)",
    "```",
  ].join("\n");
}

export function buildSuccessfulIssueRunAutoCompletedComment(run: typeof heartbeatRuns.$inferSelect) {
  const output = [run.stdoutExcerpt, run.stderrExcerpt ? `stderr:\n${run.stderrExcerpt}` : ""]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n")
    .trim();
  const planDecisionOutput = extractMissionOwnerPlanDecisionOutput(output);
  return [
    runText(run, "## 업무를 자동 완료했습니다 (checked-out run succeeded)", "## Issue automatically completed (checked-out run succeeded)"),
    runText(run, `- 실행 기록(runId): \`${run.id}\``, `- Run record (runId): \`${run.id}\``),
    runText(run, "- 이유: 이 업무를 맡은 에이전트 실행(heartbeat run)이 성공(succeeded)으로 종료됐습니다.", "- Reason: the assigned agent run (heartbeat run) succeeded."),
    runText(run, "- 처리: 일반 업무는 담당 실행 성공 시 완료(done)로 마감하는 정책을 적용했습니다. 별도 검증 통과를 뜻하지는 않습니다.", "- Action: ordinary issues close as done after the assigned run succeeds. This does not imply independent validation passed."),
    runText(run, "- 다음 행동: 계속 열린 상태로 협업할 업무는 별도 업무 유형이나 상태로 구분해 주세요.", "- Next action: use a separate issue type or status for work that must remain open for collaboration."),
    planDecisionOutput
      ? [
          "",
          "### Captured PLAN decision output",
          planDecisionOutput,
        ].join("\n")
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function extractMissionOwnerPlanDecisionOutput(output: string): string | null {
  const candidates: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.result === "string") {
        candidates.push(record.result);
      }
      const message = record.message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
              candidates.push((entry as Record<string, string>).text);
            }
          }
        }
      }
    } catch {
      // Non-JSON log lines are expected in adapter output.
    }
  }
  candidates.push(output);

  for (const candidate of candidates.reverse()) {
    const extracted = extractMissionOwnerPlanDecisionBlock(candidate);
    if (extracted) return extracted;
  }
  return null;
}

function extractMissionOwnerPlanDecisionBlock(text: string): string | null {
  const normalizedText = normalizeEscapedMissionOwnerPlanDecisionMarkdown(text);
  const headingIndex = normalizedText.lastIndexOf("### Mission owner plan decision");
  if (headingIndex < 0) return null;
  const block = normalizedText.slice(headingIndex).trim();
  const fenceIndex = block.search(/```json\s*/iu);
  if (fenceIndex < 0) return block;
  const openingFenceEnd = block.indexOf("\n", fenceIndex);
  if (openingFenceEnd < 0) return block;
  const closingFenceIndex = block.indexOf("```", openingFenceEnd + 1);
  if (closingFenceIndex < 0) return block;
  return block.slice(0, closingFenceIndex + 3).trim();
}

function normalizeEscapedMissionOwnerPlanDecisionMarkdown(text: string): string {
  if (!text.includes("### Mission owner plan decision") || !text.includes("\\n")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}


export function buildNoProgressAutoBlockedComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  assessment: NoProgressAssessment;
  advisoryThreshold: number;
  autoBlockThreshold: number;
}) {
  const { run, assessment, advisoryThreshold, autoBlockThreshold } = input;
  return [
    runText(run, "## 자동 차단: 연속 무진행 실행 (consecutive no-progress)", "## Automatically blocked: consecutive no-progress runs (연속 무진행 실행)"),
    `- 트리거 runId: \`${run.id}\``,
    `- 연속 무진행 성공 run: ${assessment.count}회 (차단 기준 ${autoBlockThreshold}회, 경고 기준 ${advisoryThreshold}회)`,
    `- 판정 창: ${assessment.windowStart.toISOString()} 이후 (구조화 DB 증거로 재계산)`,
    `- 마지막 무진행 run: \`${assessment.lastRunId ?? "-"}\``,
    `- 확인 증거: 실제 산출물 생성·변경 ${assessment.evidenceSummary.workProductRuns}개 실행 / 공식 도구 증가 ${assessment.evidenceSummary.toolProgressRuns}개 실행 (최근 ${assessment.evidenceSummary.runs}개 실행 조회)`,
    "- 정책: 성공했지만 아무 변화 없는 실행이 반복되어 자동 디스패치를 멈춤. blocked는 owner-action/native-resume으로만 재개됩니다.",
    "- 재개 전 확인: 이슈 범위 재조정, 산출물 계약 재명시, 또는 담당 재할당. 같은 상태로 재개하면 같은 연쇄가 이어집니다.",
  ].join("\n");
}

export function buildMissionWorkerNoProgressOversightComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  sourceIssue: { id: string; identifier: string | null; title: string };
  assessment: NoProgressAssessment;
  autoBlockThreshold: number;
}) {
  const issueLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  return [
    runText(input.run, "## Mission oversight: worker consecutive no-progress observed\n실행이 반복됐지만 진행 근거가 없어 담당 업무를 차단했습니다. 다음 행동: 복구 요청 전에 업무 범위, 산출물 요구 사항, 담당자를 확인해 주세요.", "## Mission oversight: worker consecutive no-progress observed\nThe worker is blocked because repeated runs produced no recorded progress. Next action: review scope, artifact requirements, or assignment before requesting recovery."),
    `- source issue: \`${issueLabel}\` — ${input.sourceIssue.title}`,
    `- latest succeeded runId: \`${input.run.id}\``,
    `- consecutive no-progress runs: ${input.assessment.count} (auto-block threshold ${input.autoBlockThreshold})`,
    `- evidence checked: measured work-product creation/change in ${input.assessment.evidenceSummary.workProductRuns} runs, accepted tool advances in ${input.assessment.evidenceSummary.toolProgressRuns} runs (window from ${input.assessment.windowStart.toISOString()})`,
    "- policy: the worker issue was auto-blocked after repeated successful runs with no structured change; owner action is required to resume (re-scope, restate the deliverable contract, or reassign).",
  ].join("\n");
}

export function buildFailedIssueRunAutoBlockedComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  classification: HeartbeatFailureClassification;
}) {
  const { run, classification } = input;
  const rawReason = (run.error ?? run.stderrExcerpt ?? run.stdoutExcerpt ?? "").trim();
  const reasonExcerpt = rawReason.length > 1200 ? rawReason.slice(0, 1200) : rawReason;
  const recoveryLines = buildRunRecoveryLines(run);
  return [
    runText(run, "## 실행 실패로 업무를 차단했습니다 (linked run ended with failure)\n다음 행동: 아래 오류와 복구 기록을 확인한 뒤 업무 책임자가 재시도·담당 변경 여부를 결정해 주세요. 이 댓글은 재실행 요청이 아닙니다.", "## Issue blocked after linked run failure\nNext action: review the errors and recovery record below, then let the owner decide whether to retry or reassign. This comment does not request another run."),
    `- 실행 runId: \`${run.id}\``,
    `- run status: \`${run.status}\``,
    `- 분류: \`${classification.reasonCode}\` (${classification.category})`,
    `- 요약: ${classification.summary}`,
    ...recoveryLines,
    classification.fallbackCandidates.length > 0
      ? `- fallback/대체 후보: ${classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback/대체 후보: 자동 선택 안 함 — owner/oversight 재검토 필요",
    reasonExcerpt ? ["", "### Failure excerpt", "```text", reasonExcerpt, "```"].join("\n") : "",
  ].filter((line) => line.length > 0).join("\n");
}

function buildRunRecoveryLines(run: typeof heartbeatRuns.$inferSelect) {
  const context = parseObject(run.contextSnapshot);
  const lines: string[] = [];
  if (run.errorCode === "process_lost") {
    const retryCount = run.processLossRetryCount ?? 0;
    const fallbackAttempt = resolveAdapterFallbackAttempt(context);
    lines.push(`- 복구 상태: process_lost retry ${retryCount}/1, adapter fallback ${fallbackAttempt}회 시도됨`);
    if (run.retryOfRunId) lines.push(`- 이전 run: \`${run.retryOfRunId}\``);
    const fallbackOfRunId = readNonEmptyString(context.fallbackOfRunId);
    if (fallbackOfRunId) lines.push(`- fallback 기준 run: \`${fallbackOfRunId}\``);
    if (retryCount >= 1 && fallbackAttempt > 0) {
      lines.push("- 판정: 자동 retry/fallback 한도를 소진하여 동일 issue를 계속 반복 실행하지 않고 차단함");
    } else if (retryCount >= 1) {
      lines.push("- 판정: 자동 retry 한도를 소진하여 동일 issue를 계속 반복 실행하지 않고 차단함");
    }
  }
  return lines;
}

export function buildMissionWorkerFailureOversightComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  sourceIssue: { id: string; identifier: string | null; title: string };
  classification: HeartbeatFailureClassification;
}) {
  const issueLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  return [
    runText(input.run, "## Mission oversight: worker run failure observed\n담당 업무의 실행이 실패했습니다. 다음 행동: 아래 실패 근거를 확인하고 복구 방법을 결정해 주세요. 이 보고는 재시도 실행을 확인한 기록이 아닙니다.", "## Mission oversight: worker run failure observed\nThe worker run failed. Next action: inspect the failure evidence below and decide recovery; no retry is confirmed by this report."),
    `- source issue: \`${issueLabel}\` — ${input.sourceIssue.title}`,
    `- failed runId: \`${input.run.id}\``,
    `- run status: \`${input.run.status}\``,
    `- classification: \`${input.classification.reasonCode}\` (${input.classification.category})`,
    `- summary: ${input.classification.summary}`,
    ...buildRunRecoveryLines(input.run),
    input.classification.fallbackCandidates.length > 0
      ? `- fallback candidates: ${input.classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback candidates: none auto-selected; owner should decide retry/reassign/escalate.",
    "- policy: issue was moved out of in_progress so the mission owner can inspect and decide next action.",
  ].join("\n");
}

export function buildMissionOversightRunFailureComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  classification: HeartbeatFailureClassification;
}) {
  return [
    runText(input.run, "## Mission oversight run failed but the supervisor issue remains open\n감독 실행이 실패했으며 전체 미션 실패를 뜻하지는 않습니다. 감독 업무는 열려 있습니다. 다음 행동: 아래 실패 기록을 검토해 주세요.", "## Mission oversight run failed but the supervisor issue remains open\nThe oversight run failed, not the entire mission. Next action: review the failure below; the supervisor remains available for a later run."),
    `- failed runId: \`${input.run.id}\``,
    `- run status: \`${input.run.status}\``,
    `- classification: \`${input.classification.reasonCode}\` (${input.classification.category})`,
    `- summary: ${input.classification.summary}`,
    input.classification.fallbackCandidates.length > 0
      ? `- fallback candidates: ${input.classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback candidates: none auto-selected; owner should decide retry/reassign/escalate.",
    "- policy: mission oversight is the supervisor for this mission, so a failed oversight run releases the issue back to todo instead of blocking the supervisor itself.",
  ].join("\n");
}

export function buildMissionOversightRunSucceededReleaseComment(run: typeof heartbeatRuns.$inferSelect, missionStatus: string) {
  return [
    runText(run, "## Mission oversight run succeeded and the supervisor issue remains open\n이번 감독 실행은 성공했지만 전체 미션 완료를 뜻하지는 않습니다. 감독 업무는 열려 있습니다. 다음 행동: 남은 미션 업무를 계속 확인해 주세요.", "## Mission oversight run succeeded and the supervisor issue remains open\nThis supervision cycle ended successfully; the mission is not necessarily complete. Next action: continue monitoring the remaining mission work."),
    `- succeeded runId: \`${run.id}\``,
    `- mission status: \`${missionStatus}\``,
    "- policy: mission oversight stays alive until the mission is completed or cancelled, so this successful cycle releases the issue back to todo instead of closing it.",
  ].join("\n");
}
