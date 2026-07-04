const ARTIFACT_MARKER_PLACEHOLDER = "[ARTIFACT]: <absolute path>";

export function buildArtifactOutputDirectoryLines(input: {
  outputDir: string;
}): string[] {
  return [
    "Deliverable output (use exactly this directory):",
    `- ${input.outputDir}`,
    "- Write or reuse deliverable file(s) only in that directory. Do not look under other produced_work paths, run dates, or sibling mission folders.",
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
    `- Registration happens only when your run output includes one standalone final line exactly \`${marker}\`. The system reads that line and registers the workProduct automatically.`,
    input.artifactPath
      ? `- The deliverable file already exists at \`${input.artifactPath}\`; do not regenerate it. Reuse that file and emit the exact marker above.`
      : "- If the deliverable file does not exist yet, create it in the assigned output directory, then emit the artifact marker. If it already exists, do not regenerate it; emit the marker for the existing file.",
    "- Do not POST, curl, or invent workProduct fields such as type/provider/title/metadata. The artifact marker is the only registration method.",
    `- FINAL LINE RULE: your last assistant message MUST end with exactly one standalone line \`${marker}\`. Nothing may follow that line: no closing prose, no summary, and no meta text like 'ARTIFACT line ready'.`,
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
    "- Creating the deliverable file and registering the workProduct are separate steps. A file that only exists on disk or in a comment is not registered.",
    `- If this delegated issue specifies an output directory or artifact contract, create the deliverable there when missing. If it already exists, reuse it and finish with the required \`${ARTIFACT_MARKER_PLACEHOLDER}\` line.`,
    "- Do not POST or curl workProduct registration. The artifact marker is the only registration method.",
    "- The source workflow will copy those registered workProducts back to the source tracker issue when this issue is done.",
  ];
}

export function buildAssignedIssueArtifactWorkflowText(): string {
  return "If the issue specifies a deliverable output directory or artifact contract, remember that creating the file and registering the workProduct are separate. If the file is missing, create it and finish with `[ARTIFACT]: <absolute path>`; if it already exists, reuse it and emit that marker. Do not POST/curl registration.";
}

export function buildAssignedIssueArtifactWorkflowLine(): string {
  return `- ${buildAssignedIssueArtifactWorkflowText()}`;
}

export function buildMissingWorkProductRegistrationGateComment(input: {
  runId: string;
  claimedArtifactPaths: readonly string[];
  allowedArtifactRoot?: string | null;
}): string {
  const paths = input.claimedArtifactPaths.length > 0
    ? input.claimedArtifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n")
    : "- (artifact path not captured)";
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
    "### Claimed artifact paths",
    paths,
  ].filter((line): line is string => line !== null).join("\n");
}
