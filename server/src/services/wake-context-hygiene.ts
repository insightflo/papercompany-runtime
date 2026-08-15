import { parseObject } from "../adapters/utils.js";
import { buildStepInputManifest } from "./step-input-manifest.js";

// [wake envelope diet] 웨이크 컨텍스트 위생 — 저장/전송되는 contextSnapshot에서
//   아무도 전문(full text)으로 소비하지 않는 대형 페이로드를 조립 시점에 줄인다.
//   근거(2026-08-15 GAZ 실측): paperclipIssueRecentComments 21.3KB(브리프는 260c 잘라서만
//   렌더), paperclipMissionPlan 원시 키 6.2KB가 manifest 사본과 중복 저장.

/** 최근 이슈 코멘트 본문은 브리프가 ~520자까지만 렌더하므로 그 이상은 웨이크에 싣지 않는다. */
export const WAKE_RECENT_COMMENT_BODY_MAX_CHARS = 600;

export function capWakeRecentCommentBody(body: string | null | undefined): string | null {
  if (typeof body !== "string" || body.length === 0) return body ? body : null;
  if (body.length <= WAKE_RECENT_COMMENT_BODY_MAX_CHARS) return body;
  return `${body.slice(0, WAKE_RECENT_COMMENT_BODY_MAX_CHARS)}... [truncated]`;
}

function manifestCarriesMissionPlan(context: Record<string, unknown>): boolean {
  const manifest = parseObject(context.paperclipStepInputManifest);
  const inputs = parseObject(manifest.inputs);
  const missionPlan = parseObject(inputs.missionPlan);
  return missionPlan.available === true;
}

/**
 * manifest를 재조립하고, manifest가 missionPlan을 보존하면 원시 paperclipMissionPlan
 * 키를 웨이크 컨텍스트에서 제거한다(중복 저장/전송 제거). 이후 재조립은
 * buildStepInputManifest의 carry-forward가 이전 manifest에서 missionPlan을 이어받는다.
 */
export function refreshStepInputManifest(context: Record<string, unknown>, taskKey: string | null) {
  context.paperclipStepInputManifest = buildStepInputManifest({
    taskKey,
    context,
  });
  if (manifestCarriesMissionPlan(context)) {
    delete context.paperclipMissionPlan;
  }
}
