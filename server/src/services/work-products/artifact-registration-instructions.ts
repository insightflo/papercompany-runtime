import {
  EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
  renderEvidenceExplanationWritingLines,
} from "../missions/mission-quality-contract.js";


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
  return [
    "WorkProduct registration contract:",
    "- Creating the deliverable file and registering the workProduct are separate steps. A file that only exists on disk, in a comment, or in run output is not registered.",
    "- Register the deliverable with the Workflow API: `POST /api/issues/{issueId}/workflow/artifacts` after creating or reusing the file and before completing the issue. This is the only registration authority.",
    input.artifactPath
      ? `- The deliverable file already exists at \`${input.artifactPath}\`; do not regenerate it. Reuse that file and register that exact path via the Workflow API.`
      : "- If the deliverable file does not exist yet, create it in the assigned output directory. If it already exists, do not regenerate it; register the existing file via the Workflow API.",
    "- Do not use the generic workProduct route, comment text, stdout, or an `[ARTIFACT]` marker to register. Comments, stdout, and artifact markers are no longer registration authority; only the Workflow API registers a work product.",
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
  return `- Required: update the deliverable to address ${input.feedbackScope}, save it in the assigned output directory, and register the corrected workProduct with the Workflow API (\`POST /api/issues/{issueId}/workflow/artifacts\`). Creating/updating the file and registering the workProduct are separate; if the corrected file already exists, register that existing file instead of regenerating it.`;
}

export function buildDelegatedWorkProductContractLines(): string[] {
  return [
    "Official workProduct contract:",
    `- ${EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE}`,
    "- Creating the deliverable file and registering the workProduct are separate steps. A file that only exists on disk or in a comment is not registered.",
    `- If this delegated issue specifies an output directory or artifact contract, create the deliverable there when missing. If it already exists, reuse it and register it with the Workflow API (\`POST /api/issues/{issueId}/workflow/artifacts\`).`,
    "- Do not use the generic workProduct route, comment text, stdout, or an `[ARTIFACT]` marker. Only the Workflow API registers a work product.",
    "- The source workflow will copy those registered workProducts back to the source tracker issue when this issue is done.",
  ];
}

export function buildAssignedIssueArtifactWorkflowText(): string {
  return `${EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE} If the issue specifies a deliverable output directory or artifact contract, remember that creating the file and registering the workProduct are separate. If the file is missing, create it; if it already exists, reuse it. Register the workProduct only with the Workflow API (\`POST /api/issues/{issueId}/workflow/artifacts\`). Do not rely on comments, stdout, or an \`[ARTIFACT]\` marker — those are not registration authority.`;
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
