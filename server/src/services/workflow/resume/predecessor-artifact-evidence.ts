import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  buildMissionWorkProductPaths,
  isPathInsideOrEqual,
} from "../../work-products/output-paths.js";

/**
 * [파일 목적] Task6b outside predecessor 내구 산출물 검증기. 재개 대상 밖에서 결과가 유입되는
 *   완료 스텝의 toolResult 기록에서 (artifactPath, artifactSha256) 계약을 읽고, 그 파일이
 *   지금도 회사 work product root 의 해당 미션/런/스텝 디렉터리 안에 존재하며 바이트 해시가
 *   기록과 정확히 일치하는지 재검증한다. 검증을 통과한 스텝만 SnapshotState.evidence 로
 *   승인되고, 아니면 preview 의 missing_evidence blocker 가 유지된다(fail-closed).
 * [불변식]
 *   - metadata 의 해시 주장 자체는 검증이 아니다. 반드시 현재 파일 바이트를 다시 해싱해
 *     대조한다(claimed-hash/work product metadata 는 근거로 인정하지 않는다).
 *   - artifactPath 는 이 스텝의 stepOutputDir 안으로 한정한다. 임의 호스트 경로(도구 캐시 등)를
 *     증거로 승격하지 않는다. workProductRoot 가 없으면 root_unverified 로 거절한다.
 *   - 판정은 고정 reason 라벨만 반환한다(입력 값·경로 원문 유출 금지). 파일은 스트림으로 해싱한다.
 *   - 이 검증기는 toolResult 계약(tool 스텝)만 다룬다. agent 스텝의 work product 기반 검증은
 *     별도 계약이 완성될 때까지 missing_evidence 로 남는다.
 */

export type PredecessorEvidenceReason =
  | "root_unresolved"
  | "no_tool_result"
  | "tool_failed"
  | "no_artifact_record"
  | "invalid_hash"
  | "path_out_of_scope"
  | "file_missing"
  | "hash_mismatch"
  | "read_failed";

export type PredecessorArtifactVerification =
  | { kind: "verified"; sha256: string }
  | { kind: "unverified"; reason: PredecessorEvidenceReason };

const SHA256_RE = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256File(absolutePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * outside predecessor 스텝 하나의 내구 산출물을 검증한다. stepRun.metadata 는 DB raw(jsonb)
 *   값 그대로 받고, 판정 근거는 (toolResult.success, toolResult.artifactPath,
 *   toolResult.artifactSha256, 현재 파일 바이트) 4종뿐이다.
 */
export async function verifyOutsidePredecessorArtifact(input: {
  stepRun: { id: string; stepId: string; metadata: unknown };
  missionId: string;
  workflowRunId: string;
  workProductRoot: string | null;
}): Promise<PredecessorArtifactVerification> {
  if (typeof input.workProductRoot !== "string" || input.workProductRoot === "") {
    return { kind: "unverified", reason: "root_unresolved" };
  }
  const metadata = isRecord(input.stepRun.metadata) ? input.stepRun.metadata : {};
  const toolResult = metadata.toolResult;
  if (!isRecord(toolResult)) return { kind: "unverified", reason: "no_tool_result" };
  if (toolResult.success !== true) return { kind: "unverified", reason: "tool_failed" };
  const artifactPath = toolResult.artifactPath;
  if (typeof artifactPath !== "string" || artifactPath === "") {
    return { kind: "unverified", reason: "no_artifact_record" };
  }
  const artifactSha256 = toolResult.artifactSha256;
  if (typeof artifactSha256 !== "string" || !SHA256_RE.test(artifactSha256)) {
    return { kind: "unverified", reason: "invalid_hash" };
  }
  const { stepOutputDir } = buildMissionWorkProductPaths({
    workProductRoot: input.workProductRoot,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    stepId: input.stepRun.stepId,
  });
  if (!isPathInsideOrEqual(artifactPath, stepOutputDir)) {
    return { kind: "unverified", reason: "path_out_of_scope" };
  }
  let fileInfo;
  try {
    fileInfo = await stat(artifactPath);
  } catch {
    return { kind: "unverified", reason: "file_missing" };
  }
  if (!fileInfo.isFile()) return { kind: "unverified", reason: "file_missing" };
  let digest: string;
  try {
    digest = await sha256File(path.resolve(artifactPath));
  } catch {
    return { kind: "unverified", reason: "read_failed" };
  }
  if (digest !== artifactSha256) return { kind: "unverified", reason: "hash_mismatch" };
  return { kind: "verified", sha256: artifactSha256 };
}
