import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db, MissionRollingDecisionRecord } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";

/**
 * [결정 근거 스테일 스윕 — 기능 2] confirmed 결정이 인용한 근거 파일의 내용 해시를
 * 결정론적으로 재계산해, 파일이 변경되거나 사라졌음이 입증되면 under_review 로
 * 강등하고 demotedByEvidence 스탬프를 찍는다.
 *
 * 기계 판정 원칙(규칙 8): 판정은 sha256 비교뿐이다. 자연어·주석·요약은 근거가
 * 아니다. 검증 불가능한 근거는 결코 강등하지 않는다(fail-open):
 * - work_product/run_log 가 아니거나 64-hex sha256 이 없는 참조는 검사하지 않는다.
 * - 검증 루트 밖으로 나가는 경로(절대 경로 미포함, ../ 탈출)는 조용히 건너뛴다.
 * - 읽을 수 없거나(디렉터리, 권한, 4MiB 초과) 해시를 못 구하면 건너뛴다.
 * - 이미 demotedByEvidence 스탬프가 있는 기록은 v1 에서 재강등하지 않는다.
 * - confirmed 가 아닌 기록은 대상이 아니다.
 *
 * board 출처 기록도 이 기계 판정으로는 강등된다(문서화된 예외: 행위자 덮어쓰기가
 * 아니라 결정론적 근거 판정이며, source/lastConflictingProposal 은 건드리지 않는다).
 */

/** 컨텍스트 세이프 파일 뷰와 동일한 4MiB 가드 — 대형 파일 해시로 스윕이 막히지 않게 한다. */
const MAX_CONTENT_HASH_BYTES = 4 * 1024 * 1024;
const SHA256_HEX_64 = /^[0-9a-f]{64}$/;
const CHECKABLE_EVIDENCE_TYPES = new Set(["work_product", "run_log"]);

export type StaleEvidenceMismatch = NonNullable<
  MissionRollingDecisionRecord["demotedByEvidence"]
>["mismatches"][number];

export type StaleEvidenceDemotion = { id: string; mismatches: StaleEvidenceMismatch[] };

export type StaleEvidenceSweepResult = {
  decisions: MissionRollingDecisionRecord[];
  demotions: StaleEvidenceDemotion[];
  verifiedCount: number;
};

/** context-safe-file-views 의 hashFileContents 와 동일한 방식(sha256 hex). 실패 시 null. */
async function hashFileContents(absolutePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_CONTENT_HASH_BYTES) return null;
    const contents = await fs.readFile(absolutePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  }
}

/** 후보 경로가 루트 "아래"(루트 자체 제외)에 있으면 true. */
function isUnderRoot(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

/**
 * 참조 id 를 검증 루트들에 대해 해석한다.
 * - 상대 id: 각 루트 순서대로 대입, 파일이 존재하는 첫 후보가 이긴다(first existing wins).
 * - 절대 id: 정확히 하나의 경로이며, 임의 루트 아래에 있을 때만 검사 대상이다.
 * 반환: { verdict, mismatch? } — verdict "skip" 은 검증 불가(강등 금지)다.
 */
async function verifyRef(
  refId: string,
  recordedSha256: string,
  type: string,
  roots: string[],
): Promise<{ mismatch: StaleEvidenceMismatch } | { verified: true } | { skip: true }> {
  let sawContainedCandidate = false;
  let sawEscapedCandidate = false;
  const isAbsoluteId = path.isAbsolute(refId);
  for (const root of roots) {
    const candidate = isAbsoluteId ? path.resolve(refId) : path.resolve(root, refId);
    if (!isUnderRoot(root, candidate)) {
      sawEscapedCandidate = true;
      continue;
    }
    sawContainedCandidate = true;
    const stat = await fs.stat(candidate).catch(() => null);
    // 디렉터리 등 정규 파일이 아닌 후보는 읽을 수 없는 것이므로 강등 근거가 아니다.
    if (stat && !stat.isFile()) return { skip: true };
    if (!stat) continue;
    const currentHash = await hashFileContents(candidate);
    if (currentHash === null) return { skip: true };
    if (currentHash === recordedSha256) return { verified: true };
    return {
      mismatch: { id: refId, type, recordedSha256, current: "changed" },
    };
  }
  // 절대 id 는 정확한 경로이므로 루트 내 후보가 사라진 것은 소실(missing) 판정.
  // 상대 id 는 “지금 받은 루트”에 없을 뿐 실제 산출물이 다른 루트에 있을 수 있어
  // 검증 불가로 간주한다(fail-open — 검증 불가능한 근거로는 강등하지 않는다).
  if (isAbsoluteId && sawContainedCandidate) {
    return { mismatch: { id: refId, type, recordedSha256, current: "missing" } };
  }
  if (sawEscapedCandidate) return { skip: true };
  return { skip: true };
}

/**
 * 결정 로그 배열을 스윕해 새 배열을 돌려준다. 입력은 변경하지 않는다. roots 가
 * 없거나 비면 no-op(fail-open). 절대 던지지 않는다(파일 단위 예외는 건너뛰기).
 */
export async function sweepStaleDecisionEvidence(
  decisions: MissionRollingDecisionRecord[],
  roots: string[] | undefined,
): Promise<StaleEvidenceSweepResult> {
  const result: StaleEvidenceSweepResult = { decisions, demotions: [], verifiedCount: 0 };
  if (!roots || roots.length === 0 || decisions.length === 0) return result;
  const resolvedRoots = roots.map((root) => path.resolve(root));
  const demotedAt = new Date().toISOString();
  const nextDecisions = decisions.map((record) => ({ ...record }));
  const demotions: StaleEvidenceDemotion[] = [];
  let verifiedCount = 0;

  for (const record of nextDecisions) {
    if (record.status !== "confirmed") continue;
    if (record.demotedByEvidence) continue;
    const mismatches: StaleEvidenceMismatch[] = [];
    for (const ref of record.evidenceRefs ?? []) {
      if (!CHECKABLE_EVIDENCE_TYPES.has(ref.type)) continue;
      if (typeof ref.sha256 !== "string" || !SHA256_HEX_64.test(ref.sha256)) continue;
      const verdict = await verifyRef(ref.id, ref.sha256, ref.type, resolvedRoots).catch(() => ({ skip: true } as const));
      if ("skip" in verdict) continue;
      if ("verified" in verdict) {
        verifiedCount += 1;
        continue;
      }
      mismatches.push(verdict.mismatch);
    }
    if (mismatches.length === 0) continue;
    record.status = "under_review";
    record.demotedByEvidence = {
      at: demotedAt,
      previousStatus: "confirmed",
      mismatches,
    };
    record.updatedAt = demotedAt;
    demotions.push({ id: record.id, mismatches });
  }

  if (demotions.length === 0) {
    return { decisions, demotions: [], verifiedCount };
  }
  return { decisions: nextDecisions, demotions, verifiedCount };
}

/**
 * 롤링 상태 병합 경로(updateMissionRollingStateFromHandoff, applyMissionDecisionReports)
 * 공용 진입점. 병합(mergeDecisionRecords/mergeRollingState) 직후, 마크다운 렌더
 * (buildMissionStateMarkdown) 직전에 호출한다.
 * - evidenceVerifyRoots 가 없거나 비면 no-op(fail-open — 결정 보고 라우트는 워크스페이스가
 *   없어 루트를 넘기지 않고, 루트 없는 스윕은 강등하지 않는다).
 * - 강등이 있으면 1행의 활동 로그(mission.decisions.evidence_stale, 시스템 액터)를 남기고
 *   강등이 반영된 새 decisions 배열을 돌려준다. 없으면 입력 배열 참조를 그대로 돌려준다.
 */
export async function applyMissionDecisionEvidenceStaleness(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    decisions: MissionRollingDecisionRecord[] | undefined;
    evidenceVerifyRoots: string[] | undefined;
  },
): Promise<MissionRollingDecisionRecord[] | undefined> {
  const roots = input.evidenceVerifyRoots;
  if (!roots || roots.length === 0 || !input.decisions || input.decisions.length === 0) {
    return input.decisions;
  }
  const sweep = await sweepStaleDecisionEvidence(input.decisions, roots);
  if (sweep.demotions.length === 0) return input.decisions;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "mission-evidence-staleness",
    action: "mission.decisions.evidence_stale",
    entityType: "mission",
    entityId: input.missionId,
    details: {
      demoted: sweep.demotions.map((demotion) => ({ id: demotion.id, mismatches: demotion.mismatches.length })),
      verifiedCount: sweep.verifiedCount,
    },
  });
  return sweep.decisions;
}
