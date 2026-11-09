import { sql } from "drizzle-orm";
import { workflowStepRuns } from "@paperclipai/db";

/**
 * [predicate-unify 2026-11-09] workflow_step_runs "아직 활성" 의 단일 정의.
 * 4곳(issue-step-closeout · work-product-completion-gate · resume-scope-fence ·
 * issue-update-completion-guards)에 문자열 동일하게 복제되어 있던 술어를 한 곳으로 모은다.
 * 'canceled' 는 레거시 표기 — 종결 마감 시 두 철자를 모두 제외한다(행동 변화 없음, 추출만).
 */
export const ACTIVE_WORKFLOW_STEP_STATUS_CONDITION =
  sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;
