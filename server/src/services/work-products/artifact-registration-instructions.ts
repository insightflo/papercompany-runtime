import {
  EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
  renderEvidenceExplanationWritingLines,
} from "../missions/mission-quality-contract.js";

const ARTIFACT_MARKER_PLACEHOLDER = "[ARTIFACT]: <absolute path>";

export function buildArtifactOutputDirectoryLines(input: {
  outputDir: string;
}): string[] {
  return [
    "Deliverable output (use exactly this directory):",
    `- ${input.outputDir}`,
    "- Write or reuse deliverable file(s) only in that directory. Do not look under other produced_work paths, run dates, or sibling mission folders.",
    "",
    ...renderEvidenceExplanationWritingLines(),
  ];
}

export function buildWorkProductRegistrationContractLines(input: {
  artifactPath?: string;
} = {}): string[] {
  const marker = input.artifactPath
    ? `[ARTIFACT]: ${input.artifactPath}`
    : ARTIFACT_MARKER_PLACEHOLDER;
  return [
    "WorkProduct registration contract:",
    "- Creating the deliverable file and registering the workProduct are separate steps. A file that only exists on disk or in a comment is not registered.",
    "- Prefer the Workflow API: register the deliverable with `POST /api/issues/{issueId}/workflow/artifacts` after creating or reusing the file and before completing the issue.",
    `- Fallback only if the Workflow API is unavailable: include one standalone final line exactly \`${marker}\`. The system reads that line and registers the workProduct automatically.`,
    input.artifactPath
      ? `- The deliverable file already exists at \`${input.artifactPath}\`; do not regenerate it. Reuse that file and register that exact path.`
      : "- If the deliverable file does not exist yet, create it in the assigned output directory. If it already exists, do not regenerate it; register the existing file.",
    "- Do not use the generic workProduct route or invent workProduct fields such as provider/title/metadata. Use the Workflow API first, or the artifact marker fallback above.",
    `- FALLBACK FINAL LINE RULE: when using the fallback marker, your last assistant message MUST end with exactly one standalone line \`${marker}\`. Nothing may follow that line: no closing prose, no summary, and no meta text like 'ARTIFACT line ready'.`,
  ];
}

export function buildExistingArtifactRegistrationActionLines(input: {
  artifactPath: string;
}): string[] {
  return [
    "Required action:",
    ...buildWorkProductRegistrationContractLines({ artifactPath: input.artifactPath }).slice(1),
  ];
}

export function buildQaReworkArtifactInstructionLine(input: {
  feedbackScope: string;
}): string {
  return `- Required: update the deliverable to address ${input.feedbackScope}, save it in the assigned output directory, and finish with the required \`${ARTIFACT_MARKER_PLACEHOLDER}\` line. Creating/updating the file and registering the workProduct are separate; if the corrected file already exists, register that existing file instead of regenerating it.`;
}

export function buildDelegatedWorkProductContractLines(): string[] {
  return [
    "Official workProduct contract:",
    `- ${EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE}`,
    "- Creating the deliverable file and registering the workProduct are separate steps. A file that only exists on disk or in a comment is not registered.",
    `- If this delegated issue specifies an output directory or artifact contract, create the deliverable there when missing. If it already exists, reuse it and register it with the Workflow API or finish with the fallback \`${ARTIFACT_MARKER_PLACEHOLDER}\` line.`,
    "- Do not use the generic workProduct route. Use the Workflow API first; use the artifact marker only as fallback when the Workflow API is unavailable.",
    "- The source workflow will copy those registered workProducts back to the source tracker issue when this issue is done.",
  ];
}

export function buildAssignedIssueArtifactWorkflowText(): string {
  return `${EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE} If the issue specifies a deliverable output directory or artifact contract, remember that creating the file and registering the workProduct are separate. If the file is missing, create it; if it already exists, reuse it. Register with the Workflow API first, or emit \`[ARTIFACT]: <absolute path>\` only as fallback when the Workflow API is unavailable.`;
}

export function buildAssignedIssueArtifactWorkflowLine(): string {
  return `- ${buildAssignedIssueArtifactWorkflowText()}`;
}

export function buildMissingWorkProductRegistrationGateComment(input: {
  runId: string;
  claimedArtifactPaths: readonly string[];
  commentClaimedArtifactPaths?: readonly string[];
  sourceCommentIds?: readonly string[];
  allowedArtifactRoot?: string | null;
}): string {
  const runPaths = input.claimedArtifactPaths.length > 0
    ? input.claimedArtifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n")
    : "- (artifact path not captured)";
  const commentPaths = input.commentClaimedArtifactPaths && input.commentClaimedArtifactPaths.length > 0
    ? input.commentClaimedArtifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n")
    : null;
  const sourceCommentIds = input.sourceCommentIds && input.sourceCommentIds.length > 0
    ? input.sourceCommentIds.map((commentId) => `- ${commentId}`).join("\n")
    : null;
  return [
    "## Mission artifact gate: workProduct registration missing",
    `- 실행 runId: \`${input.runId}\``,
    "- 감지: run은 succeeded로 종료됐고 산출물 파일 경로를 보고했지만, issue에 공식 `workProduct`가 등록되어 있지 않습니다.",
    "- 조치: downstream workflow가 비공식 comment 경로만 보고 진행하지 않도록 source issue를 `blocked`로 전이합니다.",
    "- 복구: 아래 파일을 이 issue의 `workProduct`로 등록한 뒤 workflow를 resume하세요.",
    input.allowedArtifactRoot
      ? `- 허용 경로: 이 mission의 local workProduct는 \`${input.allowedArtifactRoot}\` 아래에 있어야 합니다.`
      : null,
    "",
    "### Registration procedure",
    ...buildWorkProductRegistrationContractLines(),
    "",
    "### Run output artifact paths",
    runPaths,
    commentPaths ? "" : null,
    commentPaths ? "### Comment artifact paths" : null,
    commentPaths,
    sourceCommentIds ? "" : null,
    sourceCommentIds ? "### Source comment ids" : null,
    sourceCommentIds,
  ].filter((line): line is string => line !== null).join("\n");
}
