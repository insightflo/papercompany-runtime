import { existsSync } from "node:fs";

export type NativeToolStepRecoveryResult = {
  readonly artifactPath: string;
};

export type NativeToolStepRecoveryMarkerInput = {
  readonly ownerActionIssueId: string;
  readonly workflowRunId: string;
  readonly stepId: string;
};

export function buildNativeToolStepRecoveryResultAppliedMarker(input: NativeToolStepRecoveryMarkerInput): string {
  return `<!-- native-tool-step-recovery-result-applied:${JSON.stringify(input)} -->`;
}

export function hasNativeToolStepRecoveryResultAppliedMarker(
  comments: readonly string[],
  input: NativeToolStepRecoveryMarkerInput,
): boolean {
  return comments.some((comment) => comment.includes(buildNativeToolStepRecoveryResultAppliedMarker(input)));
}

export function resolveNativeToolStepRecoveryResult(input: {
  readonly comments: readonly string[];
  readonly artifactExists?: (artifactPath: string) => boolean;
}): NativeToolStepRecoveryResult | null {
  const artifactExists = input.artifactExists ?? existsSync;
  for (let index = input.comments.length - 1; index >= 0; index -= 1) {
    const comment = input.comments[index];
    if (!comment) continue;
    if (isNativeRetryBoundary(comment)) return null;
    if (!hasSuccessSignal(comment)) continue;
    const artifactPath = extractArtifactPath(comment);
    if (!artifactPath || !artifactExists(artifactPath)) continue;
    return { artifactPath };
  }
  return null;
}

function isNativeRetryBoundary(comment: string): boolean {
  return comment.includes("native-tool-step-retry-applied")
    || /^### Native tool step retry applied$/im.test(comment)
    || /^### Native tool step retry failed$/im.test(comment);
}

function hasSuccessSignal(comment: string): boolean {
  const text = comment.toLowerCase();
  return (
    text.includes("### native tool step recovery result") &&
    (text.includes("status: success") || text.includes("result: success"))
  ) || (
    text.includes("status=success") &&
    (text.includes("exit_code=0") || text.includes("exit code: 0"))
  ) || (
    text.includes('"status": "success"') &&
    (text.includes('"exit_code": 0') || text.includes('"exitcode": 0'))
  );
}

function extractArtifactPath(comment: string): string | null {
  for (const line of comment.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[ARTIFACT]:")) continue;
    const artifactPath = trimmed.slice("[ARTIFACT]:".length).trim();
    if (artifactPath.startsWith("/")) return artifactPath;
  }
  return null;
}
