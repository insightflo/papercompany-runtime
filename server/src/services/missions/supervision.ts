// server/src/services/missions/supervision.ts
//
// [수정시 주의] supervision 팩토리 진입점. 본체는 supervision-main.ts(main executor)와
// supervision-active.ts(active mission owner)에 있다. 회귀 시 mission test + workflow-dag-engine test 필수.
import type { Db } from "@paperclipai/db";
import type { MissionServiceDeps } from "../missions.js";
import type { createOwnerActions } from "./owner-actions.js";
import { qualityService } from "../quality.js";
import { createMissionWorkSettlement } from "./mission-work-settlement.js";
import { selectTerminalWorkflowAuthoritySource } from "./terminal-mission-authority-source.js";
export { selectTerminalWorkflowAuthoritySource };

import { createRunActiveMissionOwnerSupervision } from "./supervision-active.js";
import { createRunMainExecutorSupervision } from "./supervision-main.js";

export function createSupervision({ db, deps, ownerActions }: {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
}) {
  // Phase 5: best-effort quality review item auto-creation for oversight findings (plan 8.1).
  const qSvc = qualityService(db);
  const settleResolvedOwnerActionsAndFindOpenWork = createMissionWorkSettlement(db);

  const runMainExecutorSupervision = createRunMainExecutorSupervision({
    db, deps, ownerActions, qSvc, settleResolvedOwnerActionsAndFindOpenWork,
  });

  const runActiveMissionOwnerSupervision = createRunActiveMissionOwnerSupervision({
    db, deps, ownerActions, runMainExecutorSupervision,
  });

  return {
    runMainExecutorSupervision,
    runActiveMissionOwnerSupervision,
  };
}
