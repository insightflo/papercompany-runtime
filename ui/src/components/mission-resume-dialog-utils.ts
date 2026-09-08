// ui/src/components/mission-resume-dialog-utils.ts
//
// [purpose] MissionResumeDialog 순수 헬퍼 — 멱등키 생성, 스냅샷 만료 판정, 적용 오류 분류.
//   상태 없음, DOM 없음.
import { ApiError } from "../api/client";
import type { ResumePreview } from "@paperclipai/shared/types/workflow-resume";

/** 본문 확정 시점에 정확히 한 번 호출된다. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** expiresAt이 없으면 만료 판정을 하지 않고, 있으면 기준 시각을 지났을 때만 만료다. */
export function isSnapshotExpired(preview: ResumePreview, now: number = Date.now()): boolean {
  if (!preview.expiresAt) return false;
  return new Date(preview.expiresAt).getTime() <= now;
}

export interface ApplyErrorView {
  message: string;
  uncertain: boolean;
}

/** API 오류(상태 코드 있음)는 확정 실패, 그 외(fetch 네트워크 오류)는 전달 여부 미확인으로 분류한다. */
export function describeApplyError(error: unknown): ApplyErrorView {
  if (error instanceof ApiError) {
    return { message: `재개 요청이 거절되었습니다 (HTTP ${error.status}): ${error.message}`, uncertain: false };
  }
  return {
    message: "네트워크 오류로 요청 전달 여부를 확인할 수 없습니다. 같은 요청을 다시 보낼 수 있습니다.",
    uncertain: true,
  };
}
