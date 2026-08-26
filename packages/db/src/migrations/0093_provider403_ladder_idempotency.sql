-- [provider 403 ladder] agent_wakeup_requests 라 사다리 rung idempotency 부분 유니크 인덱스.
--   스캐너 재실행/동시 실행 간 같은 (company, provider403-ladder:{issue}:{step}:{rung}) 키 중복 삽입을
--   DB 차원에서 차단한다. skipped 포함 전 상태 대상 — 거부(skipped)도 시도 1회로 소진 처리해
--   같은 키의 무한 재삽입 루프를 막는다(cap-override-wake / operator-decision-wake 선행 패턴 동일).
SELECT pg_advisory_xact_lock(930093001::bigint);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_provider403_ladder_idempotency_uq"
  ON "agent_wakeup_requests" ("company_id", "idempotency_key")
  WHERE "agent_wakeup_requests"."idempotency_key" like 'provider403-ladder:%';
