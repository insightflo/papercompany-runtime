import { sql, type SQL } from "drizzle-orm";

/**
 * [oversight mission-dedup exemption] 같은 미션 중복 실행 방지(heartbeat.ts [B] 등록 경로,
 * [B3] 승격 경로)가 세는 "차단 실행" 후보에서 mission_owner_periodic_review(오너 정기 점검)
 * 실행은 제외한다.
 *
 * - 리뷰 과잉은 이미 30분 버킷 멱등 클레임(supervision.ts `mission-owner-periodic-review`)
 *   과 동일 wakeup coalesce 로 억제된다.
 * - 반대 방향(단계 실행 중 리뷰 억제)은 유지된다: 단계 실행은 여전히 차단 후보에 포함되므로,
 *   단계 실행이 in-flight 면 리뷰 wakeup 은 [B] 에 의해 지연된다.
 * - 마커는 context_snapshot.wakeReason 우선, 없으면 source. 둘 다 없는 실행은 보수적으로
 *   여전히 차단으로 센다.
 *
 * 2026-09-11 RCA: 26분간 살아 있던 정기 점검 실행이 같은 미션의 TTS 단계 승격을
 * 8m44s 지연시킨 사고로 도입(queue_promotion_blocked_by_mission_dedup 관측 치).
 */
export const missionDedupExemptOversightReviewClause: SQL = sql`coalesce(
  heartbeat_runs.context_snapshot ->> 'wakeReason',
  heartbeat_runs.context_snapshot ->> 'source',
  ''
) <> 'mission_owner_periodic_review'`;
