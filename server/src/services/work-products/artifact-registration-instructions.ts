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
    "- Register with a single direct curl call using a literal inline JSON payload and an explicit content type, e.g. `curl -sS -H \"Content-Type: application/json\" --data-raw '{\"path\":\"/abs/path/to/topic-decision.json\",\"type\":\"document\"}' \"$PAPERCLIP_API_URL/api/issues/{issueId}/workflow/artifacts\" -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"`. The server sets a local-file title to the path basename; omit the `title` field.",
    "- Do NOT build the JSON payload with Python (urllib/json.dumps), Node, a shell heredoc (`<<'EOF'`), or a temp file. Those payload builders trigger an interactive command approval that auto-denies after ~60s in unattended hermes_local runs; a direct `curl` call with a literal `--data-raw` payload and explicit content type is the approved structured registration path (curl >= 7.55; compatible with the production 7.76.1 runtime) and runs without that approval.",
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
  language?: "ko" | "en"; runId: string;
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
    "## 산출물 미등록으로 업무가 차단됐습니다 (Mission artifact gate: workProduct registration missing)", input.language === "en" ? "The issue is blocked because no official workProduct is registered. A successful run or reported file path is not registration. Next action: register the existing file through the Workflow API below, then request workflow resume." : "공식 산출물이 등록되지 않아 업무를 차단했습니다. 실행 성공이나 보고된 파일 경로는 등록을 뜻하지 않습니다. 다음 행동: 아래 Workflow API로 기존 파일을 등록한 뒤 작업 흐름 재개를 요청해 주세요.",
    `- 실행 runId: \`${input.runId}\``,
    "- 이유: 실행은 성공(succeeded)으로 종료되고 파일 경로도 보고됐지만, 이 업무에 공식 산출물(workProduct)이 등록되지 않았습니다.",
    "- 영향: 댓글에 적힌 파일 경로만으로 다음 작업이 진행되지 않도록 원래 업무를 차단(blocked) 상태로 변경합니다.",
    "- 다음 행동: 아래 절차에 따라 파일을 이 업무의 공식 산출물(workProduct)로 등록한 뒤 작업 흐름 재개를 요청해 주세요.",
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
