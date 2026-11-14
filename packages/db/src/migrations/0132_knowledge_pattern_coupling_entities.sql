-- [mistology 흡수 T1a 2026-11-14] company_knowledge_patterns 구조화 결함 결합 메타데이터.
--   카드가 다루는 소스 파일(files)/심볼(symbols)/결합 엔티티(coupled)/정규화 오류
--   서명(error_signatures) text[] 4종 추가. 소비는 T1c 검색 랭킹이 담당한다.
--   기존 행은 모두 빈 배열 기본값으로 둔다(데이터 백필 없음 — 신규 컬럼 default로 충분).
--   인덱스는 추가하지 않는다: 카디널리티 낮은 text[]이며 GIN 판단은 소비 패턴(T1c)이
--   확정된 뒤 별도 단계에서 한다.
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "files" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "symbols" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "coupled" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "error_signatures" text[] DEFAULT '{}'::text[] NOT NULL;
