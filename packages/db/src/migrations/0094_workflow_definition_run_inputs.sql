-- [run inputs] workflow_definitions 실행 입력 선언 컬럼.
--   정의가 실행 시 보드에서 수집할 입력({key, label, required, placeholder}, 최대 5개)을 저장한다.
--   선언된 입력값은 run metadata로 전달되어 {$runMetadata.<key>} 템플릿으로 스텝에 주입된다.
--   기존 정의는 빈 배열 — 선언 없으면 즉시 실행 기존 동작 유지(회귀 없음).
ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "run_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;
