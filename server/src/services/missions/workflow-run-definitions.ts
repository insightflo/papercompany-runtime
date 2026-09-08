// server/src/services/missions/workflow-run-definitions.ts
//
// [목적] missionService.listWorkflowRuns 의 native run 나열 질의만 추출한 모듈(Task5a2e).
//   run 행과 현재 definition 이름만 LEFT JOIN 으로 읽고, 각 run 의 실행 그래프는
//   loadExecutionDefinition(스냅샷 우선, 검증/해시 대조, legacy 만 current fallback)으로
//   1회 로드해서 고정된 이름/step 을 되돌려준다. 쓰기 없음, 정규화 재적용 없음.
// [수정시 주의] snapshot run 의 표시 이름은 provenance.workflowName(캡처 시점)이며,
//   legacy raw-insert run 만 joined 현재 이름을 쓴다. corrupt/미인증 snapshot 은 여기서
//   422 로 fail-closed 된다(호출자가 삼키지 않음). missionService 를 import 하지 않는다.

import { and, desc, eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";

export interface MissionWorkflowRunDefinitionRow {
  run: typeof workflowRuns.$inferSelect;
  /** snapshot run 은 캡처된 이름, unmarked legacy run 은 현재 joined 이름(null 허용). */
  workflowName: string | null;
  /** 로더가 검증한 canonical steps(스냅샷 그대로 또는 legacy current fallback). */
  workflowSteps: WorkflowStep[];
}

export async function loadMissionWorkflowRunDefinitions(
  db: Db,
  companyId: string,
  missionId: string,
): Promise<MissionWorkflowRunDefinitionRow[]> {
  const rows = await db
    .select({
      run: workflowRuns,
      currentWorkflowName: workflowDefinitions.name,
    })
    .from(workflowRuns)
    .leftJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId)))
    .orderBy(desc(workflowRuns.createdAt));

  return await Promise.all(rows.map(async (row) => {
    const execution = await loadExecutionDefinition(db, row.run.id, { requireHistorical: false });
    return {
      run: row.run,
      workflowName: execution.source === "snapshot"
        ? execution.provenance?.workflowName ?? row.currentWorkflowName
        : row.currentWorkflowName,
      workflowSteps: execution.steps,
    };
  }));
}
