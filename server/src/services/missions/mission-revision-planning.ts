import type { Db } from "@paperclipai/db";
import { buildMissionPlanningDescription, type MissionPlanningDescriptionInput } from "./mission-planning-description.js";
import { buildMissionRevisionContext } from "./mission-revision-context.js";

/** Used for both initial planning and bounded plan-submission revision.
 *  [Q5] 매핑 규칙 안내는 실제 계약과 일치해야 한다 — sourceStepId 는 원본 단계 재사용/재실행/수정에만
 *  필요하고 새 unmapped 단위(예: 새 수집 대상)는 허용된다. 예전 '새 unmapped 단계 금지' 문구는 새 수집
 *  계획과 모순되어 제거했다. */
export async function buildRevisionMissionPlanningDescription(db: Pick<Db, "select">,
  input: MissionPlanningDescriptionInput & { companyId: string }) {
  const revisionContext = await buildMissionRevisionContext(db, input);
  const description = buildMissionPlanningDescription({ ...input, sourceRevisionContext: revisionContext });
  return revisionContext?.sourceWorkflowRunId ? `${description}\n\nRevision identity contract: entries that reuse, rerun or modify an original execution step must include sourceStepId naming its exact source execution step. References must be unique and exist in the source run. New unmapped plan units (work absent from the original run, e.g. a new collection target) are allowed and carry no sourceStepId. Declare collection-target additions (add/clone units) with collectionScope: "oneShot" (collect once in this run only — the periodic definition and its collection watermark stay unchanged) or "permanentChange" (permanent periodic-definition change request — recorded as a separate-scope request, never silently applied to the periodic definition or its watermark). Do not rename a step to evade failed configuration checks. Change structured execution configuration for failed steps; prose-only changes do not qualify. The board chooses successful outputs to reuse after PLAN-QA; do not auto-start or self-seed.` : description;
}
